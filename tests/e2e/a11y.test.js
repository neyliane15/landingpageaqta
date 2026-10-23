// Acessibilidade básica em todas as páginas/estados: alt, labels, um h1, nomes acessíveis, ids e referências ARIA.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';
import { browserSkip, launch, newPage } from '../helpers/browser.js';
import { demoPurchase, approvedAccess, onboardingInput } from '../helpers/fixtures.js';

let srv;
let browser;
before(async () => {
  if (browserSkip) return;
  srv = await startServer({ env: { AQTA_WHATSAPP: '5521988887777' } });
  browser = await launch();
});
after(async () => { await browser?.close(); await srv?.close(); });

/** Roda no navegador: devolve a lista de problemas encontrados. */
function audit() {
  const problems = [];
  const visible = (el) => {
    if (el.closest('[hidden], [aria-hidden="true"], dialog:not([open])')) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || s.position === 'absolute' || s.position === 'fixed';
  };
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
  const textName = (el) => (el.getAttribute('aria-label') || '').trim()
    || (el.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim()
    || el.innerText?.trim() || el.textContent.trim()
    || [...el.querySelectorAll('img[alt]')].map((i) => i.alt).join(' ').trim()
    || (el.getAttribute('title') || '').trim();

  if (!document.documentElement.lang) problems.push('html sem lang');
  if (!document.title.trim()) problems.push('sem <title>');

  for (const img of document.images) if (!img.hasAttribute('alt')) problems.push(`img sem alt: ${img.src}`);
  for (const el of document.querySelectorAll('[role="img"]')) if (!textName(el)) problems.push(`role=img sem nome: ${describe(el)}`);

  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (el.type === 'hidden') continue;
    const hasLabel = el.labels?.length > 0 || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label');
    if (!hasLabel) problems.push(`campo sem label: ${describe(el)}`);
  }

  const h1 = [...document.querySelectorAll('h1')].filter(visible);
  if (h1.length !== 1) problems.push(`esperado 1 h1 visível, há ${h1.length}: ${h1.map((h) => h.textContent.trim().slice(0, 40)).join(' | ')}`);

  for (const el of document.querySelectorAll('button, [role="button"], [role="tab"]')) {
    if (!visible(el)) continue;
    if (!textName(el)) problems.push(`botão sem nome acessível: ${describe(el)}`);
  }
  for (const a of document.querySelectorAll('a[href]')) {
    if (!visible(a)) continue;
    if (!textName(a)) problems.push(`link sem nome acessível: ${describe(a)} → ${a.getAttribute('href')}`);
  }

  const ids = {};
  for (const el of document.querySelectorAll('[id]')) ids[el.id] = (ids[el.id] || 0) + 1;
  for (const [id, n] of Object.entries(ids)) if (n > 1) problems.push(`id duplicado: #${id} (${n}x)`);

  for (const attr of ['aria-controls', 'aria-labelledby', 'aria-describedby']) {
    for (const el of document.querySelectorAll(`[${attr}]`)) {
      for (const id of el.getAttribute(attr).split(/\s+/).filter(Boolean)) {
        if (!document.getElementById(id)) problems.push(`${attr}="${id}" aponta para id inexistente em ${describe(el)}`);
      }
    }
  }
  for (const a of document.querySelectorAll('a[href^="#"]')) {
    const id = a.getAttribute('href').slice(1);
    if (id && !document.getElementById(id)) problems.push(`âncora para id inexistente: #${id}`);
  }
  return problems;
}

async function check(path, prepare) {
  const { page, close } = await newPage(browser, srv.base);
  try {
    await page.goto(srv.base + path, { waitUntil: 'networkidle' });
    if (prepare) await prepare(page);
    await page.waitForTimeout(200);
    return await page.evaluate(audit);
  } finally { await close(); }
}

