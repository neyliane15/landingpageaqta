// Utilitários comuns aos handlers em /api (formato Vercel Node: handler(req, res)).

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function allow(req, res, methods) {
  if (methods.includes(req.method)) return true;
  res.setHeader('Allow', methods.join(', '));
  send(res, 405, { error: 'method_not_allowed' });
  return false;
}

/** Lê req.body sem nunca lançar. Na Vercel, `req.body` é um getter que LANÇA com JSON inválido. */
function rawBody(req) {
  try {
    return { value: req.body };
  } catch {
    return { error: 'invalid_json' };
  }
}

/**
 * Corpo como objeto, sem validação de Content-Type (legado / webhook). Nunca lança; JSON inválido ⇒ {}.
 * Para endpoints chamados pelo navegador use `readJson`.
 */
export function body(req) {
  const r = rawBody(req);
  if (r.error) return {};
  let b = r.value;
  if (!b) return {};
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch { return {}; }
  }
  return b && typeof b === 'object' ? b : {};
}

/**
 * Corpo JSON de um POST vindo do navegador. Envia o erro e devolve `null` quando:
 *  - Content-Type não é application/json ⇒ 415 unsupported_media_type
 *    (impede POST "simples" de outro site com text/plain/form, sem preflight de CORS — CSRF/spam);
 *  - corpo maior que `maxChars` ⇒ 413 payload_too_large;
 *  - JSON inválido ou que não é um objeto ⇒ 400 invalid_json.
 * Corpo vazio ⇒ {}. Funciona igual no server.js local (que devolve a string crua se o JSON for inválido) e na
 * Vercel (que lança ao ler req.body).
 */
export function readJson(req, res, { maxChars = 8192 } = {}) {
  const ct = String(req.headers?.['content-type'] || '').toLowerCase();
  if (!/^application\/json\s*(;|$)/.test(ct.trim())) {
    send(res, 415, { error: 'unsupported_media_type', message: 'Envie os dados como application/json.' });
    return null;
  }
  const r = rawBody(req);
  if (r.error) { send(res, 400, { error: 'invalid_json' }); return null; }
  let b = r.value;
  if (b === undefined || b === null || b === '') return {};
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    if (b.length > maxChars) { send(res, 413, { error: 'payload_too_large' }); return null; }
    if (!b.trim()) return {};
    try { b = JSON.parse(b); } catch { send(res, 400, { error: 'invalid_json' }); return null; }
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) { send(res, 400, { error: 'invalid_json' }); return null; }
  let size;
  try { size = JSON.stringify(b).length; } catch { size = Infinity; }
  if (size > maxChars) { send(res, 413, { error: 'payload_too_large' }); return null; }
  return b;
}

export function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

export const isDemo = () => !process.env.MP_ACCESS_TOKEN;

/** Número de WhatsApp de suporte da Aqta (só dígitos) ou null. */
export function supportWhatsapp() {
  const n = String(process.env.AQTA_WHATSAPP ?? '').replace(/\D+/g, '');
  return n.length >= 10 && n.length <= 15 ? n : null;
}
