// Landing page: console limpo, sem 404, responsiva, menu mobile, FAQ, formulário de lead, âncoras e imagens.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';
import { browserSkip, launch, newPage } from '../helpers/browser.js';
import { scrollThrough, horizontalOverflow, norm } from '../helpers/e2e-flow.js';
import { demoPurchase, approvedAccess, onboardingInput } from '../helpers/fixtures.js';

let srv;
let browser;
before(async () => {
  if (browserSkip) return;
  srv = await startServer({ env: { AQTA_WHATSAPP: '5521988887777' } });
  browser = await launch();
});
after(async () => { await browser?.close(); await srv?.close(); });

describe('landing — carga', { skip: browserSkip }, () => {
  test('sem erros de console, sem exceções e sem requisições locais com erro', async () => {
    const { page, watch, close } = await newPage(browser, srv.base);
    try {
      await page.goto(srv.base + '/', { waitUntil: 'networkidle' });
      await scrollThrough(page);
      await page.waitForTimeout(300);
      assert.deepEqual(watch.pageErrors, []);
      assert.deepEqual(watch.console, []);
      assert.deepEqual(watch.badResponses, []);
    } finally { await close(); }
  });

  test('todas as imagens carregam (naturalWidth > 0)', async () => {
    const { page, close } = await newPage(browser, srv.base);
    try {
      await page.goto(srv.base + '/');
      await scrollThrough(page);
      await page.waitForLoadState('networkidle');
      const broken = await page.evaluate(() => [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src));
      assert.deepEqual(broken, []);
    } finally { await close(); }
  });

  test('preços exibidos batem com o catálogo (R$ 200 Obtra, R$ 300 Emptra) em todos os lugares', async () => {
    const { page, close } = await newPage(browser, srv.base);
    try {
      await page.goto(srv.base + '/', { waitUntil: 'networkidle' });
      const prices = await page.evaluate(() => [...document.querySelectorAll('[data-price]')].map((e) => [e.dataset.price, e.textContent.replace(/\s+/g, ' ').trim()]));
      assert.ok(prices.length >= 6);
      for (const [p, txt] of prices) assert.equal(txt, p === 'obtra' ? 'R$ 200' : 'R$ 300', `${p}: ${txt}`);
      const html = await page.content();
      assert.doesNotMatch(html.replace(/R\$ ?(200|300)/g, ''), /R\$ ?\d{2,}(?!\.\d)/, 'algum outro preço solto no HTML');
    } finally { await close(); }
  });

  test('todo link âncora (#id) aponta para um id existente; links internos (/x) respondem 200', async () => {
    const { page, close } = await newPage(browser, srv.base);
    try {
      await page.goto(srv.base + '/');
      const { missing, internal } = await page.evaluate(() => {
        const as = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
        return {
          missing: as.filter((h) => h.startsWith('#') && h.length > 1 && !document.getElementById(h.slice(1))),
          internal: [...new Set(as.filter((h) => h.startsWith('/') && !h.startsWith('//')))],
        };
      });
      assert.deepEqual(missing, []);
      for (const h of internal) {
        const r = await srv.request(h.split('#')[0] || '/', { json: false });
        assert.equal(r.status, 200, h);
      }
      for (const h of ['/#planos', '/#sob-medida']) {
        assert.ok(await page.evaluate((id) => !!document.getElementById(id), h.slice(2)), `${h} usado em outras páginas`);
      }
    } finally { await close(); }
  });

  test('cada [data-checkout] tem produto e plano válidos no catálogo', async () => {
    const { page, close } = await newPage(browser, srv.base);
    try {
      await page.goto(srv.base + '/');
      const btns = await page.evaluate(() => [...document.querySelectorAll('[data-checkout]')].map((b) => [b.dataset.checkout, b.dataset.plan, b.tagName]));
      assert.ok(btns.length >= 6);
      for (const [p, plan] of btns) {
        assert.ok(['obtra', 'emptra'].includes(p), p);
        assert.equal(plan, 'basico');
      }
    } finally { await close(); }
  });
});

