// Sobe o servidor local (server.js → createServer) numa porta livre, dentro do processo do teste.
// Uso:
//   const srv = await startServer({ env: { AQTA_WHATSAPP: '5521988887777' } });
//   const r = await srv.request('/api/catalog');
//   after(() => srv.close());
//
// O ambiente é controlado: TODAS as variáveis conhecidas são zeradas ('' — o server.js não sobrescreve variáveis
// já definidas com o conteúdo de um .env local) e depois recebem os overrides. Padrão = modo demo.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** fetch original, capturado antes de qualquer mock (os testes falam com o servidor por ele). */
export const realFetch = globalThis.fetch;

export const ENV_KEYS = [
  'PUBLIC_BASE_URL', 'MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET', 'AQTA_TOKEN_SECRET', 'AQTA_NOTIFY_WEBHOOK',
  'AQTA_WHATSAPP', 'OBTRA_SUPABASE_URL', 'OBTRA_SUPABASE_SERVICE_KEY', 'OBTRA_APP_URL', 'EMPTRA_API_URL',
  'EMPTRA_ADMIN_EMAIL', 'EMPTRA_ADMIN_PASSWORD', 'EMPTRA_APP_URL',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
];

/** Zera as variáveis conhecidas e aplica os overrides. Devolve uma função que restaura o estado anterior. */
export function applyEnv(overrides = {}) {
  const before = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) process.env[k] = '';
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  return () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** Altera algumas variáveis temporariamente (sem zerar as outras). Devolve restore(). */
export function patchEnv(overrides) {
  const before = Object.fromEntries(Object.keys(overrides).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  return () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** Importa um módulo do projeto (caminho relativo à raiz). fresh=true ⇒ nova instância (estado de módulo zerado). */
export async function importProject(rel, { fresh = false } = {}) {
  const href = pathToFileURL(path.join(ROOT, rel)).href;
  return import(fresh ? `${href}?fresh=${Date.now()}-${Math.random()}` : href);
}

export async function startServer({ env = {} } = {}) {
  applyEnv(env);
  const { createServer } = await importProject('server.js');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function request(p, { method = 'GET', body, headers = {}, raw = false, json = true } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (body !== undefined) {
      if (typeof body === 'string' || body instanceof Uint8Array) {
        init.body = body;
      } else {
        init.body = JSON.stringify(body);
        if (!Object.keys(init.headers).some((h) => h.toLowerCase() === 'content-type')) {
          init.headers['Content-Type'] = 'application/json';
        }
      }
    }
    const res = await realFetch(base + p, init);
    const text = await res.text();
    let data = text;
    if (json && !raw) {
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    }
    return { status: res.status, headers: res.headers, body: data, text };
  }

  async function close() {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return { base, port, server, request, close };
}
