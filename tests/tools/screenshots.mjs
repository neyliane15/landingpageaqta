// Inspeção visual manual: tira screenshots (1440 e 390) de cada página/estado.
// Uso: node tests/tools/screenshots.mjs [pasta-de-saída]   (não roda no `npm test`)
// Carrega as Google Fonts de verdade (via HTTPS_PROXY, se houver) para a captura ficar fiel.
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.js';
import { launch, newPage } from '../helpers/browser.js';
import { startObtraMock } from '../helpers/mock-products.js';
import { startCheckout, payDemo, activate, scrollThrough } from '../helpers/e2e-flow.js';
import { demoPurchase, approvedAccess } from '../helpers/fixtures.js';

const out = path.resolve(process.argv[2] || 'screenshots');
fs.mkdirSync(out, { recursive: true });
const obtraMock = await startObtraMock();
const srv = await startServer({ env: { AQTA_WHATSAPP: '5521988887777' } });
const browser = await launch();
const report = [];

const only = process.env.SHOTS ? new RegExp(process.env.SHOTS) : null;
async function shot(name, width, go) {
  if (only && !only.test(name)) return;
  const t0 = Date.now();
  const { page, watch, close } = await newPage(browser, srv.base, { width, height: width < 600 ? 844 : 900, external: true, reducedMotion: 'reduce' });
  try {
    await go(page);
    await page.waitForTimeout(400);
    const file = path.join(out, `${name}-${width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`  ${name}@${width} ${Date.now() - t0}ms`);
    report.push({ name, width, file, overflow, errors: [...watch.pageErrors, ...watch.console.filter((c) => !/Failed to load resource/.test(c))] });
  } catch (err) {
    console.log(`  ${name}@${width} ERRO ${Date.now() - t0}ms`);
    report.push({ name, width, error: String(err.message).split('\n').slice(0, 12).join(' / ') });
  } finally { await close(); }
}

for (const width of [1440, 390]) {
  await shot('01-landing', width, async (p) => { await p.goto(srv.base + '/', { waitUntil: 'networkidle' }); await scrollThrough(p); await p.evaluate(() => scrollTo(0, 0)); });
  await shot('02-modal-compra', width, async (p) => {
    await p.goto(srv.base + '/'); await p.locator('#planos [data-checkout="emptra"]').click();
    await p.locator('#checkout-modal').waitFor({ state: 'visible' }); await p.waitForTimeout(500);
  });
  await shot('03-modal-erros', width, async (p) => {
    await p.goto(srv.base + '/'); await p.locator('#planos [data-checkout="obtra"]').click();
    await p.locator('#checkout-modal').waitFor({ state: 'visible' }); await p.fill('#co-document', '11111111111'); await p.click('[data-co-submit]');
  });
  if (width === 390) {
    await shot('04-menu-mobile', width, async (p) => { await p.goto(srv.base + '/'); await p.locator('.lp-menu-btn').click(); await p.waitForTimeout(400); });
  }
  await shot('05-checkout-demo', width, async (p) => { await startCheckout(p, srv.base, 'obtra'); });
  await shot('05b-checkout-demo-768', 768, async (p) => { await startCheckout(p, srv.base, 'emptra'); });
  await shot('06-obrigado-aprovado-obtra', width, async (p) => { await startCheckout(p, srv.base, 'obtra'); await payDemo(p, 'approved'); await p.locator('#ob-form').waitFor(); });
  await shot('07-obrigado-aprovado-emptra-erros', width, async (p) => {
    await startCheckout(p, srv.base, 'emptra'); await payDemo(p, 'approved'); await p.locator('#ob-form').waitFor();
    await p.click('#ob-form button[type="submit"]');
  });
  await shot('08-obrigado-pendente', width, async (p) => { const d = await demoPurchase(srv, 'obtra', 'pending'); await p.goto(srv.base + d.redirect); await p.locator('#ob-poll-text').waitFor(); });
  await shot('09-obrigado-recusado', width, async (p) => { const d = await demoPurchase(srv, 'emptra', 'rejected'); await p.goto(srv.base + d.redirect); await p.locator('text=Pagamento não aprovado').waitFor(); });
  await shot('10-obrigado-sem-parametros', width, async (p) => { await p.goto(srv.base + '/obrigado'); await p.locator('#ob-title').waitFor(); });
  await shot('11-acesso-manual-obtra', width, async (p) => { await startCheckout(p, srv.base, 'obtra'); await payDemo(p, 'approved'); await activate(p, 'obtra'); });
  await shot('12-acesso-manual-emptra', width, async (p) => { await startCheckout(p, srv.base, 'emptra'); await payDemo(p, 'approved'); await activate(p, 'emptra'); });
  await shot('13-acesso-auto-obtra-senha', width, async (p) => {
    process.env.OBTRA_SUPABASE_URL = obtraMock.url; process.env.OBTRA_SUPABASE_SERVICE_KEY = obtraMock.serviceKey;
    try { await startCheckout(p, srv.base, 'obtra'); await payDemo(p, 'approved'); await activate(p, 'obtra', { loginEmail: `auto${width}@example.com` }); }
    finally { process.env.OBTRA_SUPABASE_URL = ''; process.env.OBTRA_SUPABASE_SERVICE_KEY = ''; }
  });
  await shot('14-acesso-pendente-ativacao', width, async (p) => {
    const a = await approvedAccess(srv, 'emptra'); await p.goto(`${srv.base}/acesso?token=${encodeURIComponent(a.accessToken)}`); await p.locator('.ac-title').waitFor();
  });
  await shot('15-acesso-sem-token', width, async (p) => { await p.goto(srv.base + '/acesso'); await p.locator('.ac-title').waitFor(); });
  await shot('16-404', width, async (p) => { await p.goto(srv.base + '/nao-existe', { waitUntil: 'networkidle' }); });
  await shot('17-lead-sucesso', width, async (p) => {
    await p.goto(srv.base + '/#sob-medida');
    for (const [k, v] of Object.entries({ name: 'Carlos Lead', company: 'Empresa Y', email: 'carlos@empresa.com', whatsapp: '21998765432', message: 'Preciso de um sistema de medições.' })) await p.fill(`#lead-${k}`, v);
    await p.click('#lead-form button[type="submit"]'); await p.locator('#lead-status .alert--ok').waitFor();
  });
}

await browser.close();
await srv.close();
await obtraMock.close();
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
for (const r of report) console.log(r.error ? `ERRO  ${r.name}@${r.width}: ${r.error}` : `${r.overflow > 0 ? 'OVERFLOW+' + r.overflow : 'ok'.padEnd(11)} ${r.name}@${r.width}${r.errors.length ? '  console: ' + r.errors.join(' | ') : ''}`);
