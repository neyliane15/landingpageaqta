// Servidor falso da API REST do Upstash Redis (o que a Vercel KV / Upstash do Marketplace expõe).
// Formato real: POST <url> com corpo JSON ["SET","k","v","NX","EX","60"] → { result } | 400 { error };
// POST <url>/pipeline com [[...],[...]] → [{ result } | { error }, ...]. Autenticação: Authorization: Bearer <token>.
// Implementa só os comandos usados por lib/store.js: SET (NX/EX), GET, DEL, LPUSH, LTRIM, LRANGE.
import http from 'node:http';

export async function startUpstashMock({ token = 'upstash-test-token' } = {}) {
  const state = { calls: [], data: new Map(), lists: new Map(), opts: { down: false } };

  function exec(cmd) {
    if (!Array.isArray(cmd) || !cmd.length) return { error: 'ERR invalid command' };
    if (cmd.some((a) => typeof a !== 'string')) return { error: 'ERR arguments must be strings' }; // lib manda tudo como string
    const [name, ...args] = cmd;
    const now = Date.now();
    const live = (k) => {
      const e = state.data.get(k);
      if (e && e.exp && e.exp <= now) { state.data.delete(k); return undefined; }
      return e;
    };
    switch (name.toUpperCase()) {
      case 'SET': {
        const [k, v, ...rest] = args;
        let nx = false; let exp = null;
        for (let i = 0; i < rest.length; i++) {
          const o = rest[i].toUpperCase();
          if (o === 'NX') nx = true;
          else if (o === 'EX') exp = now + Number(rest[++i]) * 1000;
          else return { error: `ERR syntax error (${o})` };
        }
        if (nx && live(k)) return { result: null };
        state.data.set(k, { v, exp });
        return { result: 'OK' };
      }
      case 'GET': return { result: live(args[0])?.v ?? null };
      case 'DEL': return { result: state.data.delete(args[0]) ? 1 : 0 };
      case 'LPUSH': {
        const l = state.lists.get(args[0]) || [];
        l.unshift(...args.slice(1).reverse());
        state.lists.set(args[0], l);
        return { result: l.length };
      }
      case 'LTRIM': {
        const l = state.lists.get(args[0]) || [];
        state.lists.set(args[0], l.slice(Number(args[1]), Number(args[2]) + 1));
        return { result: 'OK' };
      }
      case 'LRANGE': {
        const l = state.lists.get(args[0]) || [];
        const end = Number(args[2]);
        return { result: l.slice(Number(args[1]), end < 0 ? l.length + end + 1 : end + 1) };
      }
      default: return { error: `ERR unknown command '${name}'` };
    }
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* inválido */ }
    const url = new URL(req.url, 'http://x');
    state.calls.push({ method: req.method, path: url.pathname, body });
    const reply = (status, obj) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
    if (state.opts.down) return reply(500, { error: 'ERR service unavailable' });
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'Unauthorized' });
    if (req.method !== 'POST') return reply(405, { error: 'method not allowed' });
    if (url.pathname === '/pipeline') {
      if (!Array.isArray(body)) return reply(400, { error: 'ERR invalid pipeline' });
      return reply(200, body.map(exec));
    }
    if (url.pathname === '/') {
      const out = exec(body);
      return reply(out.error ? 400 : 200, out);
    }
    return reply(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    token,
    state,
    env: { KV_REST_API_URL: url, KV_REST_API_TOKEN: token },
    /** valor JSON decodificado de uma chave */
    value(key) { const e = state.data.get(key); return e ? JSON.parse(e.v) : null; },
    /** registros JSON de uma lista (mais recente primeiro) */
    list(key) { return (state.lists.get(key) || []).map((s) => JSON.parse(s)); },
    put(key, obj, ttlS) { state.data.set(key, { v: JSON.stringify(obj), exp: ttlS ? Date.now() + ttlS * 1000 : null }); },
    clear() { state.data.clear(); state.lists.clear(); state.calls.length = 0; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