describe('responsividade (sem scroll horizontal)', { skip: browserSkip }, () => {
  const pages = async () => {
    const p = await demoPurchase(srv, 'emptra', 'approved');
    const pend = await demoPurchase(srv, 'obtra', 'pending');
    const a = await approvedAccess(srv, 'obtra');
    const ob = await srv.request('/api/onboarding', { method: 'POST', body: onboardingInput(a.accessToken) });
    return [
      ['/', '/'], ['obrigado aprovado', p.redirect], ['obrigado pendente', pend.redirect], ['obrigado sem params', '/obrigado'],
      ['acesso', `/acesso?token=${encodeURIComponent(ob.body.accessToken)}`], ['acesso sem token', '/acesso'],
      ['checkout-demo', `/checkout-demo?ref=${encodeURIComponent(p.checkoutToken)}`], ['404', '/nao-existe'],
    ];
  };
  for (const width of [360, 390, 768, 1440]) {
    test(`${width}px: nenhuma página rola na horizontal`, async () => {
      const list = await pages();
      const { page, close } = await newPage(browser, srv.base, { width, height: 800 });
      try {
        const problems = [];
        for (const [label, path] of list) {
          await page.goto(srv.base + path, { waitUntil: 'networkidle' });
          await page.waitForTimeout(150);
          const o = await horizontalOverflow(page);
          if (o) problems.push(`${label}: +${o.over}px ${o.culprits.join(' | ')}`);
        }
        if (width === 390 || width === 360) {
          await page.goto(srv.base + '/');
          await page.locator('#planos [data-checkout="obtra"]').click();
          await page.locator('#checkout-modal').waitFor({ state: 'visible' });
          const box = await page.locator('#checkout-modal .modal__dialog').boundingBox();
          if (box.x < 0 || box.x + box.width > width) problems.push(`modal de compra sai da tela: x=${box.x} w=${box.width}`);
        }
        assert.deepEqual(problems, []);
      } finally { await close(); }
    });
  }
});

describe('responsividade de estados dinâmicos (mensagens)', { skip: browserSkip }, () => {
  for (const width of [360, 390]) {
    test(`${width}px: mensagem de sucesso do lead (com botão WhatsApp) não estoura a largura`, async () => {
      const { page, close } = await newPage(browser, srv.base, { width, height: 800 });
      try {
        await page.goto(srv.base + '/#sob-medida');
        for (const [k, v] of Object.entries({ name: 'Carlos Lead', company: 'Empresa Y', email: 'carlos@empresa.com', whatsapp: '21998765432', message: 'Preciso de um sistema de medições.' })) await page.fill(`#lead-${k}`, v);
        await page.click('#lead-form button[type="submit"]');
        await page.locator('#lead-status .alert--ok').waitFor();
        const btn = await page.locator('#lead-status a').boundingBox();
        const box = await page.locator('#lead-status .alert').boundingBox();
        assert.ok(btn.x + btn.width <= box.x + box.width + 1, `botão "Continuar no WhatsApp" sai do alerta (${Math.round(btn.x + btn.width)} > ${Math.round(box.x + box.width)})`);
        assert.equal(await horizontalOverflow(page), null);
      } finally { await close(); }
    });
  }

  test('360px: erro do onboarding (alerta com link de suporte) não estoura a largura', async () => {
    const p = await demoPurchase(srv, 'obtra', 'approved');
    const { page, context, close } = await newPage(browser, srv.base, { width: 360, height: 800 });
    try {
      await context.route('**/api/onboarding', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal","message":"Não conseguimos ativar agora. Tente novamente em instantes ou fale com o suporte."}' }));
      await page.goto(srv.base + p.redirect);
      await page.locator('#ob-form').waitFor();
      await page.fill('#f-document', '11222333000181');
      await page.selectOption('#f-obras', '1-3');
      await page.fill('#f-cidade', 'Niterói');
      await page.selectOption('#f-uf', 'RJ');
      await page.click('#ob-form button[type="submit"]');
      await page.locator('#ob-form-alert .alert--err').waitFor();
      assert.equal(await horizontalOverflow(page), null);
    } finally { await close(); }
  });
});

describe('menu mobile e FAQ', { skip: browserSkip }, () => {
  test('390px: hambúrguer abre/fecha o menu (clique, link, Esc) e trava o scroll', async () => {
    const { page, close } = await newPage(browser, srv.base, { width: 390, height: 800 });
    try {
      await page.goto(srv.base + '/');
      const btn = page.locator('.lp-menu-btn');
      assert.ok(await btn.isVisible(), 'botão de menu deve aparecer no mobile');
      assert.equal(await page.locator('.lp-nav__link').first().isVisible(), false, 'links escondidos antes de abrir');
      await btn.click();
      assert.equal(await btn.getAttribute('aria-expanded'), 'true');
      assert.equal(await btn.getAttribute('aria-label'), 'Fechar menu');
      await page.locator('.lp-nav__link[href="#planos"]').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => document.documentElement.style.overflow), 'hidden');
      await page.locator('.lp-nav__link[href="#planos"]').click();
      assert.equal(await btn.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '');
      await page.waitForFunction(() => location.hash === '#planos');
      await btn.click();
      await page.keyboard.press('Escape');
      assert.equal(await btn.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('lp-menu-btn')), true);
    } finally { await close(); }
  });

  test('1440px: menu de navegação visível e hambúrguer oculto', async () => {
    const { page, close } = await newPage(browser, srv.base);
    try {
      await page.goto(srv.base + '/');
      assert.equal(await page.locator('.lp-menu-btn').isVisible(), false);
      assert.ok(await page.locator('.lp-nav__link[href="#obtra"]').isVisible());
    } finally { await close(); }
  });

  test('FAQ: abre/fecha com clique, aria-expanded sincronizado, setas movem o foco', async () => {
    const { page, close } = await newPage(browser, srv.base);
    try {
      await page.goto(srv.base + '/#faq');
      const q1 = page.locator('#faq-1-q');
      assert.equal(await page.locator('#faq-1').isVisible(), false);
      await q1.click();
      assert.equal(await q1.getAttribute('aria-expanded'), 'true');
      assert.ok(await page.locator('#faq-1').isVisible());
      await q1.click();
      assert.equal(await q1.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#faq-1').isVisible(), false);
      await q1.focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'faq-2-q');
      await page.keyboard.press('End');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'faq-9-q');
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'faq-1-q');
      await page.keyboard.press('Enter');
      assert.equal(await q1.getAttribute('aria-expanded'), 'true');
    } finally { await close(); }
  });
});

