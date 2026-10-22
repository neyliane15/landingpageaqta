import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, patchEnv } from '../helpers/server.js';
import { installFetchMock, mpPayment } from '../helpers/fetch-mock.js';
import { startCaptureServer } from '../helpers/capture.js';

const SECRET = 'webhook-secret-de-teste';
let srv;
let cap;
let mock;
const payments = new Map(); // id → payment | status number
let nextId = 900000;

before(async () => {
  cap = await startCaptureServer();
  srv = await startServer({ env: { MP_ACCESS_TOKEN: 'APP_USR-test', AQTA_TOKEN_SECRET: 'w'.repeat(48), MP_WEBHOOK_SECRET: SECRET, AQTA_NOTIFY_WEBHOOK: cap.url } });
  mock = installFetchMock((url) => {
    if (url.hostname !== 'api.mercadopago.com') return undefined;
    const id = url.pathname.split('/').pop();
    const p = payments.get(id);
    if (p === undefined) return { status: 404, json: { message: 'Payment not found' } };
    if (typeof p === 'number') return { status: p, json: { message: 'erro' } };
    return { status: 200, json: p };
  });
});
after(async () => { mock.restore(); await srv.close(); await cap.close(); });
beforeEach(() => cap.clear());

function newPayment(overrides = {}) {
  const id = String(nextId++);
  payments.set(id, mpPayment({ id: Number(id), ...overrides }));
  return id;
}

function sign(dataId, requestId, ts = String(Math.floor(Date.now() / 1000)), secret = SECRET) {
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  return `ts=${ts},v1=${crypto.createHmac('sha256', secret).update(manifest).digest('hex')}`;
}

async function notify(id, { signature, requestId = crypto.randomUUID(), type = 'payment', body, query } = {}) {
  const q = query ?? `?data.id=${id}&type=${type}`;
  const headers = { 'x-request-id': requestId };
  const sig = signature === undefined ? sign(id, requestId) : signature;
  if (sig) headers['x-signature'] = sig;
  return srv.request(`/api/webhook${q}`, {
    method: 'POST', headers,
    body: body ?? { action: 'payment.updated', api_version: 'v1', type, data: { id: String(id) }, live_mode: true },
  });
}

const settle = () => new Promise((r) => setTimeout(r, 150));

describe('assinatura x-signature', () => {
  test('assinatura correta + pagamento aprovado ⇒ 200 e notifica a equipe (payment.approved)', async () => {
    const id = newPayment();
    const r = await notify(id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, 'approved');
    const ev = (await cap.waitFor((b) => b.event === 'payment.approved' && b.paymentId === id)).body;
    assert.equal(ev.product, 'obtra');
    assert.equal(ev.amountCents, 20000);
    assert.equal(ev.externalReference, 'aqta:obtra:basico:11111111-2222-3333-4444-555555555555');
    assert.equal(ev.customer.email, 'maria@example.com');
    assert.equal(ev.source, 'landing-aqta');
    assert.match(ev.text, /Pagamento aprovado/);
  });

  test('assinatura incorreta ⇒ 401 e não consulta o MP nem notifica', async () => {
    const id = newPayment();
    const calls = mock.calls.length;
    const bad = [
      sign(id, 'outro-request-id'),
      sign(Number(id) + 1, 'rid'),
      sign(id, 'rid', '123', 'segredo-errado'),
      'ts=1,v1=' + 'a'.repeat(64),
      'ts=1,v1=xyz',
      'v1=' + 'a'.repeat(64),
      'lixo',
    ];
    for (const signature of bad) {
      const r = await notify(id, { signature, requestId: 'rid' });
      assert.equal(r.status, 401, signature);
      assert.equal(r.body.error, 'invalid_signature');
    }
    assert.equal(mock.calls.length, calls);
    await settle();
    assert.equal(cap.requests.length, 0);
  });

  test('assinatura ausente ⇒ 401', async () => {
    const id = newPayment();
    const r = await notify(id, { signature: '' });
    assert.equal(r.status, 401);
  });

  test('assinatura válida mas corpo com outro data.id não engana (usa o data.id da query assinado)', async () => {
    const id = newPayment();
    const other = newPayment();
    const rid = 'r-1';
    const r = await notify(id, { requestId: rid, signature: sign(id, rid), body: { type: 'payment', data: { id: other } } });
    assert.equal(r.status, 200);
    const ev = await cap.waitFor((b) => b.event === 'payment.approved');
    assert.equal(ev.body.paymentId, id);
  });

  test('sem MP_WEBHOOK_SECRET a assinatura não é exigida (aviso no log) — a verdade vem do MP', async () => {
    const restore = patchEnv({ MP_WEBHOOK_SECRET: '' });
    try {
      const id = newPayment();
      const r = await notify(id, { signature: '' });
      assert.equal(r.status, 200);
    } finally { restore(); }
  });
});

