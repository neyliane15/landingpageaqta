// Servidores falsos que imitam as APIs usadas por lib/provision/obtra.js (Supabase REST/RPC) e
// lib/provision/emptra.js (API Express do Emptra). Guardam estado em memória e registram cada chamada.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

function reply(res, status, body) {
  res.statusCode = status;
  if (body === undefined) return res.end();
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

// Regex de z.string().email() do Zod 3.23 (versão do backend do Emptra).
export const ZOD_EMAIL = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const closer = (server) => () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });

/**
 * Supabase do Obtra.
 * @param {{ serviceKey?: string, existingEmails?: string[], failRpc?: {status:number, body:any}, failEmpresa?: {status:number, body:any} }} opts
 */
export async function startObtraMock(opts = {}) {
  const serviceKey = opts.serviceKey ?? 'sb_secret_test_key';
  const state = {
    calls: [],
    empresas: new Map(),
    usuarios: [],
    perfis: new Set((opts.existingEmails || []).map((e) => e.toLowerCase())),
    opts,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readJson(req);
    state.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    if (req.headers.apikey !== serviceKey) return reply(res, 401, { message: 'Invalid API key' });

    if (req.method === 'GET' && url.pathname === '/rest/v1/perfis') {
      const email = (url.searchParams.get('email') || '').replace(/^eq\./, '');
      return reply(res, 200, state.perfis.has(email) ? [{ id: randomUUID() }] : []);
    }
    if (req.method === 'POST' && url.pathname === '/rest/v1/empresas') {
      if (state.opts.failEmpresa) return reply(res, state.opts.failEmpresa.status, state.opts.failEmpresa.body);
      if (!body?.nome) return reply(res, 400, { code: '23502', message: 'null value in column "nome" of relation "empresas" violates not-null constraint' });
      if (body.uf != null && String(body.uf).length !== 2) return reply(res, 400, { code: '23514', message: 'new row for relation "empresas" violates check constraint "empresas_uf_check"' });
      const id = randomUUID();
      state.empresas.set(id, body);
      return reply(res, 201, [{ id }]);
    }
    if (req.method === 'DELETE' && url.pathname === '/rest/v1/empresas') {
      const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
      state.empresas.delete(id);
      return reply(res, 204);
    }
    if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/admin_criar_usuario') {
      if (state.opts.failRpc) return reply(res, state.opts.failRpc.status, state.opts.failRpc.body);
      // Mesmas checagens e códigos de admin_criar_usuario (instalar.sql): 22023 ⇒ PostgREST 400; 23505 ⇒ 409.
      const b = body || {};
      const email = String(b.p_email ?? '').trim().toLowerCase();
      const bad = (message) => reply(res, 400, { code: '22023', details: null, hint: null, message });
      if (!['master', 'admin', 'colaborador', 'cliente'].includes(b.p_papel)) return bad('Papel inválido');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad('E-mail inválido');
      if (String(b.p_senha ?? '').length < 6) return bad('A senha deve ter pelo menos 6 caracteres');
      if (!String(b.p_nome ?? '').trim()) return bad('Informe o nome');
      if (!state.empresas.has(b.p_empresa_id)) return bad('Empresa não encontrada');
      if (state.perfis.has(email)) return reply(res, 409, { code: '23505', details: null, hint: null, message: 'E-mail já cadastrado' });
      const id = randomUUID();
      state.perfis.add(String(b.p_email).toLowerCase());
      state.usuarios.push({ id, ...b });
      return reply(res, 200, id);
    }
    return reply(res, 404, { message: 'not found' });
  });
  const url = await listen(server);
  return { url, serviceKey, state, close: closer(server) };
}

/**
 * API do Emptra.
 * @param {{ adminEmail?: string, adminPassword?: string, adminRole?: string, existingEmails?: string[],
 *           failUser?: {status:number, body:any}, failCompany?: {status:number, body:any} }} opts
 */