describe('formulário de sistema personalizado (lead)', { skip: browserSkip }, () => {
  const fill = async (page, o = {}) => {
    const v = { name: 'Carlos Lead', company: 'Empresa Y', email: 'carlos@empresa.com', whatsapp: '21998765432', message: 'Preciso de um sistema de medições.', ...o };
    for (const [k, val] of Object.entries(v)) await page.fill(`#lead-${k}`, val);
  };

  test('sucesso: mensagem de confirmação, botão "Continuar no WhatsApp" e formulário limpo', async () => {
    const { page, watch, close } = await newPage(browser, srv.base);
    try {
      await page.goto(srv.base + '/#sob-medida');
      await fill(page);
      assert.equal(await page.inputValue('#lead-whatsapp'), '(21) 99876-5432', 'máscara do WhatsApp');
      await page.click('#lead-form button[type="submit"]');
      await page.locator('#lead-status .alert--ok').waitFor();
      assert.match(norm(await page.locator('#lead-status').textContent()), /Pedido enviado!/);
      const wa = await page.locator('#lead-status a').getAttribute('href');
      assert.match(wa, /^https:\/\/wa\.me\/5521988887777\?text=/);
      assert.equal(await page.inputValue('#lead-name'), '');
      assert.deepEqual(watch.pageErrors, []);
    } finally { await close(); }
  });

  test('erros de validação no navegador (campos vazios) ficam ligados aos campos', async () => {
    const { page, watch, close } = await newPage(browser, srv.base);
    try {
      await page.goto(srv.base + '/#sob-medida');
      await page.click('#lead-form button[type="submit"]');
      for (const f of ['name', 'email', 'whatsapp', 'message']) {
        assert.ok(norm(await page.locator(`#lead-${f}-error`).textContent()), f);
        assert.equal(await page.getAttribute(`#lead-${f}`, 'aria-invalid'), 'true', f);
      }
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'lead-name');
      assert.equal(watch.requests.filter((u) => u.includes('/api/lead')).length, 0, 'não envia com erro');
    } finally { await close(); }
  });

  test('erro de validação do servidor (DDD 00) aparece no campo', async () => {
    const { page, close } = await newPage(browser, srv.base);
    try {
      await page.goto(srv.base + '/#sob-medida');
      await fill(page, { whatsapp: '00998765432' });
      await page.click('#lead-form button[type="submit"]');
      await page.locator('#lead-status .alert--err').waitFor();
      assert.match(norm(await page.locator('#lead-whatsapp-error').textContent()), /WhatsApp/);
    } finally { await close(); }
  });

  test('servidor fora do ar (500) ⇒ mensagem de erro e botão reabilitado', async () => {
    const { page, context, close } = await newPage(browser, srv.base);
    try {
      await context.route('**/api/lead', (r) => r.fulfill({ status: 500, body: '{"error":"internal"}', contentType: 'application/json' }));
      await page.goto(srv.base + '/#sob-medida');
      await fill(page);
      await page.click('#lead-form button[type="submit"]');
      await page.locator('#lead-status .alert--err').waitFor();
      assert.match(norm(await page.locator('#lead-status').textContent()), /Não foi possível enviar/);
      assert.equal(await page.locator('#lead-form button[type="submit"]').isDisabled(), false);
    } finally { await close(); }
  });

  test('429 (muitos envios) ⇒ mensagem própria', async () => {
    const { page, context, close } = await newPage(browser, srv.base);
    try {
      await context.route('**/api/lead', (r) => r.fulfill({ status: 429, body: '{"error":"rate_limited"}', contentType: 'application/json' }));
      await page.goto(srv.base + '/#sob-medida');
      await fill(page);
      await page.click('#lead-form button[type="submit"]');
      await page.locator('#lead-status .alert--err').waitFor();
      assert.match(norm(await page.locator('#lead-status').textContent()), /Muitos envios/);
    } finally { await close(); }
  });
});
