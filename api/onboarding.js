// /api/onboarding — ativação do acesso após o pagamento aprovado.
//
// POST { accessToken, company, document, responsible, loginEmail, whatsapp, extra }   (Content-Type: application/json)
//   → 200 { ok, mode: 'auto'|'manual'|'demo', product, productName, loginUrl, loginEmail, tempPassword?, accessToken,
//           manualDeadline?, supportWhatsappUrl, notes }
//   → 200 { ok, alreadyDone: true, ... }  este pagamento já foi ativado (por qualquer instância, token ou e-mail):
//           devolve o resultado salvo (nunca a senha) e não provisiona de novo
//   → 400 { error: 'validation', fields } | 400 invalid_json | 413 | 415 unsupported_media_type
//   → 401 { error: 'invalid_token'|'expired_token' }
//   → 402 { error: 'payment_not_active' }  pagamento estornado/contestado/cancelado (reconsultado no Mercado Pago)
//   → 409 { error: 'in_progress' }         outra requisição está ativando este mesmo pagamento agora
//   → 503 { error: 'payment_check_failed' } Mercado Pago fora do ar (não dá para confirmar o pagamento)
// GET ?token=… → 200 dados públicos (para /acesso) | 401 | 402 payment_not_active (revogado)
//
// Regras:
// - MODO DEMO (sem MP_ACCESS_TOKEN): NUNCA chama os provisionadores reais, mesmo com credenciais configuradas.
//   Responde mode "demo" com o loginUrl do produto e a nota "Demonstração: nenhuma conta foi criada".
// - PRODUÇÃO: reconsulta o pagamento no MP e só ativa se status === 'approved' sem estorno; trava por paymentId no
//   armazenamento durável (lib/store.js, chave aqta:onboarding:<paymentId>): o 1º grava "em andamento" e depois o
//   resultado (sem senha). Sem armazenamento durável configurado, o provisionamento automático fica DESLIGADO
//   (tudo vira manual): sem trava entre instâncias, um mesmo pagamento poderia criar várias contas.
// - O provisionamento automático nunca derruba a venda: qualquer erro vira modo "manual" e a equipe é avisada.
import { send, allow, readJson, isDemo } from '../lib/http.js';
import { getPlan } from '../lib/catalog.js';
import { signToken, verifyToken } from '../lib/token.js';
import { notifyTeam } from '../lib/notify.js';
import { provision as provisionObtra, obtraLoginUrl } from '../lib/provision/obtra.js';
import { provision as provisionEmptra, emptraLoginUrl, normalizeCategories } from '../lib/provision/emptra.js';
import { setIfAbsent, get as storeGet, set as storeSet, del as storeDel, storeMode, hasDurableStore, KEYS } from '../lib/store.js';
import { resolvePayment, isPaymentActive } from './payment-status.js';
import { isValidEmail } from './checkout.js';

const PROVISIONERS = { obtra: provisionObtra, emptra: provisionEmptra };
const LOGIN_URLS = { obtra: obtraLoginUrl, emptra: emptraLoginUrl };
const ONBOARDED_TTL = 30 * 86400; // a página /acesso continua abrindo por 30 dias
const MANUAL_DEADLINE = 'até 1 dia útil';
const MAX_BODY_CHARS = 8192;
const LOCK_TTL = 10 * 60;          // "em andamento" expira sozinho se a função morrer no meio
const RESULT_TTL = 400 * 86400;    // resultado guardado por ~13 meses
const DEMO_NOTE = 'Demonstração: nenhuma conta foi criada.';
const UFS = new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '));

// Idempotência "quente" (mesma instância): duplo clique / recarga. A garantia entre instâncias vem do
// armazenamento durável (aqta:onboarding:<paymentId>). Guarda só dados públicos — nunca a senha.
const done = new Map();      // paymentId → { publicResult, accessToken }
const inflight = new Map();  // paymentId → Promise

// ---------------------------------------------------------------- validação (mesmas regras do checkout)

const onlyDigits = (v) => String(v ?? '').replace(/\D+/g, '');
const cleanText = (v, max = 200) =>
  String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function isValidCpf(v) {
  const d = onlyDigits(v);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    if (((sum * 10) % 11) % 10 !== Number(d[len])) return false;
  }
  return true;
}

