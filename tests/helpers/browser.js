// Playwright (instalação global, sem dependência no package.json).
// Caminhos configuráveis por env:
//   PLAYWRIGHT_MODULE   — caminho do index.mjs do playwright (padrão /opt/node-tools/node_modules/playwright/index.mjs)
//   PLAYWRIGHT_CHROMIUM — executável do Chromium (padrão /opt/pw-browsers/chromium)
// Se o Playwright ou o Chromium não existirem, `browserSkip` traz o motivo e os testes e2e se auto-pulam.
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const MODULE = process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright/index.mjs';
const CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM || '/opt/pw-browsers/chromium';

let chromium = null;
let reason = null;
try {
  if (!fs.existsSync(MODULE)) throw new Error(`Playwright não encontrado em ${MODULE}`);
  ({ chromium } = await import(MODULE));
  if (!fs.existsSync(CHROMIUM)) throw new Error(`Chromium não encontrado em ${CHROMIUM}`);
} catch (err) {
  chromium = null;
  reason = `e2e pulado: ${err.message} (defina PLAYWRIGHT_MODULE / PLAYWRIGHT_CHROMIUM)`;
}

/** false quando o navegador está disponível; senão, string com o motivo (use em { skip: browserSkip }). */
export const browserSkip = chromium ? false : reason;

export async function launch() {
  if (!chromium) throw new Error(reason);
  return chromium.launch({ executablePath: CHROMIUM, headless: true });
}

const fontCache = new Map();
/** Baixa um recurso do Google Fonts com o curl do sistema (que respeita HTTPS_PROXY). */
function curl(url) {
  if (!fontCache.has(url)) {
    fontCache.set(url, new Promise((resolve) => {
      execFile('curl', ['-sS', '--max-time', '15', '-A', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36', url],
        { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
    }));
  }
  return fontCache.get(url);
}

/**
 * Abre uma página "vigiada": coleta erros de console, exceções e respostas ≥ 400 da origem local.
 * Requisições a outros domínios (Google Fonts, wa.me...) são atendidas localmente com corpo vazio (testes
 * determinísticos). external=true baixa as Google Fonts de verdade via curl (screenshots fiéis).
 */
export async function newPage(browser, base, { width = 1440, height = 900, external = false, reducedMotion = 'reduce' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion, locale: 'pt-BR' });
  const page = await context.newPage();
  const watch = { console: [], pageErrors: [], badResponses: [], requests: [] };
  const origin = new URL(base).origin;
  await context.route((url) => !url.href.startsWith(origin) && /^https?:/.test(url.protocol), async (route) => {
    const req = route.request();
    const type = req.resourceType();
    const u = new URL(req.url());
    if (external && /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(u.hostname)) {
      const body = await curl(u.href);
      if (body) {
        const contentType = u.hostname === 'fonts.googleapis.com' ? 'text/css' : u.pathname.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
        return route.fulfill({ status: 200, body, contentType, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
    }
    return route.fulfill({ status: 200, body: '', contentType: type === 'stylesheet' ? 'text/css' : 'text/plain' });
  });
  page.on('console', (m) => { if (m.type() === 'error') watch.console.push(m.text()); });
  page.on('pageerror', (e) => watch.pageErrors.push(String(e?.message || e)));
  page.on('request', (r) => watch.requests.push(r.url()));
  page.on('response', (r) => {
    if (r.url().startsWith(origin) && r.status() >= 400) watch.badResponses.push(`${r.status()} ${r.url()}`);
  });
  return { context, page, watch, close: () => context.close() };
}
