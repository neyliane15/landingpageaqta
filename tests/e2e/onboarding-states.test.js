// /obrigado e /acesso diante dos contratos novos do back-end: categorias do fornecedor (Emptra), 409 in_progress
// (nova tentativa automática), 402 payment_not_active, 503 payment_check_failed, payment-status revoked/onboarded
// e GET /api/onboarding 402. As respostas de erro são simuladas com page.route (o resto é o servidor real, modo demo).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';
import { browserSkip, launch, newPage } from '../helpers/browser.js';
import { startCheckout, payDemo, activate, norm } from '../helpers/e2e-flow.js';
import { CNPJ } from '../helpers/fixtures.js';

let srv;
let browser;
before(async () => {
  if (browserSkip) return;
  srv = await startServer({ env: { AQTA_WHATSAPP: '5521988887777' } });
  browser = await launch();
});
after(async () => { await browser?.close(); await srv?.close(); });

async function approvedObtra(page) {
  await startCheckout(page, srv.base, 'obtra');
  await payDemo(page, 'approved');
  await page.locator('#ob-form').waitFor({ state: 'visible' });
  const doc = page.locator('#f-document');
  if (!(await doc.inputValue())) await doc.fill(CNPJ);
  await page.selectOption('#f-obras', '4-10');
  await page.fill('#f-cidade', 'Niterói');
  await page.selectOption('#f-uf', 'RJ');
}

