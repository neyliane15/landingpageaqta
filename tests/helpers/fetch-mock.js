// Substitui globalThis.fetch dentro do processo do teste (o servidor roda no mesmo processo, então as chamadas
// que lib/mercadopago.js faz ao Mercado Pago passam por aqui). URLs não tratadas vão para o fetch real
// (ex.: notificação para o servidor local de captura).
import { realFetch } from './server.js';

/**
 * @param {(url: URL, init: object, call: object) => (Response|object|undefined|Promise<...>)} handler
 *   Devolva um Response, ou { status, json } (atalho), ou undefined para repassar ao fetch real.
 * @returns {{ calls: Array<{url:string, method:string, headers:object, body:any}>, restore: () => void }}
 */
export function installFetchMock(handler) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    let body = init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* texto */ } }
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    const call = { url: url.href, method: (init.method || 'GET').toUpperCase(), headers, body };
    calls.push(call);
    const out = await handler(url, init, call);
    if (out === undefined) return realFetch(input, init);
    if (out instanceof Response) return out;
    if (out instanceof Error) throw out;
    return new Response(out.json !== undefined ? JSON.stringify(out.json) : out.text ?? '', {
      status: out.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return {
    calls,
    restore() { globalThis.fetch = realFetch; },
  };
}

/** Pagamento no formato da API do Mercado Pago (GET /v1/payments/:id). */
export function mpPayment(overrides = {}) {
  return {
    id: 123456789,
    status: 'approved',
    status_detail: 'accredited',
    currency_id: 'BRL',
    transaction_amount: 200,
    external_reference: 'aqta:obtra:basico:11111111-2222-3333-4444-555555555555',
    payment_type_id: 'bank_transfer',
    payment_method_id: 'pix',
    payer: { email: 'payer@example.com', first_name: 'Maria', last_name: 'Silva', identification: { type: 'CPF', number: '52998224725' } },
    metadata: {
      product: 'obtra',
      plan: 'basico',
      customer_name: 'Maria Silva',
      customer_email: 'maria@example.com',
      customer_whatsapp: '21987654321',
      customer_document: '52998224725',
      customer_company: 'Construtora Teste',
    },
    ...overrides,
  };
}
