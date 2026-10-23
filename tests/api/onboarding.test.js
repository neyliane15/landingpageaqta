import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, patchEnv, importProject } from '../helpers/server.js';
import { startCaptureServer } from '../helpers/capture.js';
import { startObtraMock, startEmptraMock } from '../helpers/mock-products.js';
import { startUpstashMock } from '../helpers/mock-upstash.js';
import { installFetchMock, mpPayment } from '../helpers/fetch-mock.js';
import { invoke } from '../helpers/invoke.js';
import { approvedAccess, demoPurchase, onboardingInput, decodeToken, signTokenAt, CPF_DIGITS, CNPJ_DIGITS } from '../helpers/fixtures.js';

const DEMO_SECRET = 'aqta-demo-secret-nao-use-em-producao';

let srv;
let cap;
before(async () => {
  cap = await startCaptureServer();
  srv = await startServer({ env: { AQTA_NOTIFY_WEBHOOK: cap.url, AQTA_WHATSAPP: '5521988887777' } });
});
after(async () => { await srv.close(); await cap.close(); });
beforeEach(() => cap.clear());

const post = (body) => srv.request('/api/onboarding', { method: 'POST', body });
const get = (token) => srv.request(`/api/onboarding?token=${encodeURIComponent(token)}`);

describe('token', () => {
  test('GET com accessToken válido (antes do onboarding) ⇒ dados públicos, onboarded=false', async () => {
    const { accessToken } = await approvedAccess(srv, 'obtra');
    const r = await get(accessToken);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.onboarded, false);
    assert.equal(r.body.product, 'obtra');
    assert.equal(r.body.productName, 'Obtra');
    assert.equal(r.body.mode, null);
    assert.equal(r.body.loginUrl, 'https://obtra.vercel.app/entrar');
    assert.equal(r.body.loginEmail, 'maria.teste@example.com');
    assert.match(r.body.supportWhatsappUrl, /^https:\/\/wa\.me\/5521988887777\?text=/);
  });

  test('GET Emptra ⇒ loginUrl do Emptra terminando em /entrar', async () => {
    const { accessToken } = await approvedAccess(srv, 'emptra');
    const r = await get(accessToken);
    assert.equal(r.body.loginUrl, 'https://emptra.srv1848886.hstgr.cloud/entrar');
  });

  test('GET sem token / inválido / adulterado ⇒ 401 invalid_token', async () => {
    const { accessToken } = await approvedAccess(srv, 'obtra');
    const p = decodeToken(accessToken); p.product = 'emptra';
    const forged = `${Buffer.from(JSON.stringify(p)).toString('base64url')}.${accessToken.split('.')[1]}`;
    for (const t of ['', 'abc', 'a.b', forged]) {
      const r = await get(t);
      assert.equal(r.status, 401, t.slice(0, 10));
      assert.equal(r.body.error, 'invalid_token');
    }
  });

  test('token expirado ⇒ 401 expired_token (GET e POST com mensagem)', async () => {
    const expired = await signTokenAt(-8 * 86400, { t: 'access', paymentId: 'x1', product: 'obtra', plan: 'basico', customer: {} }, 7 * 86400);
    const g = await get(expired);
    assert.equal(g.status, 401);
    assert.equal(g.body.error, 'expired_token');
    const p = await post(onboardingInput(expired));
    assert.equal(p.status, 401);
    assert.equal(p.body.error, 'expired_token');
    assert.match(p.body.message, /expirou/);
  });

  test('token de outro tipo (checkout demo, pagamento demo) ⇒ 401 invalid_token', async () => {
    const pur = await demoPurchase(srv, 'obtra', 'approved');
    const { signToken } = await importProject('lib/token.js');
    const unknownProduct = signToken({ t: 'access', paymentId: 'p', product: 'xpto', plan: 'basico' }, 600);
    for (const t of [pur.checkoutToken, pur.paymentId.slice(5), pur.paymentId, unknownProduct]) {
      const r = await post(onboardingInput(t));
      assert.equal(r.status, 401, t.slice(0, 15));
      assert.equal(r.body.error, 'invalid_token');
    }
  });
});

describe('validação', () => {
  let token;
  let tokenEmptra;
  before(async () => {
    token = (await approvedAccess(srv, 'obtra')).accessToken;
    tokenEmptra = (await approvedAccess(srv, 'emptra')).accessToken;
  });
  const cases = [
    ['company', { company: '' }], ['company', { company: 'X' }], ['company', { company: 'E'.repeat(121) }],
    ['document', { document: '' }], ['document', { document: '12345678900' }], ['document', { document: '11222333000180' }], ['document', { document: '123' }],
    ['responsible', { responsible: 'Al' }], ['responsible', { responsible: '123456' }],
    ['loginEmail', { loginEmail: 'x' }], ['loginEmail', { loginEmail: 'a@b' }], ['loginEmail', { loginEmail: 'joao.@empresa.com.br' }], ['loginEmail', { loginEmail: 'ana#1@empresa.com' }],
    ['whatsapp', { whatsapp: '123' }], ['whatsapp', { whatsapp: '21887654321' }],
    ['extra.cidade', { extra: { obrasAtivas: '1-3', uf: 'RJ' } }],
    ['extra.uf', { extra: { cidade: 'Niterói', uf: 'XX' } }],
  ];
  for (const [field, patch] of cases) {
    test(`${field} inválido ⇒ 400 fields["${field}"]`, async () => {
      const r = await post(onboardingInput(token, 'obtra', patch));
      assert.equal(r.status, 400, r.text);
      assert.equal(r.body.error, 'validation');
      assert.ok(r.body.fields[field], r.text);
    });
  }

  test('Emptra sem perfil / perfil inválido ⇒ 400 extra.perfil', async () => {
    for (const extra of [{ cidade: 'Niterói', uf: 'RJ' }, { perfil: 'admin', cidade: 'Niterói', uf: 'RJ' }]) {
      const r = await post(onboardingInput(tokenEmptra, 'emptra', { extra }));
      assert.equal(r.status, 400);
      assert.ok(r.body.fields['extra.perfil'], r.text);
    }
  });

  test('extra como array/string não derruba ⇒ 400 extra.cidade', async () => {
    for (const extra of [[1, 2], 'x', null]) {
      const r = await post(onboardingInput(token, 'obtra', { extra }));
      assert.equal(r.status, 400);
      assert.ok(r.body.fields['extra.cidade']);
    }
  });

  test('corpo grande ⇒ 413; PUT ⇒ 405', async () => {
    const r = await post(onboardingInput(token, 'obtra', { junk: 'x'.repeat(9000) }));
    assert.equal(r.status, 413);
    const m = await srv.request('/api/onboarding', { method: 'PUT', body: {} });
    assert.equal(m.status, 405);
  });
});