describe('acessibilidade básica', { skip: browserSkip }, () => {
  test('landing', async () => assert.deepEqual(await check('/'), []));

  test('landing com o modal de compra aberto', async () => assert.deepEqual(await check('/', async (page) => {
    await page.locator('#planos [data-checkout="obtra"]').click();
    await page.locator('#checkout-modal').waitFor({ state: 'visible' });
  }), []));

  test('landing mobile com menu aberto', async () => {
    const { page, close } = await newPage(browser, srv.base, { width: 390, height: 800 });
    try {
      await page.goto(srv.base + '/');
      await page.locator('.lp-menu-btn').click();
      assert.deepEqual(await page.evaluate(audit), []);
    } finally { await close(); }
  });

  test('checkout demo', async () => {
    const p = await demoPurchase(srv, 'obtra', 'approved');
    assert.deepEqual(await check(`/checkout-demo?ref=${encodeURIComponent(p.checkoutToken)}`, (page) => page.locator('#cd-checkout').waitFor()), []);
  });

  for (const [product, outcome] of [['obtra', 'approved'], ['emptra', 'approved'], ['obtra', 'pending'], ['obtra', 'rejected']]) {
    test(`/obrigado ${product} ${outcome}`, async () => {
      const p = await demoPurchase(srv, product, outcome);
      assert.deepEqual(await check(p.redirect, (page) => page.waitForFunction(() => document.getElementById('ob-state')?.getAttribute('aria-busy') === 'false')), []);
    });
  }

  test('/obrigado sem parâmetros', async () => assert.deepEqual(await check('/obrigado'), []));

  for (const product of ['obtra', 'emptra']) {
    test(`/acesso ${product} ativado`, async () => {
      const a = await approvedAccess(srv, product);
      const ob = await srv.request('/api/onboarding', { method: 'POST', body: onboardingInput(a.accessToken, product) });
      assert.deepEqual(await check(`/acesso?token=${encodeURIComponent(ob.body.accessToken)}`, (page) => page.locator('a', { hasText: /Entrar no|Ver a tela de login do/ }).waitFor()), []);
    });
  }

  test('/acesso sem token', async () => assert.deepEqual(await check('/acesso'), []));
  test('404', async () => assert.deepEqual(await check('/nao-existe'), []));

  test('todas as páginas têm "pular para o conteúdo" apontando para um alvo existente', async () => {
    for (const path of ['/', '/obrigado', '/acesso']) {
      const { page, close } = await newPage(browser, srv.base);
      try {
        await page.goto(srv.base + path);
        const target = await page.evaluate(() => {
          const a = [...document.querySelectorAll('a[href^="#"]')].find((x) => /pular/i.test(x.textContent));
          return a ? !!document.getElementById(a.getAttribute('href').slice(1)) : null;
        });
        assert.equal(target, true, path);
      } finally { await close(); }
    }
  });

  test('o link "pular para o conteúdo" fica VISÍVEL ao receber foco pelo teclado (WCAG 2.4.7)', async () => {
    const problems = [];
    for (const path of ['/', '/obrigado', '/acesso']) {
      const { page, close } = await newPage(browser, srv.base);
      try {
        await page.goto(srv.base + path);
        await page.waitForTimeout(300);
        // foca o link como o teclado faria (o 1º Tab pode partir do título que a página focou via JS)
        const found = await page.evaluate(() => {
          const a = [...document.querySelectorAll('a[href^="#"]')].find((x) => /pular/i.test(x.textContent));
          if (!a) return false;
          a.focus({ focusVisible: true });
          return document.activeElement === a;
        });
        if (!found) { problems.push(`${path}: sem link "pular para o conteúdo" focável`); continue; }
        await page.waitForTimeout(400); // transições de entrada
        const info = await page.evaluate(() => {
          const r = document.activeElement.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
        });
        if (info.w <= 2 || info.h <= 2 || info.top < 0) problems.push(`${path}: link focado invisível (${info.w}x${info.h}, top=${info.top})`);
      } finally { await close(); }
    }
    assert.deepEqual(problems, []);
  });
});
