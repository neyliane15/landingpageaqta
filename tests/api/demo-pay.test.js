import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, patchEnv, importProject } from '../helpers/server.js';
import { demoCheckout, decodeToken, signTokenAt } from '../helpers/fixtures.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

test('GET /api/demo-pay?ref= devolve o resumo verificado do pedido (sem documento)', async () => {
  const co = await demoCheckout(srv, 'emptra');
  const r = await srv.request(`/api/demo-pay?ref=${encodeURIComponent(co.token)}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.product, 'emptra');
  assert.equal(r.body.productName, 'Emptra');
  assert.equal(r.body.planName, 'Plano Básico');
  assert.equal(r.body.amountCents, 30000);
  assert.equal(r.body.amount.replace(/\s/g, ' '), 'R$ 300,00');
  assert.equal(r.body.externalReference, co.external_reference);
  assert.equal(r.body.customer.document, undefined);
  assert.ok(Date.parse(r.body.expiresAt) > Date.now());
});

for (const outcome of ['approved', 'pending', 'rejected']) {
  test(`POST /api/demo-pay outcome=${outcome} ⇒ redirect /obrigado com payment_id demo assinado`, async () => {
    const co = await demoCheckout(srv, 'obtra');
    const r = await srv.request('/api/demo-pay', { method: 'POST', body: { ref: co.token, outcome } });
    assert.equal(r.status, 200, r.text);
    const u = new URL(r.body.redirect, 'http://x');
    assert.equal(u.pathname, '/obrigado');
    assert.equal(u.searchParams.get('status'), outcome);
    assert.equal(u.searchParams.get('external_reference'), co.external_reference);
    const pid = u.searchParams.get('payment_id');
    assert.ok(pid.startsWith('demo_'));
    const t = decodeToken(pid);
    assert.equal(t.t, 'demopay');
    assert.equal(t.status, outcome);
    assert.equal(t.amountCents, 20000);
    assert.equal(t.customer.document, undefined, 'documento não vai na URL');
  });
}

test('outcome inválido ⇒ 400 invalid_outcome', async () => {
  const co = await demoCheckout(srv);
  for (const outcome of [undefined, '', 'APPROVED', 'refunded', 'approved ', { a: 1 }]) {
    const r = await srv.request('/api/demo-pay', { method: 'POST', body: { ref: co.token, outcome } });
    // 'approved ' é aparado (trim) e aceito
    if (outcome === 'approved ') { assert.equal(r.status, 200); continue; }
    assert.equal(r.status, 400, String(outcome));
    assert.equal(r.body.error, 'invalid_outcome');
  }
});

test('ref inválido/adulterado/expirado/de outro tipo ⇒ 400 invalid_ref', async () => {
  const co = await demoCheckout(srv);
  const [b, s] = co.token.split('.');
  const p = decodeToken(co.token); p.amountCents = 1;
  const forged = `${Buffer.from(JSON.stringify(p)).toString('base64url')}.${s}`;
  const expired = await signTokenAt(-7200, { t: 'demo', ref: co.external_reference, product: 'obtra', plan: 'basico', customer: {}, amountCents: 20000 }, 3600);
  const { signToken } = await importProject('lib/token.js');
  const wrongType = signToken({ t: 'access', ref: co.external_reference, product: 'obtra', plan: 'basico', amountCents: 20000 }, 3600);
  const cheap = signToken({ t: 'demo', ref: co.external_reference, product: 'obtra', plan: 'basico', customer: {}, amountCents: 100 }, 3600);
  const badRef = signToken({ t: 'demo', ref: 'outra-loja:123', product: 'obtra', plan: 'basico', customer: {}, amountCents: 20000 }, 3600);
  for (const ref of ['', 'abc', `${b}.x`, forged, expired, wrongType, cheap, badRef, undefined]) {
    const r = await srv.request('/api/demo-pay', { method: 'POST', body: { ref, outcome: 'approved' } });
    assert.equal(r.status, 400, String(ref).slice(0, 20));
    assert.equal(r.body.error, 'invalid_ref');
    const g = await srv.request(`/api/demo-pay?ref=${encodeURIComponent(ref ?? '')}`);
    assert.equal(g.status, 400);
  }
});

test('em produção (MP_ACCESS_TOKEN) o gateway demo responde 404', async () => {
  const co = await demoCheckout(srv);
  const restore = patchEnv({ MP_ACCESS_TOKEN: 'APP_USR-1', AQTA_TOKEN_SECRET: 'z'.repeat(40) });
  try {
    const r = await srv.request('/api/demo-pay', { method: 'POST', body: { ref: co.token, outcome: 'approved' } });
    assert.equal(r.status, 404);
    const g = await srv.request(`/api/demo-pay?ref=${encodeURIComponent(co.token)}`);
    assert.equal(g.status, 404);
  } finally { restore(); }
});

test('métodos não permitidos ⇒ 405', async () => {
  for (const method of ['PUT', 'DELETE']) {
    const r = await srv.request('/api/demo-pay', { method, body: {} });
    assert.equal(r.status, 405);
  }
});