// ======================================================================== MODO DEMO
// No demo (sem MP_ACCESS_TOKEN) NADA real é criado, mesmo com credenciais de provisionamento configuradas (REV-1).

describe('modo demo — nunca provisiona', () => {
  test('Obtra ⇒ 200 mode "demo", nota de demonstração, sem senha, token onboarded, equipe notificada', async () => {
    const { accessToken } = await approvedAccess(srv, 'obtra');
    const input = onboardingInput(accessToken, 'obtra');
    const r = await post(input);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.mode, 'demo');
    assert.equal(r.body.demo, true);
    assert.match(r.body.notes, /Demonstração: nenhuma conta foi criada/);
    assert.equal(r.body.product, 'obtra');
    assert.equal(r.body.loginUrl, 'https://obtra.vercel.app/entrar');
    assert.equal(r.body.loginEmail, input.loginEmail);
    assert.equal(r.body.manualDeadline, null);
    assert.equal(r.body.tempPassword, undefined);
    assert.equal(r.body.company, 'Construtora Teste Ltda');
    const t = decodeToken(r.body.accessToken);
    assert.equal(t.t, 'access');
    assert.equal(t.onboarded, true);
    assert.equal(t.onboarding.mode, 'demo');
    assert.equal(t.exp - t.iat, 30 * 86400);
    const ev = (await cap.waitFor((b) => b.event === 'onboarding.completed')).body;
    assert.equal(ev.mode, 'demo');
    assert.equal(ev.demo, true);
    assert.equal(ev.manualActionRequired, false);
    assert.equal(ev.document, input.document);
    assert.deepEqual(ev.extra, { cidade: 'Niterói', uf: 'RJ', obrasAtivas: '4-10' });
    assert.match(ev.text, /DEMONSTRAÇÃO/);

    const g = await get(r.body.accessToken);
    assert.equal(g.status, 200);
    assert.equal(g.body.onboarded, true);
    assert.equal(g.body.mode, 'demo');
    assert.equal(g.body.loginEmail, input.loginEmail);
  });

  test('Emptra (fornecedor via chave "profile") ⇒ mode "demo" com profile e loginUrl do Emptra', async () => {
    const { accessToken } = await approvedAccess(srv, 'emptra');
    const r = await post(onboardingInput(accessToken, 'emptra', { extra: { profile: 'Fornecedor', city: 'Niterói/RJ' } }));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.mode, 'demo');
    assert.equal(r.body.profile, 'fornecedor');
    assert.equal(r.body.loginUrl, 'https://emptra.srv1848886.hstgr.cloud/entrar');
  });

  test('OBTRA_APP_URL / EMPTRA_APP_URL mudam o loginUrl (sempre /entrar)', async () => {
    const restore = patchEnv({ OBTRA_APP_URL: 'https://app.obtra.com.br/', EMPTRA_APP_URL: 'https://app.emptra.com.br' });
    try {
      const a = await approvedAccess(srv, 'obtra');
      assert.equal((await post(onboardingInput(a.accessToken))).body.loginUrl, 'https://app.obtra.com.br/entrar');
      const b = await approvedAccess(srv, 'emptra');
      assert.equal((await post(onboardingInput(b.accessToken, 'emptra'))).body.loginUrl, 'https://app.emptra.com.br/entrar');
    } finally { restore(); }
  });

  test('com credenciais do Obtra e do Emptra configuradas, o demo não faz NENHUMA chamada aos produtos', async () => {
    const obtra = await startObtraMock();
    const emptra = await startEmptraMock();
    const restore = patchEnv({
      OBTRA_SUPABASE_URL: obtra.url, OBTRA_SUPABASE_SERVICE_KEY: obtra.serviceKey,
      EMPTRA_API_URL: emptra.url, EMPTRA_ADMIN_EMAIL: emptra.adminEmail, EMPTRA_ADMIN_PASSWORD: emptra.adminPassword,
    });
    try {
      const a = await post(onboardingInput((await approvedAccess(srv, 'obtra')).accessToken, 'obtra'));
      assert.equal(a.body.mode, 'demo', a.text);
      const b = await post(onboardingInput((await approvedAccess(srv, 'emptra')).accessToken, 'emptra'));
      assert.equal(b.body.mode, 'demo', b.text);
      const forged = (() => {
        const now = Math.floor(Date.now() / 1000);
        const body = Buffer.from(JSON.stringify({ t: 'access', paymentId: 'forjado', product: 'emptra', plan: 'basico', customer: {}, iat: now, exp: now + 600 })).toString('base64url');
        return `${body}.${crypto.createHmac('sha256', DEMO_SECRET).update(body).digest('base64url')}`;
      })();
      const c = await post(onboardingInput(forged, 'emptra'));
      assert.equal(c.body.mode, 'demo', c.text);
      assert.equal(obtra.state.calls.length, 0, 'o demo chamou o Supabase do Obtra');
      assert.equal(emptra.state.calls.length, 0, 'o demo chamou a API do Emptra');
      assert.equal(a.body.tempPassword, undefined);
    } finally { restore(); await obtra.close(); await emptra.close(); }
  });
});

