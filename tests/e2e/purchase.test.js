// Fluxo completo de compra no navegador, modo demo: landing → modal → checkout demo → /obrigado → /acesso.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';
import { browserSkip, launch, newPage } from '../helpers/browser.js';
import { startCheckout, payDemo, activate, norm, PRICE } from '../helpers/e2e-flow.js';

let srv;
let browser;
before(async () => {
  if (browserSkip) return;
  srv = await startServer({ env: { AQTA_WHATSAPP: '5521988887777' } });
  browser = await launch();
});
after(async () => { await browser?.close(); await srv?.close(); });

function assertClean(watch, label) {
  assert.deepEqual(watch.pageErrors, [], `${label}: exceções JS`);
  assert.deepEqual(watch.console, [], `${label}: erros no console`);
  assert.deepEqual(watch.badResponses, [], `${label}: respostas >= 400`);
}

describe('compra aprovada (demo)', { skip: browserSkip }, () => {
  for (const product of ['obtra', 'emptra']) {
    const name = product === 'obtra' ? 'Obtra' : 'Emptra';
    test(`${name}: landing → checkout demo → aprovado → ativação → /acesso com "Entrar no ${name}" → /entrar`, async () => {
      const { page, watch, close } = await newPage(browser, srv.base);
      try {
        await startCheckout(page, srv.base, product);
        // checkout demo: resumo verificado pelo servidor
        assert.equal(norm(await page.locator('#cd-checkout [data-f="amount"]').first().textContent()), PRICE[product]);
        assert.equal(norm(await page.locator('#cd-checkout dd[data-f="productName"]').textContent()), name);
        assert.equal(norm(await page.locator('[data-f="customerEmail"]').textContent()), 'maria.e2e@example.com');
        await payDemo(page, 'approved');

        await page.locator('#ob-title', { hasText: 'Pagamento confirmado' }).waitFor();
        const summary = norm(await page.locator('.ob-summary').textContent());
        assert.ok(summary.includes(PRICE[product]), summary);
        assert.ok(summary.includes(name), summary);
        // dados já conhecidos vêm preenchidos
        assert.equal(await page.inputValue('#f-company'), 'Construtora E2E Ltda');
        assert.equal(await page.inputValue('#f-responsible'), 'Maria Teste da Silva');
        assert.equal(await page.inputValue('#f-loginEmail'), 'maria.e2e@example.com');
        assert.equal(await page.inputValue('#f-whatsapp'), '(21) 98765-4321');

        await activate(page, product);
        assert.equal(new URL(page.url()).pathname, '/acesso');
        const enter = page.locator('a', { hasText: `Entrar no ${name}` });
        await enter.waitFor();
        const href = await enter.getAttribute('href');
        assert.match(href, /^https:\/\/.+\/entrar$/, href);
        assert.equal(await enter.getAttribute('target'), null, 'abre na mesma aba');
        const card = norm(await page.locator('#ac-view').textContent());
        assert.match(card, /Construtora E2E Ltda/);
        assert.match(card, /maria\.e2e@example\.com/);
        assert.match(card, /até 1 dia útil/, 'modo manual (demo) mostra o prazo');
        assert.equal(await page.title(), `Acesso ao ${name} — Aqta`);
        // token guardado na sessão: /acesso sem ?token continua funcionando
        await page.goto(srv.base + '/acesso');
        await page.locator('a', { hasText: `Entrar no ${name}` }).waitFor();
        assertClean(watch, name);
      } finally { await close(); }
    });
  }

  test('voltar ao /obrigado depois de ativar e reenviar ⇒ vai direto para /acesso (alreadyDone)', async () => {
    const { page, close } = await newPage(browser, srv.base);
    try {
      await startCheckout(page, srv.base, 'obtra');
      await payDemo(page, 'approved');
      const obrigado = page.url();
      await activate(page, 'obtra');
      await page.goto(obrigado);
      await activate(page, 'obtra', { loginEmail: 'outro.email@example.com' });
      const text = norm(await page.locator('#ac-view').textContent());
      assert.match(text, /maria\.e2e@example\.com/, 'mantém o e-mail da primeira ativação');
    } finally { await close(); }
  });
});

