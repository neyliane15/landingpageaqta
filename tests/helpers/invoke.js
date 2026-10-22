// Chama um handler serverless (formato Vercel) diretamente, sem HTTP — útil para simular uma "outra instância"
// importando o módulo de novo (importProject(..., { fresh: true })).
export async function invoke(handler, { method = 'GET', query = {}, body, headers = {} } = {}) {
  const req = { method, query, body, headers: { host: 'localhost', ...headers }, socket: { remoteAddress: '127.0.0.1' } };
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    end(chunk) { if (chunk) this.body += chunk; this.ended = true; },
  };
  await handler(req, res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* texto */ }
  return { status: res.statusCode, headers: res.headers, body: json, text: res.body };
}
