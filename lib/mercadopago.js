// Cliente REST mínimo do Mercado Pago (Checkout Pro). Zero dependências: fetch nativo.
// Docs: https://www.mercadopago.com.br/developers/pt/reference

const API = 'https://api.mercadopago.com';
const TIMEOUT_MS = 10_000;

function mpError(message, status, details) {
  const err = new Error(message);
  err.status = status;
  if (details !== undefined) err.details = details;
  return err;
}

async function request(method, path, { body, headers = {} } = {}) {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) throw mpError('MP_ACCESS_TOKEN ausente', 500);

  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw mpError(timedOut ? 'Mercado Pago não respondeu a tempo' : `Falha de rede com o Mercado Pago: ${err?.message || err}`,
      timedOut ? 504 : 502);
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  }
  if (!res.ok) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    throw mpError(`Mercado Pago ${method} ${path}: ${msg}`, res.status, data);
  }
  return data;
}

/** Cria uma preferência do Checkout Pro. Retorna o objeto da API (id, init_point, sandbox_init_point...). */
export function createPreference(pref, idempotencyKey) {
  const headers = idempotencyKey ? { 'X-Idempotency-Key': String(idempotencyKey) } : {};
  return request('POST', '/checkout/preferences', { body: pref, headers });
}

/** Consulta um pagamento. Lança Error com status 404 se não existir. */
export function getPayment(id) {
  const clean = String(id ?? '').trim();
  if (!/^\d{1,30}$/.test(clean)) return Promise.reject(mpError('payment_id inválido', 400));
  return request('GET', `/v1/payments/${clean}`);
}
