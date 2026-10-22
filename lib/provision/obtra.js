// Provisionamento automático do Obtra (Supabase).
//
// Como o banco do Obtra funciona (supabase/instalar.sql):
// - `public.empresas` (nome obrigatório; cnpj/email/telefone/cidade/uf opcionais; uf com 2 letras;
//   limite_armazenamento_mb padrão 2048; ativa padrão true). Não há tabela de plano/assinatura.
// - `public.admin_criar_usuario(p_email, p_senha, p_nome, p_papel, p_empresa_id, p_obras, p_telefone, p_cargo)`
//   é SECURITY DEFINER e cria auth.users + auth.identities + perfis numa transação. Quando quem chama
//   não tem JWT de usuário (auth.uid() nulo — caso da service_role), ela pula a checagem de master/admin;
//   o EXECUTE dela é concedido à service_role na 0006. Exige: e-mail válido e inédito, senha ≥ 6, nome,
//   papel em (master|admin|colaborador|cliente) e empresa existente.
// - Papel do comprador: `admin` (administrador da própria empresa: gerencia obras, cadastros e usuários).
// - Login do app: rota `/entrar` (web/src/App.tsx).
//
// Fluxo: confere se o e-mail já existe (perfis) → cria a empresa (REST) → chama a RPC → se a RPC falhar,
// apaga a empresa recém-criada (para não deixar órfã) e lança. Quem chama cai para o modo manual.

import { randomInt } from 'node:crypto';
import { PRODUCTS } from '../catalog.js';

const TIMEOUT_MS = 10000;
const LOGIN_PATH = '/entrar'; // rota real do Obtra (o catálogo diz /login, que no app cai no 404 da SPA)

export function obtraLoginUrl() {
  const app = (process.env.OBTRA_APP_URL || PRODUCTS.obtra.appUrl).replace(/\/$/, '');
  return `${app}${LOGIN_PATH}`;
}

/** Senha temporária forte: 14 caracteres, sem ambíguos (0/O, 1/l/I), com maiúscula, minúscula, dígito e símbolo. */
export function generateTempPassword(length = 14) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '@#$%&*!?'];
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export class ProvisionError extends Error {
  constructor(message, code = 'provision_failed', status) {
    super(message);
    this.name = 'ProvisionError';
    this.code = code;
    if (status) this.status = status;
  }
}

const fmtDoc = (d) => (d.length === 14
  ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
  : d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : d);

function fmtPhone(d) {
  const n = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d;
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return d;
}

/** "Cidade/UF", "Cidade - UF" ou { city, state } → { cidade, uf } */
export function splitCityUf(extra = {}) {
  let cidade = String(extra.city ?? extra.cidade ?? '').trim();
  let uf = String(extra.state ?? extra.uf ?? '').trim();
  const m = cidade.match(/^(.*?)\s*(?:\/|-|,)\s*([A-Za-z]{2})$/);
  if (m) { cidade = m[1].trim(); if (!uf) uf = m[2]; }
  uf = uf.toUpperCase();
  return { cidade: cidade.slice(0, 120) || null, uf: /^[A-Z]{2}$/.test(uf) ? uf : null };
}

function supabaseHeaders(key, extra = {}) {
  const h = { apikey: key, 'Content-Type': 'application/json', Accept: 'application/json', ...extra };
  // Chave legada (JWT eyJ...) vai também no Authorization. As novas "sb_secret_..." não são JWT:
  // o gateway do Supabase as traduz a partir do header apikey.
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;
  return h;
}

async function call(url, init, what) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new ProvisionError(`Obtra: falha de rede em ${what} (${err?.name === 'TimeoutError' ? 'timeout' : err?.message || err})`, 'network');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (data.message || data.msg || data.error_description || data.error)) || String(text).slice(0, 200);
    const code = /já cadastrado/i.test(msg) || data?.code === '23505' ? 'email_exists' : 'provision_failed';
    throw new ProvisionError(`Obtra: ${what} falhou (${res.status}): ${msg}`, code, res.status);
  }
  return data;
}

/**
 * @param {{ product, plan, company, document, responsible, loginEmail, whatsapp, extra, paymentId }} input
 * @returns {Promise<{ mode: 'auto'|'manual', loginUrl, loginEmail, tempPassword?, notes, externalIds? }>}
 */
export async function provision(input) {
  const loginUrl = obtraLoginUrl();
  const loginEmail = String(input.loginEmail).trim().toLowerCase();
  const base = (process.env.OBTRA_SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.OBTRA_SUPABASE_SERVICE_KEY || '';
  if (!base || !key) {
    return { mode: 'manual', loginUrl, loginEmail, notes: 'Provisionamento automático do Obtra não configurado.' };
  }

  // 1) E-mail já usado? (perfis.email é gravado em minúsculas pela RPC.) Evita criar empresa órfã.
  const existing = await call(
    `${base}/rest/v1/perfis?select=id&email=eq.${encodeURIComponent(loginEmail)}&limit=1`,
    { method: 'GET', headers: supabaseHeaders(key) },
    'consulta de e-mail',
  );
  if (Array.isArray(existing) && existing.length) {
    throw new ProvisionError('Obtra: e-mail de login já cadastrado', 'email_exists', 409);
  }

  // 2) Empresa.
  const { cidade, uf } = splitCityUf(input.extra);
  const doc = String(input.document || '').replace(/\D/g, '');
  const phone = String(input.whatsapp || '').replace(/\D/g, '');
  const created = await call(
    `${base}/rest/v1/empresas?select=id`,
    {
      method: 'POST',
      headers: supabaseHeaders(key, { Prefer: 'return=representation' }),
      body: JSON.stringify({
        nome: String(input.company).trim(),
        cnpj: doc ? fmtDoc(doc) : null,
        email: loginEmail,
        telefone: phone ? fmtPhone(phone) : null,
        cidade,
        uf,
        ativa: true,
      }),
    },
    'criação da empresa',
  );
  const empresaId = Array.isArray(created) ? created[0]?.id : created?.id;
  if (!empresaId) throw new ProvisionError('Obtra: criação da empresa não devolveu id');

  // 3) Usuário administrador da empresa (auth.users + identities + perfis), via RPC.
  const tempPassword = generateTempPassword();
  let userId;
  try {
    userId = await call(
      `${base}/rest/v1/rpc/admin_criar_usuario`,
      {
        method: 'POST',
        headers: supabaseHeaders(key),
        body: JSON.stringify({
          p_email: loginEmail,
          p_senha: tempPassword,
          p_nome: String(input.responsible).trim(),
          p_papel: 'admin',
          p_empresa_id: empresaId,
          p_obras: [],
          p_telefone: phone ? fmtPhone(phone) : null,
          p_cargo: 'Responsável',
        }),
      },
      'criação do usuário',
    );
  } catch (err) {
    // Desfaz a empresa para não deixar órfã (melhor esforço).
    try {
      await fetch(`${base}/rest/v1/empresas?id=eq.${encodeURIComponent(empresaId)}`, {
        method: 'DELETE', headers: supabaseHeaders(key), signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch { /* a equipe vê o erro na notificação */ }
    throw err;
  }

  return {
    mode: 'auto',
    loginUrl,
    loginEmail,
    tempPassword,
    notes: 'Empresa e usuário administrador criados no Obtra.',
    externalIds: { empresaId, userId: typeof userId === 'string' ? userId : null },
  };
}

export default provision;
