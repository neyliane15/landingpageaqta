// /obrigado em "produção simulada": o servidor (no processo do teste) consulta um Mercado Pago falso.
// Permite testar a transição pendente → aprovado (polling de 5 s e botão "Já paguei").
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';
import { installFetchMock, mpPayment } from '../helpers/fetch-mock.js';
import { browserSkip, launch, newPage } from '../helpers/browser.js';
import { norm } from '../helpers/e2e-flow.js';

let srv;
let browser;
let mock;
const payments = new Map();
before(async () => {
  if (browserSkip) return;
  srv = await startServer({ env: { MP_ACCESS_TOKEN: 'APP_USR-e2e', AQTA_TOKEN_SECRET: 'e'.repeat(48), AQTA_WHATSAPP: '5521988887777' } });
  mock = installFetchMock((url) => {
    if (url.hostname !== 'api.mercadopago.com') return undefined;
    const p = payments.get(url.pathname.split('/').pop());
    return p ? { status: 200, json: p } : { status: 404, json: { message: 'not found' } };
  });
  browser = await launch();
});
after(async () => { mock?.restore(); await browser?.close(); await srv?.close(); });

const REF = (n) => `aqta:obtra:basico:aaaaaaaa-bbbb-cccc-dddd-${String(n).padStart(12, '0')}`;
const url = (id, ref) => `${srv.base}/obrigado?collection_id=${id}&collection_status=pending&payment_id=${id}&status=pending&external_reference=${encodeURIComponent(ref)}&payment_type=bank_transfer&preference_id=pref-1`;

describe('pendente → aprovado', { skip: browserSkip }, () => {
  test('polling automático avança sozinho para a ativação quando o MP aprova', async () => {
    const id = '7001';
    payments.set(id, mpPayment({ id: 7001, status: 'pending', status_detail: 'pending_waiting_transfer', external_reference: REF(1) }));
    const { page, watch, close } = await newPage(browser, srv.base);
    try {
      await page.goto(url(id, REF(1)));
      await page.locator('#ob-title', { hasText: 'Estamos aguardando' }).waitFor();
      // PIX: não mostra o bloco de boleto
      const methods = norm(await page.locator('.ob-methods').textContent());
      assert.match(methods, /PIX/);
      assert.doesNotMatch(methods, /Boleto/);
      payments.get(id).status = 'approved';
      await page.locator('#ob-title', { hasText: 'Pagamento confirmado' }).waitFor({ timeout: 9000 });
      await page.locator('#ob-form').waitFor();
      assert.equal(await page.inputValue('#f-company'), 'Construtora Teste');
      assert.deepEqual(watch.pageErrors, []);
    } finally { await close(); }
  });

  test('botão "Já paguei — verificar agora" avança imediatamente', async () => {
    const id = '7002';
    payments.set(id, mpPayment({ id: 7002, status: 'in_process', status_detail: 'pending_review_manual', external_reference: REF(2), payment_type_id: 'credit_card' }));
    const { page, close } = await newPage(browser, srv.base);
    try {
      await page.goto(url(id, REF(2)));
      await page.locator('#ob-title', { hasText: 'em análise' }).waitFor();
      payments.get(id).status = 'approved';
      await page.click('[data-action="check"]');
      await page.locator('#ob-title', { hasText: 'Pagamento confirmado' }).waitFor({ timeout: 3000 });
    } finally { await close(); }
  });

  test('pendente → recusado durante o polling mostra a recusa', async () => {
    const id = '7003';
    payments.set(id, mpPayment({ id: 7003, status: 'pending', external_reference: REF(3), payment_type_id: 'ticket' }));
    const { page, close } = await newPage(browser, srv.base);
    try {
      await page.goto(url(id, REF(3)));
      await page.locator('#ob-title', { hasText: 'Estamos aguardando' }).waitFor();
      const methods = norm(await page.locator('.ob-methods').textContent());
      assert.match(methods, /Boleto/);
      assert.doesNotMatch(methods, /PIX/);
      Object.assign(payments.get(id), { status: 'cancelled', status_detail: 'expired' });
      await page.locator('#ob-title', { hasText: 'Pagamento cancelado' }).waitFor({ timeout: 9000 });
      assert.match(norm(await page.locator('.ob-head').textContent()), /prazo para pagamento expirou/);
    } finally { await close(); }
  });

  test('payment_id de outro pedido (ref divergente) ⇒ "Pagamento não encontrado"', async () => {
    payments.set('7004', mpPayment({ id: 7004, external_reference: REF(4) }));
    const { page, close } = await newPage(browser, srv.base);
    try {
      await page.goto(url('7004', REF(99)));
      await page.locator('#ob-title', { hasText: 'Pagamento não encontrado' }).waitFor();
    } finally { await close(); }
  });
});