describe('modal de compra — validação no navegador', { skip: browserSkip }, () => {
  test('campos inválidos e termos desmarcados mostram erros e não saem da página', async () => {
    const { page, watch, close } = await newPage(browser, srv.base);
    try {
      await page.goto(srv.base + '/');
      await page.locator('#emptra [data-checkout="emptra"]').click();
      await page.locator('#checkout-modal').waitFor({ state: 'visible' });
      await page.fill('#co-name', 'Al');
      await page.fill('#co-email', 'nao-e-email');
      await page.fill('#co-whatsapp', '123');
      await page.fill('#co-document', '11111111111');
      await page.click('[data-co-submit]');
      for (const f of ['name', 'email', 'whatsapp', 'document', 'terms']) {
        const msg = norm(await page.locator(`#co-${f}-err`).textContent());
        assert.ok(msg, `sem mensagem de erro para ${f}`);
      }
      assert.equal(await page.getAttribute('#co-document', 'aria-invalid'), 'true');
      assert.equal(new URL(page.url()).pathname, '/');
      // máscaras
      await page.fill('#co-whatsapp', '');
      await page.type('#co-whatsapp', '21987654321');
      assert.equal(await page.inputValue('#co-whatsapp'), '(21) 98765-4321');
      await page.fill('#co-document', '');
      await page.type('#co-document', '11222333000181');
      assert.equal(await page.inputValue('#co-document'), '11.222.333/0001-81');
      // fechar com Esc devolve o foco ao botão
      await page.keyboard.press('Escape');
      await page.locator('#checkout-modal').waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.checkout), 'emptra');
      assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '', 'scroll da página liberado após fechar');
      assert.deepEqual(watch.pageErrors, []);
    } finally { await close(); }
  });
});

describe('pagamento pendente e recusado (demo)', { skip: browserSkip }, () => {
  test('pendente: estado de espera, polling ativo e botão "Já paguei — verificar agora"', async () => {
    const { page, watch, close } = await newPage(browser, srv.base);
    try {
      await startCheckout(page, srv.base, 'obtra');
      await payDemo(page, 'pending');
      await page.locator('#ob-title', { hasText: 'Estamos aguardando a confirmação' }).waitFor();
      assert.match(norm(await page.locator('.badge').first().textContent()), /Aguardando pagamento/);
      await page.waitForFunction(() => /Próxima verificação em/.test(document.getElementById('ob-poll-text')?.textContent || ''));
      assert.equal(await page.locator('#ob-form').count(), 0, 'sem formulário de ativação enquanto pendente');
      const statusCalls = () => watch.requests.filter((u) => u.includes('/api/payment-status')).length;
      const before = statusCalls();
      await page.click('[data-action="check"]');
      await page.waitForFunction(() => /Ainda não recebemos/.test(document.getElementById('ob-announce')?.textContent || ''));
      assert.ok(statusCalls() > before, 'botão deveria consultar o status');
      assert.match(norm(await page.locator('#ob-title').textContent()), /aguardando/);
      // polling automático a cada 5 s
      const n = statusCalls();
      await page.waitForTimeout(5600);
      assert.ok(statusCalls() > n, 'polling automático não consultou o status');
      assert.deepEqual(watch.pageErrors, []);
    } finally { await close(); }
  });

  test('recusado: mensagem e "Tentar novamente" leva a /#planos', async () => {
    const { page, watch, close } = await newPage(browser, srv.base);
    try {
      await startCheckout(page, srv.base, 'emptra');
      await payDemo(page, 'rejected');
      await page.locator('#ob-title', { hasText: 'Pagamento não aprovado' }).waitFor();
      assert.match(norm(await page.locator('.ob-head').textContent()), /Nenhum valor foi cobrado/);
      await Promise.all([page.waitForURL(/\/#planos$/), page.locator('a', { hasText: 'Tentar novamente' }).click()]);
      await page.waitForFunction(() => {
        const r = document.getElementById('planos')?.getBoundingClientRect();
        return r && r.top < window.innerHeight && r.bottom > 0;
      });
      assert.deepEqual(watch.pageErrors, []);
    } finally { await close(); }
  });
});