function isValidCnpj(v) {
  const d = onlyDigits(v);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * w[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

function isValidWhatsapp(v) {
  let d = onlyDigits(v);
  if (d.length < 10 || d.length > 13) return false;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return false;
  if (!/^[1-9][1-9]$/.test(d.slice(0, 2))) return false;
  const n = d.slice(2);
  if (n.length === 9 && n[0] !== '9') return false;
  if (n.length === 8 && !/^[2-9]/.test(n)) return false;
  return true;
}

const isValidName = (s) => s.length >= 3 && s.length <= 120 && /\p{L}/u.test(s);

/** Valida e normaliza a entrada. Chaves de erro de `extra` usam o nome que o cliente enviou (ex.: extra.perfil). */
export function validateOnboarding(input, product) {
  const src = input && typeof input === 'object' ? input : {};
  const rawExtra = src.extra && typeof src.extra === 'object' && !Array.isArray(src.extra) ? src.extra : {};
  const data = {
    company: cleanText(src.company, 121),
    document: onlyDigits(src.document).slice(0, 20),
    responsible: cleanText(src.responsible, 121),
    loginEmail: String(src.loginEmail ?? '').trim().toLowerCase().slice(0, 255),
    whatsapp: onlyDigits(src.whatsapp).slice(0, 20),
  };
  const fields = {};
  if (data.company.length < 2) fields.company = 'Informe o nome da empresa.';
  else if (data.company.length > 120) fields.company = 'Máximo de 120 caracteres.';
  if (!data.document) fields.document = 'Informe o CPF ou CNPJ.';
  else if (!(isValidCpf(data.document) || isValidCnpj(data.document))) {
    fields.document = data.document.length === 14 ? 'CNPJ inválido.' : data.document.length === 11 ? 'CPF inválido.' : 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).';
  }
  if (!isValidName(data.responsible)) fields.responsible = 'Informe o nome do responsável (mínimo 3 letras).';
  if (!isValidEmail(data.loginEmail)) fields.loginEmail = 'Informe um e-mail válido.';
  if (!isValidWhatsapp(data.whatsapp)) fields.whatsapp = 'Informe um WhatsApp com DDD (ex.: (11) 91234-5678).';

  // extra: só chaves conhecidas, só texto curto.
  const cityKey = 'cidade' in rawExtra ? 'cidade' : 'city' in rawExtra ? 'city' : 'cidade';
  const ufKey = 'uf' in rawExtra ? 'uf' : 'state' in rawExtra ? 'state' : 'uf';
  const extra = {};
  const city = cleanText(rawExtra[cityKey], 81);
  const uf = cleanText(rawExtra[ufKey], 3).toUpperCase();
  if (city.length < 2) fields[`extra.${cityKey}`] = 'Informe a cidade.';
  else if (city.length > 80) fields[`extra.${cityKey}`] = 'Máximo de 80 caracteres.';
  else extra.cidade = city;
  if (uf) {
    if (UFS.has(uf)) extra.uf = uf;
    else fields[`extra.${ufKey}`] = 'UF inválida.';
  }

  if (product === 'obtra') {
    const obras = cleanText(rawExtra.obrasAtivas ?? rawExtra.activeProjects ?? rawExtra.obras, 21);
    if (obras) extra.obrasAtivas = obras.slice(0, 20);
  }
  if (product === 'emptra') {
    const profKey = 'perfil' in rawExtra ? 'perfil' : 'profile' in rawExtra ? 'profile' : 'perfil';
    const profile = cleanText(rawExtra[profKey], 20).toLowerCase();
    if (profile !== 'comprador' && profile !== 'fornecedor') fields[`extra.${profKey}`] = 'Escolha um perfil: comprador ou fornecedor.';
    else extra.profile = profile;
    if (Array.isArray(rawExtra.categories) && extra.profile === 'fornecedor') {
      // Só categorias do catálogo do Emptra (slug ou nome); grava o nome oficial, que é o que o Emptra pesquisa.
      const cats = normalizeCategories(rawExtra.categories.slice(0, 40).map((c) => cleanText(c, 80)));
      if (cats.length) extra.categories = cats;
    }
  }
  return { ok: Object.keys(fields).length === 0, data, extra, fields };
}

// ---------------------------------------------------------------- utilidades

/** Distingue token expirado (só para a mensagem; a confiança vem exclusivamente de verifyToken). */
function tokenProblem(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8'));
    if (typeof p?.exp === 'number' && p.exp <= Math.floor(Date.now() / 1000)) return 'expired_token';
  } catch { /* malformado */ }
  return 'invalid_token';
}

function readAccessToken(token) {
  let payload = null;
  try { payload = verifyToken(token); } catch (err) {
    console.error('[onboarding] verifyToken:', err.message);
    return { error: 'server_misconfigured', status: 500 };
  }
  if (!payload || payload.t !== 'access' || !getPlan(payload.product, payload.plan || 'basico')) {
    return { error: payload ? 'invalid_token' : tokenProblem(token), status: 401 };
  }
  return { payload };
}

