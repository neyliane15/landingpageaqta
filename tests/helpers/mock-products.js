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
      if (!body?.nome) return reply(res, 400, { code: '23502', message: 'null value in column "nome"' });
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
      const b = body || {};
      if (!b.p_email || !b.p_senha || String(b.p_senha).length < 6 || !b.p_nome) return reply(res, 400, { code: 'P0001', message: 'dados inválidos' });
      if (!['master', 'admin', 'colaborador', 'cliente'].includes(b.p_papel)) return reply(res, 400, { code: 'P0001', message: 'papel inválido' });
      if (!state.empresas.has(b.p_empresa_id)) return reply(res, 400, { code: 'P0001', message: 'empresa não encontrada' });
      if (state.perfis.has(String(b.p_email).toLowerCase())) return reply(res, 400, { code: 'P0001', message: 'E-mail já cadastrado' });
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
    const err = (status, code, message) => reply(res, status, { error: { code, message } });

    if (req.method === 'POST' && url.pathname === '/auth/login') {
      if (body?.email !== adminEmail || body?.password !== adminPassword) return err(401, 'INVALID_CREDENTIALS', 'Credenciais inválidas');
      return reply(res, 200, { accessToken: token, refreshToken: refresh, user: { id: 'adm', email: adminEmail, role: opts.adminRole ?? 'ADMIN' } });
    }
    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      if (body?.refreshToken === refresh) state.loggedOut = true;
      return reply(res, 204);
    }
    if (req.headers.authorization !== `Bearer ${token}`) return err(401, 'UNAUTHORIZED', 'Token ausente');

    if (req.method === 'GET' && url.pathname === '/admin/users') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      return reply(res, 200, { data: state.users.filter((u) => u.email.toLowerCase().includes(q)), total: 0 });
    }
    if (req.method === 'POST' && url.pathname === '/companies') {
      if (state.opts.failCompany) return reply(res, state.opts.failCompany.status, state.opts.failCompany.body);
      if (!['BUYER', 'SUPPLIER'].includes(body?.type) || !body?.name) return err(400, 'VALIDATION', 'Dados inválidos');
      if (body.cnpj && [...state.companies.values()].some((c) => c.cnpj === body.cnpj)) return err(409, 'CONFLICT', 'CNPJ já cadastrado');
      const id = randomUUID();
      state.companies.set(id, body);
      return reply(res, 201, { company: { id, ...body } });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/companies/')) {
      state.companies.delete(decodeURIComponent(url.pathname.split('/')[2]));
      return reply(res, 204);
    }
    if (req.method === 'POST' && url.pathname === '/admin/users') {
      if (state.opts.failUser) return reply(res, state.opts.failUser.status, state.opts.failUser.body);
      const b = body || {};
      if (!b.name || String(b.name).length < 3 || !b.email || String(b.password || '').length < 8) return err(400, 'VALIDATION', 'Dados inválidos');
      if (!['BUYER', 'SUPPLIER'].includes(b.role) || !state.companies.has(b.companyId)) return err(400, 'VALIDATION', 'Empresa/perfil inválido');
      if (state.users.some((u) => u.email === b.email)) return err(409, 'CONFLICT', 'E-mail já cadastrado');
      const user = { id: randomUUID(), ...b };
      state.users.push(user);
      return reply(res, 201, { user: { id: user.id, email: user.email, role: user.role, status: user.status } });
    }
    return err(404, 'NOT_FOUND', 'Rota não encontrada');
  });
  const url = await listen(server);
  return { url, adminEmail, adminPassword, state, close: closer(server) };
}
