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
// - Erros: { error: { code, message, details? } } (middlewares/error.ts):
//   Zod ⇒ 422 VALIDATION_ERROR (details: [{ field, message }]); P2002 (único) ⇒ 409 CONFLICT
//   "Já existe um registro com este <campo>" (email em users, cnpj em companies); AppError ⇒ status próprio.
// - E-mail: z.string().email() do Zod 3.23 (companies.routes.ts, admin.routes.ts) — a landing valida com a mesma regra.
// - Fornecedor: supplierProfile.categories é String[] com os NOMES das categorias do catálogo
//   (backend/src/data/catalogo.ts; o cadastro do app grava c.name). Busca por categoria usa `has` (igualdade exata).
// - Login do app: rota `/entrar` (frontend/src/App.tsx).

import { randomInt } from 'node:crypto';
import { PRODUCTS } from '../catalog.js';
import { isDemo } from '../http.js';

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

/** Categorias do catálogo do Emptra [slug, nome] (backend/src/data/catalogo.ts). O backend grava o NOME. */
export const EMPTRA_CATEGORIES = [
  ['cimento-cal-argamassas', 'Cimento, cal e argamassas'],
  ['agregados-britas', 'Agregados e britas'],
  ['blocos-alvenaria', 'Blocos e alvenaria'],
  ['concreto-artefatos', 'Concreto e artefatos'],
  ['aco-ferragens-estruturais', 'Aço e ferragens estruturais'],
  ['madeiras-formas', 'Madeiras e formas'],
  ['impermeabilizacao', 'Impermeabilização'],
  ['cobertura-telhados', 'Cobertura e telhados'],
  ['revestimentos-ceramicos', 'Revestimentos cerâmicos e porcelanatos'],
  ['pedras-bancadas', 'Pedras naturais e bancadas'],
  ['pisos-vinilicos-laminados', 'Pisos vinílicos, laminados e carpetes'],
  ['tintas-vernizes', 'Tintas e vernizes'],
  ['gesso-drywall-forros', 'Gesso, drywall e forros'],
  ['esquadrias', 'Esquadrias de alumínio, PVC e madeira'],
  ['vidros-espelhos', 'Vidros e espelhos'],
  ['hidraulica', 'Hidráulica — tubos e conexões'],
  ['loucas-metais', 'Louças, metais e acessórios'],
  ['eletrica', 'Elétrica — cabos, eletrodutos e quadros'],
  ['iluminacao', 'Iluminação'],
  ['climatizacao', 'Climatização e exaustão'],
  ['automacao-seguranca', 'Automação e segurança'],
  ['ferragens-fixacao', 'Ferragens, fixação e fechaduras'],
  ['ferramentas-equipamentos', 'Ferramentas e equipamentos'],
  ['epi-seguranca', 'EPI e segurança do trabalho'],
  ['paisagismo-externas', 'Paisagismo e áreas externas'],
  ['marcenaria-mobiliario', 'Marcenaria e mobiliário fixo'],
  ['sinalizacao-acessibilidade', 'Sinalização e acessibilidade'],
];
const CATEGORY_BY_KEY = new Map();
for (const [slug, name] of EMPTRA_CATEGORIES) {
  CATEGORY_BY_KEY.set(slug, name);
  CATEGORY_BY_KEY.set(name.toLocaleLowerCase('pt-BR'), name);
}

/** Converte slugs ou nomes (qualquer caixa) nos nomes oficiais; descarta desconhecidos e repetidos. */
export function normalizeCategories(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list.slice(0, 40)) {
    const name = CATEGORY_BY_KEY.get(String(c ?? '').trim().toLocaleLowerCase('pt-BR'));
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Classifica um erro HTTP da API do Emptra. */
export function classifyEmptraError(status, msg) {
  if (status === 409 && /e-?mail/i.test(msg)) return 'email_exists';
  if (status === 409 && /cnpj/i.test(msg)) return 'company_exists';
  if (status === 409) return 'conflict';
  if (status === 422) return 'validation';
  if (status === 401 || status === 403) return 'admin_auth';
  return 'provision_failed';
}

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
    const details = Array.isArray(data?.error?.details)
      ? data.error.details.map((d) => `${d?.field ?? '?'}: ${d?.message ?? ''}`).join('; ').slice(0, 300)
      : '';
    const err = new ProvisionError(`Emptra: ${what} falhou (${res.status}): ${msg}${details ? ` [${details}]` : ''}`, classifyEmptraError(res.status, msg), res.status);
    if (details) err.details = details;
    throw err;
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
  // Defesa em profundidade (REV-1): no modo demo nunca cria nada real, mesmo com credenciais configuradas.
  if (isDemo()) {
    return { mode: 'demo', loginUrl, loginEmail, profile, notes: 'Demonstração: nenhuma conta foi criada.' };
  }
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
    const categories = normalizeCategories(input.extra?.categories);
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
      notes: role === 'SUPPLIER' && !categories.length
        ? 'Empresa (fornecedor) e usuário liberado criados no Emptra. Envie à equipe Aqta as categorias de material que você fornece: sem elas sua empresa não aparece nas buscas por categoria das cotações.'
        : `Empresa (${profile}) e usuário liberado criados no Emptra.`,
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