function supportWhatsappUrl(text) {
  const n = onlyDigits(process.env.AQTA_WHATSAPP);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}

function supportText(productName, company, mode) {
  return mode === 'manual'
    ? `Olá! Acabei de contratar o ${productName}${company ? ` para a empresa ${company}` : ''} e aguardo a liberação do acesso.`
    : `Olá! Preciso de ajuda com o meu acesso ao ${productName}${company ? ` (empresa ${company})` : ''}.`;
}

/** Dados públicos (sem senha) a partir de um token de acesso. */
function publicView(payload) {
  const { product } = getPlan(payload.product, payload.plan || 'basico');
  const ob = payload.onboarding || {};
  const company = ob.company || payload.customer?.company || '';
  const mode = payload.onboarded ? ob.mode || 'manual' : null;
  return {
    ok: true,
    onboarded: Boolean(payload.onboarded),
    product: product.id,
    productName: product.name,
    plan: payload.plan || 'basico',
    company,
    responsible: ob.responsible || payload.customer?.name || '',
    loginEmail: ob.loginEmail || payload.customer?.email || '',
    loginUrl: ob.loginUrl || LOGIN_URLS[product.id](),
    mode,
    demo: mode === 'demo',
    profile: ob.profile || null,
    manualDeadline: mode === 'manual' ? MANUAL_DEADLINE : null,
    supportWhatsappUrl: supportWhatsappUrl(supportText(product.name, company, mode)),
    expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
  };
}

function stripMeta(payload) {
  const { exp, iat, ...rest } = payload;
  return rest;
}

// ---------------------------------------------------------------- estado (armazenamento)

/** Revogação e onboarding salvos para o pagamento. Nunca lança (armazenamento fora ⇒ nada conhecido). */
async function records(key) {
  const out = { revoked: null, onboarding: null };
  if (!key || storeMode() === 'none') return out;
  try {
    const [revoked, onboarding] = await Promise.all([storeGet(KEYS.revoked(key)), storeGet(KEYS.onboarding(key))]);
    out.revoked = revoked;
    out.onboarding = onboarding && typeof onboarding === 'object' ? onboarding : null;
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'onboarding: armazenamento indisponível na leitura', error: String(err?.message || err) }));
  }
  return out;
}

function notActive(product, company) {
  const productName = getPlan(product, 'basico')?.product.name || 'produto';
  return {
    status: 402,
    body: {
      error: 'payment_not_active',
      message: 'Este pagamento foi estornado, contestado ou cancelado, então o acesso não pode ser ativado. Se acha que é um engano, fale com o suporte.',
      supportWhatsappUrl: supportWhatsappUrl(`Olá! Meu acesso ao ${productName}${company ? ` (empresa ${company})` : ''} aparece como pagamento não ativo.`),
    },
  };
}

const alreadyDoneFrom = (saved) => ({ status: 200, body: { ...saved.publicResult, alreadyDone: true, accessToken: saved.accessToken } });

// ---------------------------------------------------------------- handlers

async function handleGet(req, res) {
  const token = String(req.query?.token ?? '');
  if (!token) return send(res, 401, { error: 'invalid_token' });
  const r = readAccessToken(token);
  if (r.error) return send(res, r.status, { error: r.error });
  const payload = r.payload;
  const rec = await records(String(payload.paymentId ?? ''));
  if (rec.revoked) {
    const out = notActive(payload.product, payload.onboarding?.company || payload.customer?.company);
    return send(res, out.status, out.body);
  }
  if (!payload.onboarded && rec.onboarding?.state === 'done' && rec.onboarding.publicResult) {
    // Token de ativação antigo, mas o pagamento já foi ativado (talvez em outra instância/aba): mostra o resultado.
    return send(res, 200, { ...rec.onboarding.publicResult, accessToken: rec.onboarding.accessToken });
  }
  return send(res, 200, publicView(payload));
}

const ERROR_NOTES = {
  email_exists: 'Este e-mail já tem cadastro no sistema: a equipe vai vincular o plano ao acesso existente.',
  company_exists: 'Este CNPJ já tem empresa cadastrada no sistema: a equipe vai vincular seu acesso à empresa existente.',
  validation: 'O sistema recusou algum dado informado (por exemplo, o e-mail); a equipe vai conferir e liberar manualmente.',
};

/**
 * @param {{ allowAuto: boolean, disabledReason?: string|null }} opts
 *   allowAuto=false ⇒ não chama os provisionadores (modo manual). No demo eles nunca são chamados.
 */
