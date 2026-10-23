// Content-Security-Policy e demais cabeçalhos do vercel.json aplicados no navegador (REV-12).
// O server.js local não envia os cabeçalhos da Vercel: aqui eles são lidos do vercel.json e injetados em cada
// resposta da origem local via route(), e qualquer violação de CSP (evento securitypolicyviolation ou erro
// "Refused to ..." no console) reprova o teste. Percorre todas as páginas e os estados dinâmicos principais.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from '../helpers/server.js';
import { browserSkip, launch, newPage } from '../helpers/browser.js';
import { startCheckout, payDemo, activate } from '../helpers/e2e-flow.js';

const vercel = JSON.parse(fs.readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
const HEADERS = Object.fromEntries(
  vercel.headers.find((h) => h.source === '/(.*)').headers.map(({ key, value }) => [key.toLowerCase(), value]),
);
const CSP = HEADERS['content-security-policy'];

let srv;
let browser;
before(async () => {
  if (browserSkip) return;
  srv = await startServer({ env: { AQTA_WHATSAPP: '5521988887777' } });
  browser = await launch();
});
after(async () => { await browser?.close(); await srv?.close(); });

async function cspPage(opts = {}) {
  const p = await newPage(browser, srv.base, { external: true, ...opts });
  const origin = new URL(srv.base).origin;
  const violations = [];
  await p.context.exposeBinding('__cspViolation', (_src, v) => violations.push(v));
  await p.context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolation(`${e.effectiveDirective} bloqueou ${e.blockedURI || '(inline)'} em ${location.pathname}${e.sample ? ` — ${e.sample}` : ''}`);
    });
  });
  await p.context.route((url) => url.href.startsWith(origin), async (route) => {
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if ((headers['content-type'] || '').includes('text/html') || !route.request().url().includes('/api/')) {
      Object.assign(headers, HEADERS);
    }
    await route.fulfill({ response: res, headers });
  });
  p.violations = violations;
  return p;
}

function assertNoViolations(p, label) {
  const refused = p.watch.console.filter((m) => /Content Security Policy|Refused to/i.test(m));
  assert.deepEqual([...p.violations, ...refused], [], `${label}: violações de CSP`);
  assert.deepEqual(p.watch.pageErrors, [], `${label}: exceções JS`);
}

describe('CSP do vercel.json', { skip: browserSkip }, () => {
  test('a política é estrita: sem unsafe-inline/unsafe-eval em script-src, com as diretivas pedidas', () => {
    assert.ok(CSP, 'vercel.json define Content-Security-Policy');
    const dir = Object.fromEntries(CSP.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
      const [k, ...v] = d.split(/\s+/);
      return [k, v.join(' ')];
    }));
    assert.doesNotMatch(dir['script-src'] || dir['default-src'], /unsafe-inline|unsafe-eval/);
    assert.equal(dir['form-action'], "'self'");
    assert.equal(dir['frame-ancestors'], "'none'");
    assert.equal(dir['base-uri'], "'self'");
    assert.equal(dir['connect-src'], "'self'");
    assert.equal(dir['img-src'], "'self' data:");
    assert.ok(HEADERS['strict-transport-security'], 'HSTS');
    assert.ok(HEADERS['permissions-policy'], 'Permissions-Policy');
    assert.equal(vercel.outputDirectory, 'public');
    assert.equal(vercel.cleanUrls, true);
    assert.equal(vercel.functions?.['api/*.js']?.maxDuration, 60);
  });

  test('páginas estáticas carregam sem violar a CSP (inclui JSON-LD, fontes e WhatsApp dinâmico)', async () => {
    for (const path of ['/', '/termos', '/privacidade', '/obrigado', '/acesso', '/checkout-demo?ref=abc', '/nao-existe']) {
      const p = await cspPage();
      try {
        await p.page.goto(srv.base + path, { waitUntil: 'load' });
        await p.page.waitForTimeout(400);
        // os estilos externos realmente aplicam (o CSS não foi bloqueado)
        const bg = await p.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        assert.notEqual(bg, 'rgba(0, 0, 0, 0)', `${path}: CSS não aplicado`);
        assertNoViolations(p, path);
      } finally { await p.close(); }
    }
  });

  test('fluxo completo (modal → checkout demo → aprovado → ativação → /acesso) sem violar a CSP', async () => {
    const p = await cspPage();
    try {
      await p.page.goto(srv.base + '/', { waitUntil: 'load' });
      await p.page.locator('#planos [data-checkout="obtra"]').click();
      await p.page.locator('#checkout-modal').waitFor({ state: 'visible' });
      const modalStyled = await p.page.evaluate(() => getComputedStyle(document.querySelector('#checkout-modal .co-grid')).display);
      assert.equal(modalStyled, 'grid', 'checkout.css aplicado ao modal');
      await startCheckout(p.page, srv.base, 'obtra');
      await p.page.click('#tab-card');
      await p.page.press('#cc-number', 'Enter'); // o formulário fictício não pode ser enviado
      assert.match(p.page.url(), /\/checkout-demo\?ref=/);
      await payDemo(p.page, 'approved');
      await activate(p.page, 'obtra');
      await p.page.waitForTimeout(300);
      assertNoViolations(p, 'fluxo aprovado');
    } finally { await p.close(); }
  });

  test('pendente (polling com medidor) e lead da landing sem violar a CSP', async () => {
    const p = await cspPage({ width: 390, height: 800 });
    try {
      await startCheckout(p.page, srv.base, 'emptra');
      await payDemo(p.page, 'pending');
      await p.page.locator('#ob-poll-text').waitFor();
      await p.page.waitForTimeout(1500);
      await p.page.goto(srv.base + '/#sob-medida', { waitUntil: 'load' });
      for (const [k, v] of Object.entries({ name: 'Carlos Lead', company: 'Empresa Y', email: 'carlos@empresa.com', whatsapp: '21998765432', message: 'Preciso de um sistema de medições.' })) {
        await p.page.fill(`#lead-${k}`, v);
      }
      await p.page.click('#lead-form button[type="submit"]');
      await p.page.locator('#lead-status .alert--ok').waitFor();
      assertNoViolations(p, 'pendente + lead');
    } finally { await p.close(); }
  });
});
