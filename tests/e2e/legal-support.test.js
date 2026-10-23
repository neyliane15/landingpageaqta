// Termos/Privacidade (BUG-9) e canal de suporte vindo de /api/catalog → support (BUG-5 / REV-11).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';
import { browserSkip, launch, newPage } from '../helpers/browser.js';

const PAGES = ['/', '/obrigado', '/acesso', '/termos', '/privacidade', '/rota-inexistente'];

let withWa;
let browser;
before(async () => {
  if (browserSkip) return;
  withWa = await startServer({ env: { AQTA_WHATSAPP: '5521988887777' } });
  browser = await launch();
});
after(async () => { await browser?.close(); await withWa?.close(); });
// O servidor de teste roda no mesmo processo e as funções leem process.env a cada requisição:
// para o cenário "sem número" basta zerar AQTA_WHATSAPP durante o teste.
const withoutWa = { get base() { return withWa.base; } };

async function visit(srv, path, fn) {
  const { page, watch, close } = await newPage(browser, srv.base);
  try {
    await page.goto(srv.base + path, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    await fn(page, watch);
    assert.deepEqual(watch.pageErrors, [], `${path}: exceções JS`);
  } finally { await close(); }
}

describe('termos e privacidade', { skip: browserSkip }, () => {
  test('/termos e /privacidade carregam (200), com h1 e seções obrigatórias', async () => {
    for (const [path, h1, sections] of [
      ['/termos', /Termos de Uso e Contratação/, ['empresa', 'pagamento', 'ativacao', 'renovacao', 'cancelamento']],
      ['/privacidade', /Política de Privacidade/, ['controlador', 'coleta', 'finalidades', 'compartilhamento', 'retencao', 'direitos', 'contato']],
    ]) {
      const { page, close } = await newPage(browser, withWa.base);
      try {
        const res = await page.goto(withWa.base + path);
        assert.equal(res.status(), 200, path);
        assert.match(await page.locator('h1').textContent(), h1);
        for (const id of sections) assert.equal(await page.locator(`section#${id}`).count(), 1, `${path}#${id}`);
        const text = await page.locator('main').textContent();
        assert.match(text, /Aqta Desenvolvimento de Software/);
        // dados cadastrais ainda não preenchidos ⇒ bloco oculto
        assert.equal(await page.locator('.lg-id').isVisible(), false, `${path}: bloco de CNPJ/endereço vazio deve ficar oculto`);
      } finally { await close(); }
    }
  });

  test('privacidade cita os dados coletados e com quem são compartilhados (LGPD)', () => visit(withWa, '/privacidade', async (page) => {
    const text = (await page.locator('main').textContent()).replace(/\s+/g, ' ');
    for (const re of [/nome/i, /e-mail/i, /WhatsApp/, /CPF ou CNPJ/, /empresa/i, /Mercado Pago/, /Obtra/, /Emptra/, /art\. 18/]) {
      assert.match(text, re);
    }
  }));

  test('rodapé de todas as páginas linka /termos e /privacidade', async () => {
    const missing = [];
    for (const path of PAGES) {
      await visit(withWa, path, async (page) => {
        for (const href of ['/termos', '/privacidade']) {
          if (!(await page.locator(`footer a[href="${href}"]`).count())) missing.push(`${path} → ${href}`);
        }
      });
    }
    assert.deepEqual(missing, []);
  });

  test('checkbox do modal de compra linka termos e privacidade', () => visit(withWa, '/', async (page) => {
    await page.locator('[data-checkout="obtra"]').first().click();
    await page.locator('#checkout-modal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#checkout-modal .co-terms a[href="/termos"]').count(), 1);
    assert.equal(await page.locator('#checkout-modal .co-terms a[href="/privacidade"]').count(), 1);
  }));
});

describe('canal de suporte (WhatsApp) vindo do servidor', { skip: browserSkip }, () => {
  test('com AQTA_WHATSAPP: landing mostra WhatsApp no rodapé, FAQ e sob medida, com o número configurado', () => visit(withWa, '/', async (page) => {
    for (const sel of ['.lp-footer a[data-wa-text]', '#faq a[data-wa-text]', '#sob-medida a[data-wa-text]']) {
      const a = page.locator(sel).first();
      assert.ok(await a.isVisible(), `${sel} visível`);
      assert.match(await a.getAttribute('href'), /^https:\/\/wa\.me\/5521988887777\?text=/, sel);
    }
  }));

  test('sem AQTA_WHATSAPP: nenhum link wa.me; suporte cai no contato do site e o WhatsApp da landing some', async () => {
    const saved = process.env.AQTA_WHATSAPP;
    process.env.AQTA_WHATSAPP = '';
    try {
      const problems = [];
      for (const path of ['/', '/obrigado', '/acesso', '/termos']) {
        await visit(withoutWa, path, async (page) => {
          const wa = await page.evaluate(() => [...document.querySelectorAll('a[href*="wa.me"]')].map((a) => a.href));
          if (wa.length) problems.push(`${path}: ${wa.join(', ')}`);
          const visibleWa = await page.evaluate(() => [...document.querySelectorAll('[data-wa-only]')].filter((e) => e.offsetParent !== null).length);
          if (visibleWa) problems.push(`${path}: ${visibleWa} bloco(s) de WhatsApp visíveis sem número`);
        });
      }
      assert.deepEqual(problems, []);
      await visit(withoutWa, '/obrigado', async (page) => {
        assert.equal(await page.locator('#ob-support-link').getAttribute('href'), '/#sob-medida');
      });
    } finally { process.env.AQTA_WHATSAPP = saved; }
  });
});