describe('idempotência (demo, armazenamento em memória)', () => {
  test('segundo POST com o mesmo token ⇒ alreadyDone com o mesmo accessToken (sem novo provisionamento)', async () => {
    const { accessToken } = await approvedAccess(srv, 'obtra');
    const first = await post(onboardingInput(accessToken));
    assert.equal(first.status, 200);
    // O aviso da equipe sai em segundo plano (não segura a resposta) e outros testes podem notificar ao mesmo
    // tempo: conta só os avisos DESTE pagamento.
    const mine = () => cap.events('onboarding.completed').filter((e) => e.loginEmail === first.body.loginEmail && e.ref === firstRef());
    let firstRef = () => undefined;
    for (let i = 0; i < 40 && cap.events('onboarding.completed').filter((e) => e.loginEmail === first.body.loginEmail).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const ev = cap.events('onboarding.completed').find((e) => e.loginEmail === first.body.loginEmail);
    assert.ok(ev, 'o 1º POST notifica a equipe');
    firstRef = () => ev.ref;
    assert.equal(mine().length, 1);
    const second = await post(onboardingInput(accessToken, 'obtra', { loginEmail: 'outro@example.com' }));
    assert.equal(second.status, 200);
    assert.equal(second.body.alreadyDone, true);
    assert.equal(second.body.accessToken, first.body.accessToken);
    assert.equal(second.body.loginEmail, first.body.loginEmail, 'não troca o e-mail já ativado');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(mine().length, 1, 'não notifica de novo');
  });

  test('POST com o token já "onboarded" ⇒ alreadyDone', async () => {
    const { accessToken } = await approvedAccess(srv, 'obtra');
    const first = await post(onboardingInput(accessToken));
    const again = await post({ accessToken: first.body.accessToken });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyDone, true);
    assert.equal(again.body.mode, 'demo');
  });
});

