// Servidor HTTP local que registra os POSTs recebidos — usado como AQTA_NOTIFY_WEBHOOK.
import http from 'node:http';

export async function startCaptureServer({ status = 200 } = {}) {
  const requests = [];
  const waiters = [];
  const state = { status };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = raw;
    try { body = JSON.parse(raw); } catch { /* texto */ }
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    for (const w of waiters.splice(0)) w();
    res.statusCode = state.status;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/hook`;

  /** Espera até existir um evento que satisfaça `pred` (ou estoura em `timeout` ms). */
  async function waitFor(pred = () => true, timeout = 3000) {
    const start = Date.now();
    for (;;) {
      const found = requests.find((r) => pred(r.body, r));
      if (found) return found;
      if (Date.now() - start > timeout) throw new Error('captura: evento esperado não chegou');
      await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  }

  return {
    url,
    requests,
    events: (name) => requests.filter((r) => r.body?.event === name).map((r) => r.body),
    setStatus: (s) => { state.status = s; },
    clear: () => { requests.length = 0; },
    waitFor,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
