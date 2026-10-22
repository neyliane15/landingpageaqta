// Passos reutilizáveis do fluxo de compra no navegador (modo demo).
import assert from 'node:assert/strict';
import { CNPJ } from './fixtures.js';

export const PRICE = { obtra: 'R$ 200,00', emptra: 'R$ 300,00' };
export const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Landing → clica no botão [data-checkout] → preenche o modal → chega ao /checkout-demo. */
export async function startCheckout(page, base, product, { selector } = {}) {
  await page.goto(base + '/', { waitUntil: 'load' });
  const btn = page.locator(selector || `#planos [data-checkout="${product}"]`).first();
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const modal = page.locator('#checkout-modal');
  await modal.waitFor({ state: 'visible' });
  await page.waitForFunction(() => /R\$/.test(document.querySelector('[data-co-price]')?.textContent || ''));
  const summary = norm(await modal.locator('.co-summary').textContent());
  assert.match(summary, new RegExp(product === 'obtra' ? 'Obtra' : 'Emptra'));
  assert.ok(summary.includes(PRICE[product]), `preço no modal: ${summary}`);
  await page.fill('#co-name', 'Maria Teste da Silva');
  await page.fill('#co-email', 'maria.e2e@example.com');
  await page.fill('#co-whatsapp', '21987654321');
  await page.fill('#co-document', '52998224725');
  await page.fill('#co-company', 'Construtora E2E Ltda');
  await page.check('#co-terms');
  await Promise.all([
    page.waitForURL(/\/checkout-demo\?ref=/),
    page.click('[data-co-submit]'),
  ]);
  await page.locator('#cd-checkout').waitFor({ state: 'visible' });
}

/** /checkout-demo → botão de resultado → /obrigado */
export async function payDemo(page, outcome) {
  await Promise.all([
    page.waitForURL(/\/obrigado\?/),
    page.click(`[data-outcome="${outcome}"]`),
  ]);
}

/** Preenche e envia o formulário de ativação no /obrigado (estado aprovado) → /acesso */
export async function activate(page, product, { loginEmail } = {}) {
  await page.locator('#ob-form').waitFor({ state: 'visible' });
  const doc = page.locator('#f-document');
  if (!(await doc.inputValue())) await doc.fill(CNPJ);
  if (loginEmail) await page.fill('#f-loginEmail', loginEmail);
  if (product === 'emptra') {
    await page.locator('.ob-radio:has(input[value="comprador"])').click();
  } else {
    await page.selectOption('#f-obras', '4-10');
  }
  await page.fill('#f-cidade', 'Niterói');
  await page.selectOption('#f-uf', 'RJ');
  await Promise.all([
    page.waitForURL(/\/acesso\?token=/),
    page.click('#ob-form button[type="submit"]'),
  ]);
  await page.locator('.ac-title').waitFor({ state: 'visible' });
}

/** Rola a página inteira (dispara lazy-loading e animações .reveal). */
export async function scrollThrough(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((r) => setTimeout(r, 200));
  });
}

export async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const over = doc.scrollWidth - doc.clientWidth;
    if (over <= 0) return null;
    const culprits = [...document.querySelectorAll('body *')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.right > doc.clientWidth + 1 && r.width > 0; })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''} (right=${Math.round(el.getBoundingClientRect().right)})`);
    return { over, culprits };
  });
}