export async function startEmptraMock(opts = {}) {
  const adminEmail = opts.adminEmail ?? 'admin@emptra.test';
  const adminPassword = opts.adminPassword ?? 'admin-password-123';
  const token = `tok_${randomUUID()}`;
  const refresh = `ref_${randomUUID()}`;
  const state = {
    calls: [],
    companies: new Map(),
    users: (opts.existingEmails || []).map((email) => ({ id: randomUUID(), email })),
    loggedOut: false,
    opts,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readJson(req);
    state.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    // Formato real (backend/src/middlewares/error.ts): Zod ⇒ 422 VALIDATION_ERROR com details; P2002 ⇒ 409 CONFLICT
    // "Já existe um registro com este <campo>"; AppError ⇒ status próprio.
    const err = (status, code, message, details) => reply(res, status, { error: { code, message, ...(details ? { details } : {}) } });
    const zod = (issues) => err(422, 'VALIDATION_ERROR', 'Dados inválidos', issues);

    if (req.method === 'POST' && url.pathname === '/auth/login') {
      if (body?.email !== adminEmail || body?.password !== adminPassword) return err(401, 'INVALID_CREDENTIALS', 'Credenciais inválidas');
      return reply(res, 200, { accessToken: token, refreshToken: refresh, user: { id: 'adm', email: adminEmail, role: state.opts.adminRole ?? 'ADMIN' } });
    }
    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      if (body?.refreshToken === refresh) state.loggedOut = true;
      return reply(res, 204);
    }
    if (req.headers.authorization !== `Bearer ${token}`) return err(401, 'UNAUTHORIZED', 'Token ausente');

    if (req.method === 'GET' && url.pathname === '/admin/users') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const data = state.users.filter((u) => u.email.toLowerCase().includes(q));
      return reply(res, 200, { data, meta: { total: data.length, page: 1, perPage: 20, pages: 1 } });
    }
    if (req.method === 'POST' && url.pathname === '/companies') {
      if (state.opts.failCompany) return reply(res, state.opts.failCompany.status, state.opts.failCompany.body);
      const b = body || {};
      const issues = [];
      if (!['BUYER', 'SUPPLIER'].includes(b.type)) issues.push({ field: 'type', message: 'Invalid enum value' });
      if (typeof b.name !== 'string' || b.name.length < 2) issues.push({ field: 'name', message: 'String must contain at least 2 character(s)' });
      if (b.email != null && !ZOD_EMAIL.test(String(b.email))) issues.push({ field: 'email', message: 'Invalid email' });
      if (b.state != null && String(b.state).length > 2) issues.push({ field: 'state', message: 'String must contain at most 2 character(s)' });
      if (b.profile?.categories !== undefined && (!Array.isArray(b.profile.categories) || b.profile.categories.some((c) => typeof c !== 'string'))) {
        issues.push({ field: 'profile.categories', message: 'Expected array of strings' });
      }
      if (issues.length) return zod(issues);
      const cnpj = String(b.cnpj ?? '').replace(/\D/g, '') || null;
      if (cnpj && [...state.companies.values()].some((c) => c.cnpj === cnpj)) return err(409, 'CONFLICT', 'Já existe um registro com este cnpj');
      const id = randomUUID();
      const company = { ...b, cnpj };
      state.companies.set(id, company);
      return reply(res, 201, { company: { id, ...company } });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/companies/')) {
      state.companies.delete(decodeURIComponent(url.pathname.split('/')[2]));
      return reply(res, 204);
    }
    if (req.method === 'POST' && url.pathname === '/admin/users') {
      if (state.opts.failUser) return reply(res, state.opts.failUser.status, state.opts.failUser.body);
      const b = body || {};
      const issues = [];
      if (typeof b.name !== 'string' || b.name.length < 3) issues.push({ field: 'name', message: 'String must contain at least 3 character(s)' });
      if (typeof b.email !== 'string' || !ZOD_EMAIL.test(b.email)) issues.push({ field: 'email', message: 'Invalid email' });
      if (typeof b.password !== 'string' || b.password.length < 8) issues.push({ field: 'password', message: 'String must contain at least 8 character(s)' });
      if (!['ADMIN', 'BUYER', 'SUPPLIER'].includes(b.role)) issues.push({ field: 'role', message: 'Invalid enum value' });
      if (b.companyId != null && !UUID.test(String(b.companyId))) issues.push({ field: 'companyId', message: 'Invalid uuid' });
      if (b.status !== undefined && !['PENDING', 'ACTIVE', 'SUSPENDED'].includes(b.status)) issues.push({ field: 'status', message: 'Invalid enum value' });
      if (issues.length) return zod(issues);
      if (b.role !== 'ADMIN' && !b.companyId) return err(400, 'BAD_REQUEST', 'Compradores e fornecedores precisam estar vinculados a uma empresa');
      if (b.companyId && !state.companies.has(b.companyId)) return err(409, 'CONFLICT', 'Registro vinculado a outros dados e não pode ser removido');
      const email = b.email.toLowerCase().trim();
      if (state.users.some((u) => u.email.toLowerCase() === email)) return err(409, 'CONFLICT', 'Já existe um registro com este email');
      const user = { id: randomUUID(), ...b, email, status: b.status ?? 'ACTIVE' };
      state.users.push(user);
      return reply(res, 201, { user: { id: user.id, email: user.email, role: user.role, status: user.status } });
    }
    return err(404, 'NOT_FOUND', 'Rota não encontrada');
  });
  const url = await listen(server);
  return { url, adminEmail, adminPassword, state, close: closer(server) };
}
