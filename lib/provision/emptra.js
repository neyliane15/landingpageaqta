// Provisionamento automático do Emptra (API Express/Prisma).
//
// Como a API do Emptra funciona (backend/src/app.ts e modules/*):
// - Rotas na raiz da API (sem prefixo /api): POST /auth/login { email, password } → { accessToken, refreshToken, user }.
//   Rate limit próprio no login (20 tentativas / 15 min em produção).
// - POST /companies (só ADMIN) { type: BUYER|SUPPLIER, name, cnpj?, email?, phone?, whatsapp?, city?, state?, active?,
//   profile? } → 201 { company }. cnpj é único (409 CONFLICT se repetido). Fornecedor ganha supplierProfile.
//   city é o nome do município (a API calcula lat/lng para o raio de atendimento).
// - POST /admin/users (só ADMIN) { name ≥3, email, password ≥8, role: BUYER|SUPPLIER, phone?, jobTitle?, companyId,
//   status: 'ACTIVE' } → 201 { user }. Criado direto como ACTIVE = acesso já liberado (sem passar pela fila PENDING).
// - GET /admin/users?q= (busca por e-mail), DELETE /companies/:id (rollback), POST /auth/logout { refreshToken }.
// - Erros: { error: { code, message, details? } }.
// - Login do app: rota `/entrar` (frontend/src/App.tsx).

import { randomInt } from 'node:crypto';
import { PRODUCTS } from '../catalog.js';

const TIMEOUT_MS = 10000;
const LOGIN_PATH = '/entrar'; // rota real do Emptra (o catálogo diz /login, que no app cai no NotFound)

export function emptraLoginUrl() {
  const app = (process.env.EMPTRA_APP_URL || PRODUCTS.emptra.appUrl).replace(/\/$/, '');
  return `${app}${LOGIN_PATH}`;
}

export class ProvisionError extends Error {
  constructor(message, code = 'provision_failed', status) {
    super(message);
    this.name = 'ProvisionError';
    this.code = code;
    if (status) this.status = status;
  }
}

/** Senha temporária forte (14 caracteres, sem ambíguos; o Emptra exige ≥ 8). */
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

function splitCityUf(extra = {}) {
  let city = String(extra.city ?? extra.cidade ?? '').trim();
  let state = String(extra.state ?? extra.uf ?? '').trim();
  const m = city.match(/^(.*?)\s*(?:\/|-|,)\s*([A-Za-z]{2})$/);
  if (m) { city = m[1].trim(); if (!state) state = m[2]; }
  state = state.toUpperCase();
  return { city: city.slice(0, 120) || null, state: /^[A-Z]{2}$/.test(state) ? state : null };
}

export const EMPTRA_ROLES = { comprador: 'BUYER', fornecedor: 'SUPPLIER' };

async function call(base, path, { method = 'GET', token, body } = {}, what) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProvisionError(`Emptra: falha de rede em ${what} (${err?.name === 'TimeoutError' ? 'timeout' : err?.message || err})`, 'network');
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (data.error?.message || data.message)) || String(text).slice(0, 200);
    const code = res.status === 409 ? 'conflict' : res.status === 401 || res.status === 403 ? 'admin_auth' : 'provision_failed';
    throw new ProvisionError(`Emptra: ${what} falhou (${res.status}): ${msg}`, code, res.status);
  }
  return data;
}

/**
 * @param {{ product, plan, company, document, responsible, loginEmail, whatsapp, extra, paymentId }} input
 * @returns {Promise<{ mode: 'auto'|'manual', loginUrl, loginEmail, tempPassword?, notes, profile, externalIds? }>}
 */
export async function provision(input) {
  const loginUrl = emptraLoginUrl();
  const loginEmail = String(input.loginEmail).trim().toLowerCase();
  const profile = input.extra?.profile === 'fornecedor' ? 'fornecedor' : 'comprador';
  const role = EMPTRA_ROLES[profile];
  const base = (process.env.EMPTRA_API_URL || '').replace(/\/$/, '');
  const adminEmail = process.env.EMPTRA_ADMIN_EMAIL || '';
  const adminPassword = process.env.EMPTRA_ADMIN_PASSWORD || '';
  if (!base || !adminEmail || !adminPassword) {
    return { mode: 'manual', loginUrl, loginEmail, profile, notes: 'Provisionamento automático do Emptra não configurado.' };
  }

  // 1) Sessão de administrador.
  const session = await call(base, '/auth/login', { method: 'POST', body: { email: adminEmail, password: adminPassword } }, 'login de administrador');
  const token = session?.accessToken;
  if (!token) throw new ProvisionError('Emptra: login de administrador não devolveu accessToken', 'admin_auth');
  if (session.user && session.user.role !== 'ADMIN') {
    throw new ProvisionError('Emptra: a conta configurada em EMPTRA_ADMIN_EMAIL não é ADMIN', 'admin_auth');
  }

  try {
    // 2) E-mail já usado?
    const found = await call(base, `/admin/users?q=${encodeURIComponent(loginEmail)}&perPage=20`, { token }, 'consulta de e-mail');
    if (Array.isArray(found?.data) && found.data.some((u) => String(u.email).toLowerCase() === loginEmail)) {
      throw new ProvisionError('Emptra: e-mail de login já cadastrado', 'email_exists', 409);
    }

    // 3) Empresa (já ativa). CPF não vai no campo cnpj (único e específico de CNPJ).
    const { city, state } = splitCityUf(input.extra);
    const doc = String(input.document || '').replace(/\D/g, '');
    const phone = String(input.whatsapp || '').replace(/\D/g, '');
    const categories = Array.isArray(input.extra?.categories)
      ? input.extra.categories.map((c) => String(c).trim().slice(0, 60)).filter(Boolean).slice(0, 30)
      : [];
    const companyBody = {
      type: role,
      name: String(input.company).trim(),
      cnpj: doc.length === 14 ? doc : null,
      email: loginEmail,
      phone: phone || null,
      whatsapp: phone || null,
      city,
      state,
      active: true,
      ...(role === 'SUPPLIER' ? { profile: { categories } } : {}),
    };
    const { company } = await call(base, '/companies', { method: 'POST', token, body: companyBody }, 'criação da empresa');
    if (!company?.id) throw new ProvisionError('Emptra: criação da empresa não devolveu id');

    // 4) Usuário já liberado (ACTIVE) com o perfil escolhido.
    const tempPassword = generateTempPassword();
    let user;
    try {
      ({ user } = await call(base, '/admin/users', {
        method: 'POST',
        token,
        body: {
          name: String(input.responsible).trim(),
          email: loginEmail,
          password: tempPassword,
          role,
          phone: phone || undefined,
          jobTitle: 'Responsável',
          companyId: company.id,
          status: 'ACTIVE',
        },
      }, 'criação do usuário'));
    } catch (err) {
      try { await call(base, `/companies/${encodeURIComponent(company.id)}`, { method: 'DELETE', token }, 'rollback da empresa'); } catch { /* equipe vê o erro */ }
      throw err;
    }

    return {
      mode: 'auto',
      loginUrl,
      loginEmail,
      tempPassword,
      profile,
      notes: `Empresa (${profile}) e usuário liberado criados no Emptra.`,
      externalIds: { companyId: company.id, userId: user?.id ?? null },
    };
  } finally {
    // Encerra a sessão do admin (melhor esforço).
    if (session?.refreshToken) {
      await call(base, '/auth/logout', { method: 'POST', body: { refreshToken: session.refreshToken } }, 'logout').catch(() => {});
    }
  }
}

export default provision;