async function runOnboarding(payload, data, extra, { allowAuto, disabledReason = null }) {
  const { product, plan } = getPlan(payload.product, payload.plan || 'basico');
  const input = { product: product.id, plan: plan.id, ...data, extra, paymentId: payload.paymentId };
  const demo = isDemo();

  let result;
  let provisionError = null;
  if (demo) {
    // REV-1: nada real é criado no demo, mesmo com OBTRA_* / EMPTRA_* configurados.
    result = { mode: 'demo', loginUrl: LOGIN_URLS[product.id](), loginEmail: data.loginEmail, profile: extra.profile, notes: DEMO_NOTE };
  } else if (!allowAuto) {
    result = {
      mode: 'manual',
      loginUrl: LOGIN_URLS[product.id](),
      loginEmail: data.loginEmail,
      profile: extra.profile,
      notes: 'A equipe Aqta vai criar o seu acesso e avisar você.',
    };
  } else {
    try {
      result = await PROVISIONERS[product.id](input);
    } catch (err) {
      provisionError = String(err?.message || err).slice(0, 500);
      console.error(JSON.stringify({ level: 'error', msg: 'onboarding: provisionamento automático falhou', product: product.id, paymentId: payload.paymentId, code: err?.code, error: provisionError }));
      result = {
        mode: 'manual',
        loginUrl: LOGIN_URLS[product.id](),
        loginEmail: data.loginEmail,
        profile: extra.profile,
        notes: ERROR_NOTES[err?.code] || 'Não foi possível criar o acesso automaticamente; a equipe vai liberar manualmente.',
      };
    }
  }

  const mode = demo ? 'demo' : result.mode === 'auto' ? 'auto' : 'manual';
  const onboarding = {
    mode,
    loginUrl: result.loginUrl || LOGIN_URLS[product.id](),
    loginEmail: result.loginEmail || data.loginEmail,
    company: data.company,
    responsible: data.responsible,
    ...(extra.profile ? { profile: extra.profile } : {}),
    at: new Date().toISOString(),
  };

  await notifyTeam({
    event: 'onboarding.completed',
    product: product.id,
    productName: product.name,
    plan: plan.id,
    paymentId: payload.paymentId,
    ref: payload.ref,
    mode,
    demo,
    manualActionRequired: mode === 'manual',
    company: data.company,
    document: data.document,
    responsible: data.responsible,
    loginEmail: onboarding.loginEmail,
    whatsapp: data.whatsapp,
    extra,
    customer: payload.customer,
    loginUrl: onboarding.loginUrl,
    notes: result.notes,
    externalIds: result.externalIds,
    ...(provisionError ? { provisionError } : {}),
    ...(disabledReason ? { autoProvisionDisabled: disabledReason } : {}),
  });

  const accessToken = signToken({ ...stripMeta(payload), onboarded: true, onboarding }, ONBOARDED_TTL);
  const view = publicView({ ...payload, onboarded: true, onboarding, exp: Math.floor(Date.now() / 1000) + ONBOARDED_TTL });
  return {
    publicResult: { ...view, notes: result.notes || null },
    accessToken,
    tempPassword: mode === 'auto' ? result.tempPassword : undefined,
  };
}