describe('ativação — estados do servidor', { skip: browserSkip }, () => {
  test('Emptra fornecedor: categorias aparecem só para fornecedor e vão em extra.categories (slugs)', async () => {
    const { page, close } = await newPage(browser, srv.base);
    try {
      const cat = await (await fetch(srv.base + '/api/catalog')).json();
      assert.ok(cat.emptraCategories?.length, 'catálogo traz emptraCategories');
      await startCheckout(page, srv.base, 'emptra');
      await payDemo(page, 'approved');
      await page.locator('#ob-form').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#f-categorias').isVisible(), false, 'oculto antes de escolher o perfil');
      await page.locator('.ob-radio:has(input[value="comprador"])').click();
      assert.equal(await page.locator('#f-categorias').isVisible(), false, 'oculto para comprador');
      await page.locator('.ob-radio:has(input[value="fornecedor"])').click();
      await page.locator('#f-categorias input[name="categories"]').first().waitFor();
      assert.equal(await page.locator('#f-categorias input[name="categories"]').count(), cat.emptraCategories.length);
      const picks = cat.emptraCategories.slice(0, 2).map((c) => c.slug);
      for (const slug of picks) await page.locator(`.ob-cat:has(input[value="${slug}"])`).click();
      const doc = page.locator('#f-document');
      if (!(await doc.inputValue())) await doc.fill(CNPJ);
      await page.fill('#f-cidade', 'Niterói');
      await page.selectOption('#f-uf', 'RJ');
      const [req] = await Promise.all([
        page.waitForRequest((r) => r.url().endsWith('/api/onboarding') && r.method() === 'POST'),
        page.click('#ob-form button[type="submit"]'),
      ]);
      assert.equal(req.headers()['content-type'], 'application/json');
      const body = JSON.parse(req.postData());
      assert.equal(body.extra.perfil, 'fornecedor');
      assert.deepEqual(body.extra.categories, picks);
      await page.waitForURL(/\/acesso\?token=/);
    } finally { await close(); }
  });

  test('409 in_progress ⇒ tenta de novo sozinho após ~3 s e conclui', async () => {
    const { page, close } = await newPage(browser, srv.base);
    try {
      await approvedObtra(page);
      const times = [];
      let calls = 0;
      await page.route('**/api/onboarding', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        times.push(Date.now());
        calls++;
        if (calls <= 2) return route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"in_progress"}' });
        return route.fallback();
      });
      await Promise.all([
        page.waitForURL(/\/acesso\?token=/, { timeout: 20000 }),
        page.click('#ob-form button[type="submit"]'),
      ]);
      assert.equal(calls, 3);
      assert.ok(times[1] - times[0] >= 2800 && times[2] - times[1] >= 2800, `intervalos: ${times[1] - times[0]}, ${times[2] - times[1]}`);
    } finally { await close(); }
  });

  test('409 persistente ⇒ para após 5 novas tentativas e explica', async () => {
    const { page, close } = await newPage(browser, srv.base);
    try {
      await approvedObtra(page);
      let calls = 0;
      await page.clock.install();
      await page.route('**/api/onboarding', (route) => {
        calls++;
        return route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"in_progress"}' });
      });
      await page.click('#ob-form button[type="submit"]');
      for (let i = 0; i < 6; i++) { await page.waitForTimeout(50); await page.clock.runFor(3100); }
      await page.locator('#ob-form-alert .alert--err').waitFor();
      assert.equal(calls, 6, '1 envio + 5 novas tentativas');
      assert.match(norm(await page.locator('#ob-form-alert').textContent()), /em andamento/);
    } finally { await close(); }
  });

  test('402 payment_not_active ⇒ mensagem do servidor, botão desativado, link de suporte configurado', async () => {
    const { page, close } = await newPage(browser, srv.base);
    try {
      await approvedObtra(page);
      await page.route('**/api/onboarding', (route) => route.fulfill({ status: 402, contentType: 'application/json',
        body: JSON.stringify({ error: 'payment_not_active', message: 'Este pagamento foi estornado.' }) }));
      await page.click('#ob-form button[type="submit"]');
      const alert = page.locator('#ob-form-alert .alert--err');
      await alert.waitFor();
      assert.match(norm(await alert.textContent()), /Este pagamento foi estornado\./);
      assert.equal(await page.locator('#ob-form button[type="submit"]').isDisabled(), true);
      assert.match(await alert.locator('a').getAttribute('href'), /^https:\/\/wa\.me\/5521988887777\?text=/);
    } finally { await close(); }
  });

  test('503 payment_check_failed ⇒ pede para tentar em instantes (sem desativar o botão)', async () => {
    const { page, close } = await newPage(browser, srv.base);
    try {
      await approvedObtra(page);
      await page.route('**/api/onboarding', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"payment_check_failed"}' }));
      await page.click('#ob-form button[type="submit"]');
      await page.locator('#ob-form-alert .alert--err').waitFor();
      assert.match(norm(await page.locator('#ob-form-alert').textContent()), /não conseguimos confirmar o pagamento agora/i);
      assert.equal(await page.locator('#ob-form button[type="submit"]').isDisabled(), false);
    } finally { await close(); }
  });

  test('payment-status revoked ⇒ estado "estornado", sem formulário de ativação', async () => {
    const { page, close } = await newPage(browser, srv.base);
    try {
      await page.route('**/api/payment-status**', async (route) => {
        const res = await route.fetch();
        const body = { ...(await res.json()), revoked: true };
        delete body.accessToken;
        return route.fulfill({ response: res, body: JSON.stringify(body) });
      });
      await startCheckout(page, srv.base, 'obtra');
      await payDemo(page, 'approved');
      await page.locator('#ob-title', { hasText: /estornado/i }).waitFor();
      assert.equal(await page.locator('#ob-form').count(), 0);
    } finally { await close(); }
  });

  test('payment-status onboarded ⇒ vai direto para /acesso com o token salvo', async () => {
    const { page, close } = await newPage(browser, srv.base);
    try {
      await startCheckout(page, srv.base, 'obtra');
      await payDemo(page, 'approved');
      const obrigado = page.url();
      await activate(page, 'obtra');
      const savedToken = new URL(page.url()).searchParams.get('token');
      await page.route('**/api/payment-status**', async (route) => {
        const res = await route.fetch();
        return route.fulfill({ response: res, body: JSON.stringify({ ...(await res.json()), onboarded: true, accessToken: savedToken }) });
      });
      await page.goto(obrigado, { waitUntil: 'commit' });
      await page.waitForURL(/\/acesso\?token=/);
      assert.equal(new URL(page.url()).searchParams.get('token'), savedToken);
    } finally { await close(); }
  });

  test('/acesso com GET 402 ⇒ "Este acesso não está mais ativo"', async () => {
    const { page, close } = await newPage(browser, srv.base);
    try {
      await page.route('**/api/onboarding?token=**', (route) => route.fulfill({ status: 402, contentType: 'application/json',
        body: JSON.stringify({ error: 'payment_not_active', message: 'Pagamento estornado no Mercado Pago.' }) }));
      await page.goto(srv.base + '/acesso?token=abc.def');
      await page.locator('.ac-title', { hasText: 'Este acesso não está mais ativo' }).waitFor();
      assert.match(norm(await page.locator('#ac-view').textContent()), /Pagamento estornado no Mercado Pago\./);
    } finally { await close(); }
  });
});