describe('formato da requisição (REV-10)', () => {
  test('POST sem Content-Type: application/json ⇒ 415 (CSRF por text/plain); JSON inválido ⇒ 400 invalid_json', async () => {
    const { accessToken } = await approvedAccess(srv, 'obtra');
    const json = JSON.stringify(onboardingInput(accessToken));
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const r = await srv.request('/api/onboarding', { method: 'POST', body: json, headers: { 'Content-Type': ct } });
      assert.equal(r.status, 415, ct);
      assert.equal(r.body.error, 'unsupported_media_type');
    }
    const bad = await srv.request('/api/onboarding', { method: 'POST', body: '{"accessToken":', headers: { 'Content-Type': 'application/json' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_json');
    const ok = await srv.request('/api/onboarding', { method: 'POST', body: json, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    assert.equal(ok.status, 200, ok.text);
  });
});

// ======================================================================== PRODUÇÃO SIMULADA
// MP falso (fetch mock), Upstash falso (KV_REST_API_*), Supabase/Emptra falsos.

const payments = new Map(); // id → pagamento do MP | número (status HTTP de erro)
let nextPay = 610000;
const mpHandler = (url) => {
  if (url.hostname !== 'api.mercadopago.com') return undefined;
  const p = payments.get(url.pathname.split('/').pop());
  if (p === undefined) return { status: 404, json: { message: 'Payment not found' } };
  if (typeof p === 'number') return { status: p, json: { message: 'erro' } };
  return { status: 200, json: p };
};

/** Pagamento aprovado no MP falso + accessToken emitido por /api/payment-status (como o /obrigado faz). */
async function prodAccess(product = 'obtra', overrides = {}) {
  const id = String(nextPay++);
  const ref = `aqta:${product}:basico:${crypto.randomUUID()}`;
  payments.set(id, mpPayment({ id: Number(id), external_reference: ref, transaction_amount: product === 'emptra' ? 300 : 200, ...overrides }));
  const r = await srv.request(`/api/payment-status?payment_id=${id}&external_reference=${encodeURIComponent(ref)}`);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.body.accessToken, r.text);
  return { id, ref, accessToken: r.body.accessToken };
}
/** CNPJ válido aleatório (o Emptra real tem cnpj único: cada empresa de teste precisa do seu). */
function newCnpj() {
  const d = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).concat([0, 0, 0, 1]);
  for (const w of [[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]]) {
    const r = w.reduce((acc, wi, i) => acc + wi * d[i], 0) % 11;
    d.push(r < 2 ? 0 : 11 - r);
  }
  return d.join('');
}
const mpStatus = (id, status, extra = {}) => payments.set(id, { ...payments.get(id), status, status_detail: status, ...extra });

describe('produção', () => {
  let kv;
  let mock;
  let restoreEnv;
  before(async () => {
    kv = await startUpstashMock();
    restoreEnv = patchEnv({ MP_ACCESS_TOKEN: 'APP_USR-onb', AQTA_TOKEN_SECRET: 'o'.repeat(48), MP_WEBHOOK_SECRET: '', ...kv.env });
    mock = installFetchMock(mpHandler);
  });
  after(async () => { mock.restore(); restoreEnv(); await kv.close(); });
  beforeEach(() => { kv.state.opts.down = false; });

  describe('modo manual (sem credenciais de provisionamento)', () => {
    test('Obtra ⇒ 200 manual, prazo 1 dia útil, sem senha, token onboarded, equipe notificada, resultado salvo', async () => {
      const { id, accessToken } = await prodAccess('obtra');
      const input = onboardingInput(accessToken, 'obtra');
      const r = await post(input);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.mode, 'manual');
      assert.equal(r.body.demo, false);
      assert.equal(r.body.loginUrl, 'https://obtra.vercel.app/entrar');
      assert.equal(r.body.loginEmail, input.loginEmail);
      assert.equal(r.body.manualDeadline, 'até 1 dia útil');
      assert.equal(r.body.tempPassword, undefined);
      const t = decodeToken(r.body.accessToken);
      assert.equal(t.onboarded, true);
      assert.equal(t.onboarding.mode, 'manual');
      const ev = (await cap.waitFor((b) => b.event === 'onboarding.completed' && b.paymentId === id)).body;
      assert.equal(ev.mode, 'manual');
      assert.equal(ev.manualActionRequired, true);
      assert.equal(ev.document, input.document);
      assert.deepEqual(ev.extra, { cidade: 'Niterói', uf: 'RJ', obrasAtivas: '4-10' });
      assert.match(ev.text, /LIBERAÇÃO MANUAL PENDENTE/);

      const saved = kv.value(`aqta:onboarding:${id}`);
      assert.equal(saved.state, 'done');
      assert.equal(saved.accessToken, r.body.accessToken);
      assert.equal(saved.publicResult.loginEmail, input.loginEmail);
      assert.ok(kv.list('aqta:events').some((e) => e.event === 'onboarding.completed' && e.paymentId === id), 'evento não foi para o registro durável');

      const g = await get(r.body.accessToken);
      assert.equal(g.status, 200);
      assert.equal(g.body.mode, 'manual');
    });

    test('Emptra fornecedor: categorias por slug/nome viram os nomes do catálogo do Emptra; desconhecidas são descartadas', async () => {
      const { id, accessToken } = await prodAccess('emptra');
      const r = await post(onboardingInput(accessToken, 'emptra', {
        extra: { profile: 'Fornecedor', city: 'Niterói/RJ', categories: ['hidraulica', 'iluminação', 'xpto', 'Hidráulica — tubos e conexões'] },
      }));
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.mode, 'manual');
      assert.equal(r.body.profile, 'fornecedor');
      const ev = (await cap.waitFor((b) => b.event === 'onboarding.completed' && b.paymentId === id)).body;
      assert.deepEqual(ev.extra.categories, ['Hidráulica — tubos e conexões', 'Iluminação']);
    });

    test('OBTRA_APP_URL / EMPTRA_APP_URL mudam o loginUrl (sempre /entrar)', async () => {
      const restore = patchEnv({ OBTRA_APP_URL: 'https://app.obtra.com.br/', EMPTRA_APP_URL: 'https://app.emptra.com.br' });
      try {
        const a = await prodAccess('obtra');
        assert.equal((await post(onboardingInput(a.accessToken))).body.loginUrl, 'https://app.obtra.com.br/entrar');
        const b = await prodAccess('emptra');
        assert.equal((await post(onboardingInput(b.accessToken, 'emptra'))).body.loginUrl, 'https://app.emptra.com.br/entrar');
      } finally { restore(); }
    });
  });

  describe('idempotência por pagamento (armazenamento durável)', () => {
    test('dois tokens do mesmo pagamento, e-mails diferentes ⇒ o 2º recebe alreadyDone com o resultado do 1º', async () => {
      const { id, ref, accessToken } = await prodAccess('obtra');
      const again = await srv.request(`/api/payment-status?payment_id=${id}&external_reference=${encodeURIComponent(ref)}`);
      const tokenB = again.body.accessToken;
      assert.ok(tokenB);
      const first = await post(onboardingInput(accessToken, 'obtra', { loginEmail: 'primeiro@example.com' }));
      assert.equal(first.status, 200, first.text);
      cap.clear();
      const second = await post(onboardingInput(tokenB, 'obtra', { loginEmail: 'segundo@example.com' }));
      assert.equal(second.status, 200, second.text);
      assert.equal(second.body.alreadyDone, true);
      assert.equal(second.body.loginEmail, 'primeiro@example.com');
      assert.equal(second.body.accessToken, first.body.accessToken);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(cap.events('onboarding.completed').length, 0);

      // REV-6: depois de ativado, /api/payment-status devolve o token "onboarded", não um token de ativação novo.
      const st = await srv.request(`/api/payment-status?payment_id=${id}&external_reference=${encodeURIComponent(ref)}`);
      assert.equal(st.body.onboarded, true);
      assert.equal(st.body.accessToken, first.body.accessToken);
      // e o GET com o token de ativação antigo mostra o resultado já salvo
      const g = await get(tokenB);
      assert.equal(g.body.onboarded, true);
      assert.equal(g.body.loginEmail, 'primeiro@example.com');
    });

    test('ativação em andamento em outra instância ⇒ 409 in_progress', async () => {
      const { id, accessToken } = await prodAccess('obtra');
      kv.put(`aqta:onboarding:${id}`, { state: 'in_progress', at: new Date().toISOString() }, 600);
      const r = await post(onboardingInput(accessToken));
      assert.equal(r.status, 409, r.text);
      assert.equal(r.body.error, 'in_progress');
      assert.ok(r.body.message);
    });
  });

  describe('pagamento revisto no Mercado Pago antes de ativar (REV-3)', () => {
    for (const [status, extra] of [['refunded', {}], ['charged_back', {}], ['cancelled', {}], ['in_mediation', {}], ['approved', { transaction_amount_refunded: 50 }]]) {
      test(`${status}${extra.transaction_amount_refunded ? ' com estorno parcial' : ''} depois do accessToken ⇒ 402 payment_not_active, nada salvo`, async () => {
        const { id, accessToken } = await prodAccess('obtra');
        mpStatus(id, status, extra);
        const r = await post(onboardingInput(accessToken));
        assert.equal(r.status, 402, r.text);
        assert.equal(r.body.error, 'payment_not_active');
        assert.ok(r.body.message);
        assert.equal(kv.value(`aqta:onboarding:${id}`), null);
      });
    }

    test('Mercado Pago fora do ar ⇒ 503 payment_check_failed (tenta de novo depois), sem travar o pagamento', async () => {
      const { id, accessToken } = await prodAccess('obtra');
      const saved = payments.get(id);
      payments.set(id, 500);
      try {
        const r = await post(onboardingInput(accessToken));
        assert.equal(r.status, 503, r.text);
        assert.equal(r.body.error, 'payment_check_failed');
        assert.equal(kv.value(`aqta:onboarding:${id}`), null);
      } finally { payments.set(id, saved); }
      const ok = await post(onboardingInput(accessToken));
      assert.equal(ok.status, 200, ok.text);
    });

    test('chargeback pelo webhook depois da ativação ⇒ revogado: equipe avisada, /acesso e /obrigado refletem', async () => {
      const { id, ref, accessToken } = await prodAccess('obtra');
      const done = await post(onboardingInput(accessToken));
      assert.equal(done.status, 200);
      mpStatus(id, 'charged_back');
      const w = await srv.request(`/api/webhook?data.id=${id}&type=payment`, { method: 'POST', body: { type: 'payment', action: 'payment.updated', data: { id } } });
      assert.equal(w.status, 200, w.text);
      assert.equal(w.body.revoked, true);
      const ev = (await cap.waitFor((b) => b.event === 'payment.revoked' && b.paymentId === id)).body;
      assert.equal(ev.status, 'charged_back');
      assert.match(ev.action, /REVOGAR/);
      assert.equal(kv.value(`aqta:revoked:${id}`).status, 'charged_back');

      const g = await get(done.body.accessToken);
      assert.equal(g.status, 402);
      assert.equal(g.body.error, 'payment_not_active');
      const p = await post({ accessToken: done.body.accessToken });
      assert.equal(p.status, 402);
      const st = await srv.request(`/api/payment-status?payment_id=${id}&external_reference=${encodeURIComponent(ref)}`);
      assert.equal(st.body.revoked, true);
      assert.equal(st.body.accessToken, undefined);
    });
  });

  describe('tokens', () => {
    test('token assinado com o segredo fixo do demo NUNCA vale em produção', async () => {
      const now = Math.floor(Date.now() / 1000);
      const body = Buffer.from(JSON.stringify({ t: 'access', paymentId: '1', product: 'obtra', plan: 'basico', customer: {}, iat: now, exp: now + 600 })).toString('base64url');
      const forged = `${body}.${crypto.createHmac('sha256', DEMO_SECRET).update(body).digest('base64url')}`;
      const r = await post(onboardingInput(forged));
      assert.equal(r.status, 401);
      assert.equal(r.body.error, 'invalid_token');
      assert.equal((await get(forged)).status, 401);
    });

    test('AQTA_TOKEN_SECRET igual ao segredo do demo é recusado em produção (erro de configuração)', async () => {
      const restore = patchEnv({ AQTA_TOKEN_SECRET: DEMO_SECRET });
      try {
        const r = await post(onboardingInput('a.b'));
        assert.equal(r.status, 500);
        assert.equal(r.body.error, 'server_misconfigured');
      } finally { restore(); }
    });
  });

  describe('sem armazenamento durável ⇒ provisionamento automático desligado', () => {
    let obtra;
    before(async () => { obtra = await startObtraMock(); });
    after(() => obtra.close());

    test('sem KV_REST_API_* (produção) ⇒ manual mesmo com credenciais, sem chamar o Obtra, equipe sabe o motivo', async () => {
      const restore = patchEnv({ KV_REST_API_URL: '', KV_REST_API_TOKEN: '', OBTRA_SUPABASE_URL: obtra.url, OBTRA_SUPABASE_SERVICE_KEY: obtra.serviceKey });
      try {
        const { id, accessToken } = await prodAccess('obtra');
        const r = await post(onboardingInput(accessToken));
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.mode, 'manual');
        assert.equal(r.body.tempPassword, undefined);
        assert.equal(obtra.state.calls.length, 0);
        const ev = (await cap.waitFor((b) => b.event === 'onboarding.completed' && b.paymentId === id)).body;
        assert.equal(ev.autoProvisionDisabled, 'store_not_configured');
      } finally { restore(); }
    });

    test('UPSTASH_REDIS_REST_* também serve como armazenamento', async () => {
      const restore = patchEnv({ KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: kv.url, UPSTASH_REDIS_REST_TOKEN: kv.token, OBTRA_SUPABASE_URL: obtra.url, OBTRA_SUPABASE_SERVICE_KEY: obtra.serviceKey });
      try {
        const { id, accessToken } = await prodAccess('obtra');
        const r = await post(onboardingInput(accessToken));
        assert.equal(r.body.mode, 'auto', r.text);
        assert.equal(kv.value(`aqta:onboarding:${id}`).state, 'done');
      } finally { restore(); }
    });

    test('armazenamento fora do ar ⇒ manual (sem provisionar), venda não se perde', async () => {
      const restore = patchEnv({ OBTRA_SUPABASE_URL: obtra.url, OBTRA_SUPABASE_SERVICE_KEY: obtra.serviceKey });
      const calls = obtra.state.calls.length;
      try {
        const { id, accessToken } = await prodAccess('obtra');
        kv.state.opts.down = true;
        const r = await post(onboardingInput(accessToken));
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.mode, 'manual');
        assert.equal(obtra.state.calls.length, calls);
        const ev = (await cap.waitFor((b) => b.event === 'onboarding.completed' && b.paymentId === id)).body;
        assert.equal(ev.autoProvisionDisabled, 'store_unavailable');
      } finally { kv.state.opts.down = false; restore(); }
    });
  });

  describe('provisionamento automático — Obtra (Supabase mock)', () => {
    let obtra;
    let restore;
    before(async () => { obtra = await startObtraMock(); });
    after(() => obtra.close());
    beforeEach(() => { obtra.state.opts.failRpc = null; });
    const withObtra = (extra = {}) => patchEnv({ OBTRA_SUPABASE_URL: obtra.url + '/', OBTRA_SUPABASE_SERVICE_KEY: obtra.serviceKey, ...extra });

    test('cria empresa + usuário admin e devolve senha temporária forte (só na resposta)', async () => {
      restore = withObtra();
      try {
        const { id, accessToken } = await prodAccess('obtra');
        const input = onboardingInput(accessToken, 'obtra', { loginEmail: 'Novo.Admin@Example.com' });
        const r = await post(input);
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.mode, 'auto');
        assert.equal(r.body.loginEmail, 'novo.admin@example.com');
        assert.equal(r.body.loginUrl, 'https://obtra.vercel.app/entrar');
        const pwd = r.body.tempPassword;
        assert.equal(typeof pwd, 'string');
        assert.equal(pwd.length, 14);
        assert.match(pwd, /[A-Z]/); assert.match(pwd, /[a-z]/); assert.match(pwd, /[2-9]/); assert.match(pwd, /[@#$%&*!?]/);
        assert.doesNotMatch(pwd, /[0O1lI]/);

        const [empresaCall] = obtra.state.calls.filter((c) => c.path === '/rest/v1/empresas' && c.method === 'POST' && c.body.email === 'novo.admin@example.com');
        assert.equal(empresaCall.body.nome, 'Construtora Teste Ltda');
        assert.equal(empresaCall.body.cnpj, '11.222.333/0001-81');
        assert.equal(empresaCall.body.cidade, 'Niterói');
        assert.equal(empresaCall.body.uf, 'RJ');
        assert.equal(empresaCall.body.telefone, '(21) 98765-4321');
        assert.equal(empresaCall.body.ativa, true);
        assert.match(empresaCall.headers.prefer, /return=representation/);
        assert.equal(empresaCall.headers.authorization, undefined, 'chave sb_secret_ não vai como Bearer');
        const user = obtra.state.usuarios.at(-1);
        assert.equal(user.p_email, 'novo.admin@example.com');
        assert.equal(user.p_papel, 'admin');
        assert.equal(user.p_senha, pwd);
        assert.equal(user.p_nome, 'Maria Teste da Silva');

        // A senha não vai para o token, nem para a equipe, nem para o GET, nem para o armazenamento.
        assert.doesNotMatch(Buffer.from(r.body.accessToken.split('.')[0], 'base64url').toString(), new RegExp(pwd.replace(/[$*?]/g, '\\$&')));
        const ev = (await cap.waitFor((b) => b.event === 'onboarding.completed' && b.paymentId === id)).body;
        assert.equal(ev.mode, 'auto');
        assert.ok(!JSON.stringify(ev).includes(pwd), 'senha vazou para a notificação');
        assert.ok(!JSON.stringify(kv.value(`aqta:onboarding:${id}`)).includes(pwd), 'senha vazou para o armazenamento');
        assert.ok(!JSON.stringify(kv.list('aqta:events')).includes(pwd), 'senha vazou para o registro de eventos');
        const g = await get(r.body.accessToken);
        assert.ok(!g.text.includes(pwd));
        assert.equal(g.body.mode, 'auto');
      } finally { restore(); }
    });

    test('CPF não vai para empresas.cnpj (fica nulo)', async () => {
      restore = withObtra();
      try {
        const { accessToken } = await prodAccess('obtra');
        const r = await post(onboardingInput(accessToken, 'obtra', { document: CPF_DIGITS, loginEmail: 'cpf.obtra@example.com' }));
        assert.equal(r.body.mode, 'auto', r.text);
        const call = obtra.state.calls.find((c) => c.path === '/rest/v1/empresas' && c.method === 'POST' && c.body.email === 'cpf.obtra@example.com');
        assert.equal(call.body.cnpj, null);
      } finally { restore(); }
    });

    test('chave legada JWT (eyJ...) também vai no Authorization: Bearer', async () => {
      const jwtMock = await startObtraMock({ serviceKey: 'eyJhbGciOi.test.key' });
      restore = patchEnv({ OBTRA_SUPABASE_URL: jwtMock.url, OBTRA_SUPABASE_SERVICE_KEY: 'eyJhbGciOi.test.key' });
      try {
        const { accessToken } = await prodAccess('obtra');
        const r = await post(onboardingInput(accessToken));
        assert.equal(r.body.mode, 'auto', r.text);
        assert.ok(jwtMock.state.calls.every((c) => c.headers.authorization === 'Bearer eyJhbGciOi.test.key'));
      } finally { restore(); await jwtMock.close(); }
    });

    test('e-mail já cadastrado ⇒ fallback manual sem criar empresa, com aviso à equipe', async () => {
      restore = withObtra();
      try {
        obtra.state.perfis.add('ja.existe@example.com');
        const before = obtra.state.empresas.size;
        const { id, accessToken } = await prodAccess('obtra');
        const r = await post(onboardingInput(accessToken, 'obtra', { loginEmail: 'ja.existe@example.com' }));
        assert.equal(r.status, 200);
        assert.equal(r.body.mode, 'manual');
        assert.equal(r.body.tempPassword, undefined);
        assert.match(r.body.notes, /já tem cadastro/);
        assert.equal(obtra.state.empresas.size, before);
        const ev = (await cap.waitFor((b) => b.event === 'onboarding.completed' && b.paymentId === id)).body;
        assert.match(ev.provisionError, /já cadastrado/);
      } finally { restore(); }
    });

    test('e-mail criado entre a consulta e a RPC (409 23505 real) ⇒ rollback e nota de e-mail existente', async () => {
      restore = withObtra();
      obtra.state.opts.failRpc = { status: 409, body: { code: '23505', details: null, hint: null, message: 'E-mail já cadastrado' } };
      try {
        const before = obtra.state.empresas.size;
        const { accessToken } = await prodAccess('obtra');
        const r = await post(onboardingInput(accessToken));
        assert.equal(r.body.mode, 'manual');
        assert.match(r.body.notes, /já tem cadastro/);
        assert.equal(obtra.state.empresas.size, before);
      } finally { restore(); }
    });

    test('falha na RPC ⇒ desfaz a empresa (sem órfã), cai para manual e NÃO vaza a senha', async () => {
      restore = withObtra();
      obtra.state.opts.failRpc = { status: 500, body: { message: 'erro interno do banco' } };
      try {
        const before = obtra.state.empresas.size;
        const { id, accessToken } = await prodAccess('obtra');
        const r = await post(onboardingInput(accessToken));
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.mode, 'manual');
        assert.equal(r.body.tempPassword, undefined);
        assert.ok(obtra.state.calls.some((c) => c.method === 'DELETE' && c.path === '/rest/v1/empresas'), 'rollback não chamado');
        assert.equal(obtra.state.empresas.size, before, 'empresa órfã ficou no banco');
        const sent = obtra.state.calls.filter((c) => c.path === '/rest/v1/rpc/admin_criar_usuario').at(-1).body.p_senha;
        assert.ok(!r.text.includes(sent), 'senha vazou na resposta');
        const ev = await cap.waitFor((b) => b.event === 'onboarding.completed' && b.paymentId === id);
        assert.ok(!JSON.stringify(ev.body).includes(sent), 'senha vazou na notificação');
        assert.equal(ev.body.mode, 'manual');
        assert.ok(ev.body.provisionError);
      } finally { restore(); }
    });

    test('Supabase fora do ar (rede) ⇒ fallback manual', async () => {
      restore = patchEnv({ OBTRA_SUPABASE_URL: 'http://127.0.0.1:9', OBTRA_SUPABASE_SERVICE_KEY: 'x' });
      try {
        const { accessToken } = await prodAccess('obtra');
        const r = await post(onboardingInput(accessToken));
        assert.equal(r.status, 200);
        assert.equal(r.body.mode, 'manual');
      } finally { restore(); }
    });

    test('duplo clique (2 POSTs simultâneos) ⇒ um único usuário criado', async () => {
      restore = withObtra();
      try {
        const { accessToken } = await prodAccess('obtra');
        const before = obtra.state.usuarios.length;
        const input = onboardingInput(accessToken);
        const [a, b] = await Promise.all([post(input), post(input)]);
        assert.equal(a.status, 200); assert.equal(b.status, 200);
        assert.equal(obtra.state.usuarios.length, before + 1);
        assert.ok(a.body.alreadyDone || b.body.alreadyDone);
      } finally { restore(); }
    });

    test('um pagamento não pode criar duas contas, mesmo em outra instância serverless (sem cache em memória)', async () => {
      restore = withObtra();
      try {
        const { accessToken } = await prodAccess('obtra');
        const first = await post(onboardingInput(accessToken, 'obtra', { loginEmail: 'conta1@example.com' }));
        assert.equal(first.body.mode, 'auto');
        const fresh = await importProject('api/onboarding.js', { fresh: true });
        const second = await invoke(fresh.default, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: onboardingInput(accessToken, 'obtra', { loginEmail: 'conta2@example.com' }),
        });
        const created = obtra.state.usuarios.filter((u) => ['conta1@example.com', 'conta2@example.com'].includes(u.p_email)).length;
        assert.equal(created, 1, `BUG: o mesmo pagamento criou ${created} contas (2ª resposta: mode=${second.body?.mode}, alreadyDone=${second.body?.alreadyDone})`);
        assert.equal(second.body.alreadyDone, true);
        assert.equal(second.body.loginEmail, 'conta1@example.com');
      } finally { restore(); }
    });
  });

  describe('provisionamento automático — Emptra (API mock no formato real)', () => {
    let emptra;
    let restore;
    before(async () => { emptra = await startEmptraMock(); });
    after(() => emptra.close());
    beforeEach(() => {
      emptra.state.opts.failUser = null; emptra.state.opts.failCompany = null;
      emptra.state.opts.adminRole = 'ADMIN'; emptra.state.loggedOut = false;
    });
    const withEmptra = (extra = {}) => patchEnv({ EMPTRA_API_URL: emptra.url, EMPTRA_ADMIN_EMAIL: emptra.adminEmail, EMPTRA_ADMIN_PASSWORD: emptra.adminPassword, ...extra });

    test('comprador com CNPJ ⇒ empresa BUYER + usuário ACTIVE, senha temporária, logout do admin', async () => {
      restore = withEmptra();
      try {
        const { id, accessToken } = await prodAccess('emptra');
        const r = await post(onboardingInput(accessToken, 'emptra', { loginEmail: 'comprador@example.com', document: CNPJ_DIGITS }));
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.mode, 'auto');
        assert.equal(r.body.profile, 'comprador');
        assert.equal(r.body.loginUrl, 'https://emptra.srv1848886.hstgr.cloud/entrar');
        assert.equal(r.body.tempPassword.length, 14);
        const company = [...emptra.state.companies.values()].at(-1);
        assert.equal(company.type, 'BUYER');
        assert.equal(company.cnpj, '11222333000181');
        assert.equal(company.city, 'Niterói');
        assert.equal(company.state, 'RJ');
        assert.equal(company.active, true);
        const user = emptra.state.users.at(-1);
        assert.equal(user.email, 'comprador@example.com');
        assert.equal(user.role, 'BUYER');
        assert.equal(user.status, 'ACTIVE');
        assert.equal(user.password, r.body.tempPassword);
        assert.equal(emptra.state.loggedOut, true, 'sessão do admin não foi encerrada');
        const ev = await cap.waitFor((b) => b.event === 'onboarding.completed' && b.paymentId === id);
        assert.ok(!JSON.stringify(ev.body).includes(r.body.tempPassword));
      } finally { restore(); }
    });

    test('fornecedor com CPF ⇒ empresa SUPPLIER, cnpj null, categorias com os nomes do catálogo', async () => {
      restore = withEmptra();
      try {
        const { accessToken } = await prodAccess('emptra');
        const r = await post(onboardingInput(accessToken, 'emptra', {
          document: CPF_DIGITS,
          extra: { perfil: 'fornecedor', cidade: 'Maricá', uf: 'RJ', categories: ['eletrica', 'Tintas e vernizes'] },
        }));
        assert.equal(r.body.mode, 'auto', r.text);
        assert.equal(r.body.profile, 'fornecedor');
        const company = [...emptra.state.companies.values()].at(-1);
        assert.equal(company.type, 'SUPPLIER');
        assert.equal(company.cnpj, null);
        assert.deepEqual(company.profile, { categories: ['Elétrica — cabos, eletrodutos e quadros', 'Tintas e vernizes'] });
        assert.equal(emptra.state.users.at(-1).role, 'SUPPLIER');
      } finally { restore(); }
    });

    test('fornecedor sem categorias ⇒ criado, com nota pedindo as categorias', async () => {
      restore = withEmptra();
      try {
        const { accessToken } = await prodAccess('emptra');
        const r = await post(onboardingInput(accessToken, 'emptra', { document: newCnpj(), extra: { perfil: 'fornecedor', cidade: 'Maricá', uf: 'RJ' } }));
        assert.equal(r.body.mode, 'auto', r.text);
        assert.deepEqual([...emptra.state.companies.values()].at(-1).profile, { categories: [] });
        assert.match(r.body.notes, /categorias/);
      } finally { restore(); }
    });

    test('falha ao criar usuário ⇒ rollback da empresa, fallback manual, sem senha, logout feito', async () => {
      restore = withEmptra();
      emptra.state.opts.failUser = { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Erro interno do servidor' } } };
      try {
        const before = emptra.state.companies.size;
        const { accessToken } = await prodAccess('emptra');
        const r = await post(onboardingInput(accessToken, 'emptra', { document: newCnpj() }));
        assert.equal(r.status, 200);
        assert.equal(r.body.mode, 'manual');
        assert.equal(r.body.tempPassword, undefined);
        assert.equal(r.body.profile, 'comprador');
        assert.equal(emptra.state.companies.size, before, 'empresa órfã');
        assert.equal(emptra.state.loggedOut, true);
        const sent = emptra.state.calls.filter((c) => c.path === '/admin/users' && c.method === 'POST').at(-1).body.password;
        assert.ok(!r.text.includes(sent));
      } finally { restore(); }
    });

    test('e-mail duplicado detectado só na criação (409 real "Já existe um registro com este email") ⇒ nota de e-mail existente', async () => {
      restore = withEmptra();
      emptra.state.opts.failUser = { status: 409, body: { error: { code: 'CONFLICT', message: 'Já existe um registro com este email' } } };
      try {
        const { accessToken } = await prodAccess('emptra');
        const r = await post(onboardingInput(accessToken, 'emptra', { document: newCnpj() }));
        assert.equal(r.body.mode, 'manual');
        assert.match(r.body.notes, /já tem cadastro/);
      } finally { restore(); }
    });

    test('CNPJ já cadastrado (409 real) ⇒ manual com nota de empresa existente', async () => {
      restore = withEmptra();
      try {
        const cnpj = newCnpj();
        const a = await prodAccess('emptra');
        assert.equal((await post(onboardingInput(a.accessToken, 'emptra', { document: cnpj }))).body.mode, 'auto');
        const b = await prodAccess('emptra');
        const r = await post(onboardingInput(b.accessToken, 'emptra', { document: cnpj })); // mesmo CNPJ
        assert.equal(r.body.mode, 'manual');
        assert.match(r.body.notes, /CNPJ já tem empresa/);
      } finally { restore(); }
    });

    test('422 VALIDATION_ERROR do Emptra ⇒ manual com nota de dado recusado e detalhes para a equipe', async () => {
      restore = withEmptra();
      emptra.state.opts.failCompany = { status: 422, body: { error: { code: 'VALIDATION_ERROR', message: 'Dados inválidos', details: [{ field: 'email', message: 'Invalid email' }] } } };
      try {
        const { id, accessToken } = await prodAccess('emptra');
        const r = await post(onboardingInput(accessToken, 'emptra', { document: newCnpj() }));
        assert.equal(r.body.mode, 'manual');
        assert.match(r.body.notes, /recusou/);
        const ev = (await cap.waitFor((b) => b.event === 'onboarding.completed' && b.paymentId === id)).body;
        assert.match(ev.provisionError, /422.*email: Invalid email/);
      } finally { restore(); }
    });

    test('conta configurada não é ADMIN / senha de admin errada / e-mail já existe ⇒ manual', async () => {
      restore = withEmptra();
      try {
        emptra.state.opts.adminRole = 'BUYER';
        let r = await post(onboardingInput((await prodAccess('emptra')).accessToken, 'emptra', { document: CPF_DIGITS }));
        assert.equal(r.body.mode, 'manual');
        emptra.state.opts.adminRole = 'ADMIN';
        const r2 = patchEnv({ EMPTRA_ADMIN_PASSWORD: 'errada' });
        r = await post(onboardingInput((await prodAccess('emptra')).accessToken, 'emptra', { document: CPF_DIGITS }));
        r2();
        assert.equal(r.body.mode, 'manual');
        emptra.state.users.push({ id: 'u-x', email: 'ja.emptra@example.com' });
        r = await post(onboardingInput((await prodAccess('emptra')).accessToken, 'emptra', { document: CPF_DIGITS, loginEmail: 'ja.emptra@example.com' }));
        assert.equal(r.body.mode, 'manual');
        assert.match(r.body.notes, /já tem cadastro/);
      } finally { restore(); }
    });
  });
});
