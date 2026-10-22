import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, patchEnv } from '../helpers/server.js';
import { installFetchMock, mpPayment } from '../helpers/fetch-mock.js';
import { demoPurchase, decodeToken, customer, CNPJ } from '../helpers/fixtures.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

const status = (pid, ref, extra = '') => srv.request(
  `/api/payment-status?payment_id=${encodeURIComponent(pid ?? '')}&external_reference=${encodeURIComponent(ref ?? '')}${extra}`,
);

describe('modo demo', () => {
  test('aprovado ⇒ 200 com resumo, cliente (sem documento completo) e accessToken t=access', async () => {
    const p = await demoPurchase(srv, 'obtra', 'approved', customer({ document: CNPJ }));
    const r = await status(p.paymentId, p.externalReference);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, 'approved');
    assert.equal(r.body.product, 'obtra');
    assert.equal(r.body.productName, 'Obtra');
    assert.equal(r.body.plan, 'basico');
    assert.equal(r.body.amount.replace(/\s/g, ' '), 'R$ 200,00');
    assert.equal(r.body.demo, true);
    assert.equal(r.body.customer.name, 'Maria Teste da Silva');
    assert.equal(r.body.customer.email, 'maria.teste@example.com');
    assert.equal(r.body.customer.company, 'Construtora Teste Ltda');
    assert.equal(r.body.customer.document, undefined, 'documento completo nunca volta');
    assert.doesNotMatch(r.text, /11222333000181/);
    const t = decodeToken(r.body.accessToken);
    assert.equal(t.t, 'access');
    assert.equal(t.product, 'obtra');
    assert.equal(t.ref, p.externalReference);
    assert.equal(t.exp - t.iat, 7 * 86400);
    assert.ok(!r.body.paymentId.includes('.'), 'paymentId público não é o token inteiro');
  });

  test('Emptra aprovado ⇒ R$ 300,00', async () => {
    const p = await demoPurchase(srv, 'emptra', 'approved');
    const r = await status(p.paymentId, p.externalReference);
    assert.equal(r.status, 200);
    assert.equal(r.body.product, 'emptra');
    assert.equal(r.body.amount.replace(/\s/g, ' '), 'R$ 300,00');
  });

  for (const outcome of ['pending', 'rejected']) {
    test(`${outcome} ⇒ 200 sem accessToken`, async () => {
      const p = await demoPurchase(srv, 'obtra', outcome);
      const r = await status(p.paymentId, p.externalReference);
      assert.equal(r.status, 200);
      assert.equal(r.body.status, outcome);
      assert.equal(r.body.accessToken, undefined);
    });
  }

  test('o ?status= da URL é ignorado: pendente continua pendente mesmo com status=approved', async () => {
    const p = await demoPurchase(srv, 'obtra', 'pending');
    const r = await status(p.paymentId, p.externalReference, '&status=approved&collection_status=approved');
    assert.equal(r.body.status, 'pending');
    assert.equal(r.body.accessToken, undefined);
  });

  test('collection_id é aceito como fallback de payment_id', async () => {
    const p = await demoPurchase(srv, 'obtra', 'approved');
    const r = await srv.request(`/api/payment-status?collection_id=${encodeURIComponent(p.paymentId)}&external_reference=${encodeURIComponent(p.externalReference)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'approved');
  });

  test('sem payment_id (ou "null") ⇒ 400 missing_payment_id', async () => {
    for (const q of ['', '?payment_id=', '?payment_id=null&external_reference=aqta:obtra:basico:12345678', '?external_reference=x']) {
      const r = await srv.request(`/api/payment-status${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(r.body.error, 'missing_payment_id');
    }
  });

  test('sem external_reference (ou "null") ⇒ 400 missing_reference', async () => {
    const p = await demoPurchase(srv, 'obtra', 'approved');
    for (const ref of ['', 'null']) {
      const r = await status(p.paymentId, ref);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'missing_reference');
    }
    const r = await srv.request(`/api/payment-status?payment_id=${encodeURIComponent(p.paymentId)}`);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'missing_reference');
  });

  test('external_reference errada (de outro pedido) ⇒ 404 sem dados do cliente', async () => {
    const a = await demoPurchase(srv, 'obtra', 'approved');
    const b = await demoPurchase(srv, 'obtra', 'approved');
    const r = await status(a.paymentId, b.externalReference);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
    assert.equal(r.body.accessToken, undefined);
    assert.doesNotMatch(r.text, /maria/i);
  });

  test('token demo adulterado (status pending→approved) ⇒ 404', async () => {
    const p = await demoPurchase(srv, 'obtra', 'pending');
    const raw = p.paymentId.slice(5);
    const [, sig] = raw.split('.');
    const payload = decodeToken(raw); payload.status = 'approved';
    const forged = `demo_${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    const r = await status(forged, p.externalReference);
    assert.equal(r.status, 404);
  });

  test('token de checkout (t=demo) ou accessToken usados como payment_id ⇒ 404', async () => {
    const p = await demoPurchase(srv, 'obtra', 'approved');
    const s = await status(p.paymentId, p.externalReference);
    for (const pid of [`demo_${p.checkoutToken}`, `demo_${s.body.accessToken}`, s.body.accessToken, 'demo_', 'demo_abc.def']) {
      const r = await status(pid, p.externalReference);
      assert.equal(r.status, 404, pid.slice(0, 20));
    }
  });

  test('id numérico em modo demo (sem MP_ACCESS_TOKEN) ⇒ 404', async () => {
    const r = await status('123456', 'aqta:obtra:basico:11111111-2222-3333-4444-555555555555');
    assert.equal(r.status, 404);
  });

  test('POST ⇒ 405', async () => {
    const r = await srv.request('/api/payment-status', { method: 'POST', body: {} });
    assert.equal(r.status, 405);
  });
});

describe('produção simulada (Mercado Pago via fetch mock)', () => {
  const REF = 'aqta:obtra:basico:11111111-2222-3333-4444-555555555555';
  let restoreEnv;
  let mock;
  let payment;
  let mpStatus;
  before(() => {
    restoreEnv = patchEnv({ MP_ACCESS_TOKEN: 'APP_USR-test', AQTA_TOKEN_SECRET: 'q'.repeat(48) });
    mock = installFetchMock((url) => {
      if (url.hostname !== 'api.mercadopago.com') return undefined;
      if (mpStatus === 'network') return new TypeError('fetch failed');
      if (mpStatus) return { status: mpStatus, json: { message: 'erro do mp' } };
      return { status: 200, json: payment };
    });
  });
  after(() => { mock.restore(); restoreEnv(); });
  const reset = (p = {}, s = null) => { payment = mpPayment(p); mpStatus = s; };

  test('aprovado ⇒ 200 com accessToken, documento mascarado e consulta autenticada ao MP', async () => {
    reset();
    const r = await status('123456789', REF);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, 'approved');
    assert.equal(r.body.demo, false);
    assert.equal(r.body.product, 'obtra');
    assert.equal(r.body.amountCents, 20000);
    assert.equal(r.body.customer.documentMasked, '***.982.***-**');
    assert.doesNotMatch(r.text, /52998224725/);
    assert.ok(r.body.accessToken);
    const t = decodeToken(r.body.accessToken);
    assert.equal(t.paymentId, '123456789');
    const call = mock.calls.at(-1);
    assert.equal(call.url, 'https://api.mercadopago.com/v1/payments/123456789');
    assert.equal(call.headers.authorization, 'Bearer APP_USR-test');
  });

  test('pendente (PIX) ⇒ 200 sem accessToken', async () => {
    reset({ status: 'pending', status_detail: 'pending_waiting_transfer' });
    const r = await status('123456789', REF);
    assert.equal(r.body.status, 'pending');
    assert.equal(r.body.accessToken, undefined);
  });

  test('valor pago menor que o preço do catálogo ⇒ 404 invalid_payment', async () => {
    reset({ transaction_amount: 199.99 });
    const r = await status('123456789', REF);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'invalid_payment');
  });

  test('Emptra pago com valor do Obtra (R$ 200) ⇒ 404', async () => {
    reset({ transaction_amount: 200, external_reference: 'aqta:emptra:basico:11111111-2222-3333-4444-555555555555' });
    const r = await status('123456789', 'aqta:emptra:basico:11111111-2222-3333-4444-555555555555');
    assert.equal(r.status, 404);
  });

  test('moeda diferente de BRL ⇒ 404', async () => {
    reset({ currency_id: 'USD' });
    assert.equal((await status('123456789', REF)).status, 404);
  });

  test('valor não numérico ⇒ 404', async () => {
    reset({ transaction_amount: 'abc' });
    assert.equal((await status('123456789', REF)).status, 404);
  });

  test('external_reference de outra loja / produto inexistente ⇒ 404', async () => {
    for (const ref of ['pedido-123', 'loja:obtra:basico:11111111-2222', 'aqta:xpto:basico:11111111-2222-3333', 'aqta:obtra:premium:11111111-2222-3333', '']) {
      reset({ external_reference: ref });
      const r = await status('123456789', ref || 'x');
      assert.equal(r.status, 404, ref);
    }
  });

  test('external_reference informada diferente da do pagamento ⇒ 404 (anti-enumeração)', async () => {
    reset();
    const r = await status('123456789', 'aqta:obtra:basico:99999999-2222-3333-4444-555555555555');
    assert.equal(r.status, 404);
    assert.equal(r.body.accessToken, undefined);
  });

  test('MP 404 / 400 ⇒ 404; MP 500 / 401 / rede ⇒ 502', async () => {
    for (const [s, expected] of [[404, 404], [400, 404], [500, 502], [401, 502], [503, 502], ['network', 502]]) {
      reset({}, s);
      const r = await status('123456789', REF);
      assert.equal(r.status, expected, String(s));
      assert.doesNotMatch(r.text, /erro do mp/);
    }
  });

  test('payment_id não numérico ou token demo em produção ⇒ 404 sem consultar o MP', async () => {
    reset();
    const before = mock.calls.length;
    for (const pid of ['abc', '12a', '../1', 'demo_abc.def', '1'.repeat(31)]) {
      const r = await status(pid, REF);
      assert.equal(r.status, 404, pid);
    }
    assert.equal(mock.calls.length, before);
  });

  test('aprovado com valor maior que o preço (ex.: R$ 250) é aceito e exibe o valor pago', async () => {
    reset({ transaction_amount: 250 });
    const r = await status('123456789', REF);
    assert.equal(r.status, 200);
    assert.equal(r.body.amountCents, 25000);
  });

  test('aprovado mas sem AQTA_TOKEN_SECRET ⇒ 500 server_misconfigured (não 200 sem token)', async () => {
    reset();
    const restore = patchEnv({ AQTA_TOKEN_SECRET: '' });
    try {
      const r = await status('123456789', REF);
      assert.equal(r.status, 500);
      assert.equal(r.body.error, 'server_misconfigured');
    } finally { restore(); }
  });

  test('cliente vem do metadata; sem metadata cai no payer', async () => {
    reset({ metadata: {} });
    const r = await status('123456789', REF);
    assert.equal(r.status, 200);
    assert.equal(r.body.customer.name, 'Maria Silva');
    assert.equal(r.body.customer.email, 'payer@example.com');
  });
});
