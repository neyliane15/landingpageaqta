// Páginas internas em estados de erro e 404.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';
import { browserSkip, launch, newPage } from '../helpers/browser.js';
import { norm } from '../helpers/e2e-flow.js';
import { demoPurchase, signTokenAt } from '../helpers/fixtures.js';

let srv;
let browser;
before(async () => {
  if (browserSkip) return;
  srv = await startServer({ env: { AQTA_WHATSAPP: '5521988887777' } });
  browser = await launch();
});
after(async () => { await browser?.close(); await srv?.close(); });

async function visit(path, fn) {
  const { page, watch, close } = await newPage(browser, srv.base);
  try {
    const res = await page.goto(srv.base + path, { waitUntil: 'load' });
    await fn(page, res, watch);
    assert.deepEqual(watch.pageErrors, [], 'exceções JS');
  } finally { await close(); }
}

describe('erros amigáveis', { skip: browserSkip }, () => {
  test('/obrigado sem parâmetros ⇒ "Não encontramos o seu pagamento" com suporte e "Ver planos"', () => visit('/obrigado', async (page) => {
    await page.locator('#ob-title', { hasText: 'Não encontramos o seu pagamento' }).waitFor();
    assert.ok(await page.locator('a[href="/#planos"]').isVisible());
    assert.match(await page.locator('#ob-state a', { hasText: 'suporte' }).getAttribute('href'), /^https:\/\/wa\.me\//);
  }));

  test('/obrigado com payment_id mas sem external_reference ⇒ "Link de retorno incompleto"', () => visit('/obrigado?payment_id=123&status=approved', async (page) => {
    await page.locator('#ob-title', { hasText: 'Link de retorno incompleto' }).waitFor();
  }));

  test('/obrigado com payment_id inexistente ⇒ "Pagamento não encontrado" + tentar novamente', () => visit('/obrigado?payment_id=demo_x.y&external_reference=aqta:obtra:basico:12345678', async (page, res, watch) => {
    await page.locator('#ob-title', { hasText: 'Pagamento não encontrado' }).waitFor();
    assert.ok(await page.locator('[data-action="retry"]').isVisible());
    watch.console.length = 0; // o 404 da API é esperado aqui
  }));

  test('/acesso sem token ⇒ "Não encontramos o seu acesso" com suporte e voltar ao site', () => visit('/acesso', async (page) => {
    await page.locator('.ac-title', { hasText: 'Não encontramos o seu acesso' }).waitFor();
    assert.match(await page.locator('#ac-view a', { hasText: 'suporte' }).getAttribute('href'), /^https:\/\/wa\.me\//);
    assert.ok(await page.locator('#ac-view a[href="/"]').isVisible());
  }));

  test('/acesso com token inválido ⇒ link inválido; expirado ⇒ "Este link de acesso expirou"', async () => {
    await visit('/acesso?token=abc.def', async (page, res, watch) => {
      await page.locator('.ac-title', { hasText: 'Não encontramos o seu acesso' }).waitFor();
      watch.console.length = 0;
    });
    const expired = await signTokenAt(-40 * 86400, { t: 'access', paymentId: 'p', product: 'obtra', plan: 'basico', customer: {} }, 7 * 86400);
    await visit(`/acesso?token=${encodeURIComponent(expired)}`, async (page, res, watch) => {
      await page.locator('.ac-title', { hasText: 'Este link de acesso expirou' }).waitFor();
      watch.console.length = 0;
    });
  });

  test('/acesso com token aprovado mas sem ativação ⇒ "Falta concluir a ativação"', async () => {
    const p = await demoPurchase(srv, 'emptra', 'approved');
    const s = await srv.request(`/api/payment-status?payment_id=${encodeURIComponent(p.paymentId)}&external_reference=${encodeURIComponent(p.externalReference)}`);
    await visit(`/acesso?token=${encodeURIComponent(s.body.accessToken)}`, async (page) => {
      await page.locator('.ac-title', { hasText: 'Falta concluir a ativação do Emptra' }).waitFor();
    });
  });

  test('/checkout-demo sem ref ⇒ erro com "Ver planos"; ref inválido ⇒ link inválido', async () => {
    await visit('/checkout-demo', async (page) => {
      await page.locator('#cd-error').waitFor({ state: 'visible' });
      assert.match(norm(await page.locator('#cd-error-msg').textContent()), /Nenhum pedido informado/);
      assert.ok(await page.locator('#cd-error a[href="/#planos"]').isVisible());
    });
    await visit('/checkout-demo?ref=abc', async (page, res, watch) => {
      await page.locator('#cd-error').waitFor({ state: 'visible' });
      watch.console.length = 0;
    });
  });

  test('links de suporte usam o WhatsApp configurado (AQTA_WHATSAPP), não um número fixo no HTML', async () => {
    const found = [];
    for (const path of ['/obrigado', '/acesso']) {
      await visit(path, async (page) => {
        await page.waitForTimeout(300);
        const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href*="wa.me"]')].map((a) => a.href));
        for (const h of hrefs) if (!h.startsWith('https://wa.me/5521988887777')) found.push(`${path}: ${h.slice(0, 40)}`);
      });
    }
    assert.deepEqual(found, [], 'números de WhatsApp divergentes do AQTA_WHATSAPP');
  });

  test('rota inexistente ⇒ status 404 com página própria e links de volta', () => visit('/rota/que/nao/existe', async (page, res) => {
    assert.equal(res.status(), 404);
    assert.match(norm(await page.locator('h1').textContent()), /saiu do projeto/);
    assert.ok(await page.locator('main a[href="/"]').isVisible());
    assert.ok(await page.locator('main a[href="/#planos"]').isVisible());
  }));
});