/** Todo o fluxo de ativação de um pagamento (depois da validação). Devolve { status, body }. */
async function activate(key, payload, v) {
  // 1) Produção: a verdade vem do Mercado Pago (o accessToken vale 7 dias; pode ter havido estorno/chargeback).
  if (!isDemo()) {
    const pr = await resolvePayment(key);
    if (!pr.ok && pr.code === 502) {
      return { status: 503, body: { error: 'payment_check_failed', message: 'Não conseguimos confirmar o pagamento agora. Tente novamente em alguns minutos.' } };
    }
    if (!pr.ok || !isPaymentActive(pr.payment) || pr.payment.product !== payload.product) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'onboarding recusado: pagamento não ativo', paymentId: key, status: pr.payment?.status, error: pr.error }));
      return notActive(payload.product, v.data.company);
    }
  }

  // 2) Trava por pagamento (vale entre instâncias quando o armazenamento é durável).
  const mode = storeMode();
  let locked = false;
  let disabledReason = null;
  if (mode === 'none') {
    disabledReason = 'store_not_configured';
    console.error(JSON.stringify({ level: 'error', msg: '!!! onboarding: produção SEM armazenamento durável (KV_REST_API_URL/KV_REST_API_TOKEN): provisionamento automático DESLIGADO, ativação vai para a equipe (manual).', paymentId: key }));
  } else {
    try {
      locked = await setIfAbsent(KEYS.onboarding(key), { state: 'in_progress', at: new Date().toISOString() }, LOCK_TTL);
      if (!locked) {
        const cur = await storeGet(KEYS.onboarding(key));
        if (cur?.state === 'done' && cur.publicResult) return alreadyDoneFrom(cur);
        return { status: 409, body: { error: 'in_progress', message: 'A ativação deste pagamento já está em andamento. Aguarde alguns segundos e recarregue a página.' } };
      }
    } catch (err) {
      disabledReason = 'store_unavailable';
      console.error(JSON.stringify({ level: 'error', msg: 'onboarding: armazenamento indisponível; provisionamento automático desligado nesta ativação', paymentId: key, error: String(err?.message || err) }));
    }
  }
  const allowAuto = !isDemo() && locked && hasDurableStore();

  // 3) Provisiona (ou não) e guarda o resultado — sem a senha.
  let out;
  try {
    out = await runOnboarding(payload, v.data, v.extra, { allowAuto, disabledReason });
  } catch (err) {
    if (locked) await storeDel(KEYS.onboarding(key)).catch(() => {});
    throw err;
  }
  if (locked) {
    const saved = { state: 'done', publicResult: out.publicResult, accessToken: out.accessToken, at: new Date().toISOString() };
    let ok = false;
    for (let i = 0; i < 2 && !ok; i++) {
      try { await storeSet(KEYS.onboarding(key), saved, RESULT_TTL); ok = true; } catch (err) {
        console.error(JSON.stringify({ level: 'error', msg: '!!! onboarding: não foi possível gravar o resultado (a trava expira em 10 min)', paymentId: key, error: String(err?.message || err) }));
      }
    }
  }
  return {
    status: 200,
    body: { ...out.publicResult, ...(out.tempPassword ? { tempPassword: out.tempPassword } : {}), accessToken: out.accessToken },
    saved: { publicResult: out.publicResult, accessToken: out.accessToken },
  };
}

async function handlePost(req, res) {
  const raw = readJson(req, res, { maxChars: MAX_BODY_CHARS }); // 415 / 413 / 400 invalid_json
  if (!raw) return;

  const r = readAccessToken(String(raw.accessToken ?? ''));
  if (r.error) return send(res, r.status, { error: r.error, message: r.error === 'expired_token' ? 'O link de ativação expirou.' : 'Link de ativação inválido.' });
  const payload = r.payload;
  const key = String(payload.paymentId ?? '');
  if (!key) return send(res, 401, { error: 'invalid_token', message: 'Link de ativação inválido.' });

  const rec = await records(key);
  if (rec.revoked) {
    const out = notActive(payload.product, payload.onboarding?.company || payload.customer?.company);
    return send(res, out.status, out.body);
  }

  // Já concluído: token "onboarded", resultado salvo (qualquer instância) ou cache quente desta instância.
  if (payload.onboarded) {
    return send(res, 200, { ...publicView(payload), alreadyDone: true, accessToken: raw.accessToken });
  }
  if (rec.onboarding?.state === 'done' && rec.onboarding.publicResult) {
    const out = alreadyDoneFrom(rec.onboarding);
    return send(res, out.status, out.body);
  }
  if (done.has(key)) {
    const out = alreadyDoneFrom(done.get(key));
    return send(res, out.status, out.body);
  }

  const v = validateOnboarding(raw, payload.product);
  if (!v.ok) return send(res, 400, { error: 'validation', fields: v.fields });

  if (inflight.has(key)) {
    try {
      const prev = await inflight.get(key);
      if (prev.saved) {
        const out = alreadyDoneFrom(prev.saved);
        return send(res, out.status, out.body);
      }
      return send(res, prev.status, prev.body);
    } catch { /* cai para nova tentativa */ }
  }

  const job = activate(key, payload, v);
  inflight.set(key, job);
  let out;
  try {
    out = await job;
  } catch (err) {
    console.error('[onboarding] erro inesperado:', err);
    return send(res, 500, { error: 'internal', message: 'Não conseguimos ativar agora. Tente novamente em instantes ou fale com o suporte.' });
  } finally {
    inflight.delete(key);
  }
  if (out.saved) {
    done.set(key, out.saved);
    if (done.size > 500) done.delete(done.keys().next().value);
  }
  return send(res, out.status, out.body);
}

export default async function handler(req, res) {
  if (!allow(req, res, ['GET', 'POST'])) return;
  if (req.method === 'GET') return handleGet(req, res);
  return handlePost(req, res);
}