describe('tipos e status', () => {
  for (const type of ['merchant_order', 'subscription_preapproval', 'point_integration_wh', '']) {
    test(`type="${type}" ⇒ 200 ignorado sem consultar o MP`, async () => {
      const id = newPayment();
      const calls = mock.calls.length;
      const r = await notify(id, { type, query: `?data.id=${id}${type ? `&type=${type}` : ''}`, body: { type, data: { id } } });
      assert.equal(r.status, 200);
      assert.ok(r.body.ignored);
      assert.equal(mock.calls.length, calls);
    });
  }

  test('IPN legado (?topic=payment&id=...) é processado', async () => {
    const restore = patchEnv({ MP_WEBHOOK_SECRET: '' });
    try {
      const id = newPayment();
      const r = await srv.request(`/api/webhook?topic=payment&id=${id}`, { method: 'POST' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.status, 'approved');
    } finally { restore(); }
  });

  test('id inválido ⇒ 200 ignorado', async () => {
    const r = await notify('abc');
    assert.equal(r.status, 200);
    assert.equal(r.body.ignored, 'invalid_id');
  });

  test('pagamento pendente ⇒ 200 sem notificar', async () => {
    const id = newPayment({ status: 'pending' });
    const r = await notify(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'pending');
    await settle();
    assert.equal(cap.events('payment.approved').length, 0);
  });

  test('pagamento inexistente (teste do painel) ou não-Aqta ⇒ 200 ignorado', async () => {
    const r = await notify('123');
    assert.equal(r.status, 200);
    assert.ok(r.body.ignored);
    const id = newPayment({ external_reference: 'outra-loja-1' });
    const r2 = await notify(id);
    assert.equal(r2.status, 200);
    assert.ok(r2.body.ignored);
    await settle();
    assert.equal(cap.requests.length, 0);
  });

  test('valor menor que o catálogo ⇒ 200 ignorado, sem notificar', async () => {
    const id = newPayment({ transaction_amount: 1 });
    const r = await notify(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.ignored, 'invalid_payment');
  });

  test('falha transitória do MP (500) ⇒ 500 para o MP re-tentar', async () => {
    const id = String(nextId++);
    payments.set(id, 500);
    const r = await notify(id);
    assert.equal(r.status, 500);
  });

  test('mesmo pagamento aprovado notificado 2x ⇒ equipe avisada 1x (mesma instância)', async () => {
    const id = newPayment();
    assert.equal((await notify(id)).status, 200);
    assert.equal((await notify(id)).status, 200);
    await settle();
    assert.equal(cap.events('payment.approved').filter((e) => e.paymentId === id).length, 1);
  });

  test('webhook da equipe fora do ar (500) não afeta a resposta ao MP', async () => {
    cap.setStatus(500);
    try {
      const id = newPayment();
      const r = await notify(id);
      assert.equal(r.status, 200);
    } finally { cap.setStatus(200); }
  });

  test('modo demo ⇒ 200 ignorado', async () => {
    const restore = patchEnv({ MP_ACCESS_TOKEN: '' });
    try {
      const r = await notify('1');
      assert.equal(r.status, 200);
      assert.equal(r.body.ignored, 'demo_mode');
    } finally { restore(); }
  });

  test('GET ⇒ 405', async () => {
    const r = await srv.request('/api/webhook');
    assert.equal(r.status, 405);
  });
});
