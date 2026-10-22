// Testes do REVISOR (docs/REVISAO.md). Cada teste prova um achado REV-n que a suíte do testador não cobria.
// Eles FALHAM de propósito enquanto o defeito existir, como os testes de BUG-n do testador.
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, patchEnv, importProject, ROOT } from '../helpers/server.js';
import { installFetchMock, mpPayment } from '../helpers/fetch-mock.js';
import { startCaptureServer } from '../helpers/capture.js';
import { startObtraMock } from '../helpers/mock-products.js';
import { onboardingInput } from '../helpers/fixtures.js';

// Segredo do modo demo: está no código-fonte (lib/token.js) e, sem .vercelignore, também é servido pela Vercel.
const PUBLIC_DEMO_SECRET = 'aqta-demo-secret-nao-use-em-producao';

function forge(payload, secret, ttl = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + ttl })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
}

let srv;
let cap;
before(async () => {
  cap = await startCaptureServer();
  srv = await startServer({ env: { AQTA_NOTIFY_WEBHOOK: cap.url } });
});
after(async () => { await srv.close(); await cap.close(); });
beforeEach(() => cap.clear());

describe('REV-1 — modo demo + credenciais de provisionamento = contas reais de graça', () => {
  let obtra;
  before(async () => { obtra = await startObtraMock(); });
  after(() => obtra.close());

  test('token forjado com o segredo público do demo NÃO pode criar empresa/usuário reais no Obtra', async () => {
    // Cenário real: deploy sem MP_ACCESS_TOKEN (ainda sem credenciais do MP, ou preview da Vercel) mas com
    // OBTRA_SUPABASE_* configurado em "All Environments".
    const restore = patchEnv({ MP_ACCESS_TOKEN: '', OBTRA_SUPABASE_URL: obtra.url, OBTRA_SUPABASE_SERVICE_KEY: obtra.serviceKey });
    try {
      const token = forge({
        t: 'access', paymentId: 'qualquer-coisa', product: 'obtra', plan: 'basico', ref: 'aqta:obtra:basico:forjado-123',
        customer: { name: 'Atacante', email: 'x@example.com', whatsapp: '21987654321', company: 'Grátis' },
      }, PUBLIC_DEMO_SECRET);
      const r = await srv.request('/api/onboarding', { method: 'POST', body: onboardingInput(token, 'obtra') });
      assert.equal(obtra.state.usuarios.length, 0,
        `BUG: sem pagamento nenhum, o token forjado criou ${obtra.state.usuarios.length} usuário(s) real(is) no Obtra (mode=${r.body?.mode}).`);
    } finally { restore(); }
  });
});

describe('REV-2/REV-3 — reembolso e chargeback', () => {
  const payments = new Map();
  let mock;
  let restore;
  before(() => {
    restore = patchEnv({ MP_ACCESS_TOKEN: 'APP_USR-rev', AQTA_TOKEN_SECRET: 'r'.repeat(48), MP_WEBHOOK_SECRET: '' });
    mock = installFetchMock((url) => {
      if (url.hostname !== 'api.mercadopago.com') return undefined;
      const p = payments.get(url.pathname.split('/').pop());
      return p ? { status: 200, json: p } : { status: 404, json: { message: 'not found' } };
    });
  });
  after(() => { mock.restore(); restore(); });

  for (const status of ['refunded', 'charged_back']) {
    test(`REV-2: pagamento ${status} depois de emitido o accessToken ⇒ ativação recusada`, async () => {
      const id = String(700000 + Math.floor(Math.random() * 99999));
      const ref = `aqta:obtra:basico:${crypto.randomUUID()}`;
      payments.set(id, mpPayment({ id: Number(id), external_reference: ref }));
      const st = await srv.request(`/api/payment-status?payment_id=${id}&external_reference=${encodeURIComponent(ref)}`);
      assert.equal(st.status, 200, st.text);
      assert.ok(st.body.accessToken);

      // Cliente pede o estorno (ou abre chargeback) antes de ativar; o token continua válido por 7 dias.
      payments.set(id, mpPayment({ id: Number(id), external_reference: ref, status, status_detail: status }));
      const r = await srv.request('/api/onboarding', { method: 'POST', body: onboardingInput(st.body.accessToken, 'obtra') });
      assert.notEqual(r.body?.ok, true,
        `BUG: pagamento ${status} no Mercado Pago, mas /api/onboarding ativou o acesso (status ${r.status}, mode=${r.body?.mode}).`);
    });
  }

  test('REV-3: webhook de chargeback/reembolso avisa a equipe (para suspender o acesso)', async () => {
    const id = String(800000 + Math.floor(Math.random() * 99999));
    payments.set(id, mpPayment({ id: Number(id), status: 'charged_back', status_detail: 'reimbursed' }));
    const r = await srv.request(`/api/webhook?data.id=${id}&type=payment`, {
      method: 'POST', body: { action: 'payment.updated', type: 'payment', data: { id } },
    });
    assert.equal(r.status, 200, r.text);
    let got = null;
    try { got = await cap.waitFor((b) => String(b.paymentId) === id, 1000); } catch { /* nada chegou */ }
    assert.ok(got, 'BUG: chargeback/reembolso chega pelo webhook e ninguém da equipe é avisado; o acesso continua ativo.');
  });
});

describe('REV-4 — deploy na Vercel publica arquivos internos', () => {
  test('existe .vercelignore excluindo lib/, tests/, docs/ e server.js', () => {
    // A Vercel publica como estático tudo o que está na raiz (sem framework/outputDirectory). O bloqueio de
    // `lib/`, `tests/`, `docs/` e `server.js` testado em static.test.js é do server.js LOCAL, não da Vercel.
    const file = path.join(ROOT, '.vercelignore');
    assert.ok(fs.existsSync(file), 'BUG: sem .vercelignore, /lib/token.js, /server.js, /docs/ARQUITETURA.md e /tests/RELATORIO-TESTES.md ficam públicos no deploy.');
    const txt = fs.readFileSync(file, 'utf8');
    for (const p of ['lib', 'tests', 'docs', 'server.js']) assert.match(txt, new RegExp(`^/?${p.replace('.', '\\.')}`, 'm'), `.vercelignore sem ${p}`);
  });
});

describe('REV-5 — contrato de e-mail com a API real do Emptra (Zod)', () => {
  // Regex de z.string().email() do Zod 3.23 (versão do backend do Emptra: package.json "zod": "^3.23.8").
  const ZOD_EMAIL = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;

  test('todo e-mail aceito pela ativação também é aceito por POST /companies e POST /admin/users do Emptra', async () => {
    const { validateOnboarding } = await importProject('api/onboarding.js');
    const rejeitadosPeloEmptra = [];
    for (const email of ['joao.@empresa.com.br', 'compras{obra}@empresa.com.br', 'a!b@empresa.com', 'ana#1@empresa.com']) {
      const v = validateOnboarding({ ...onboardingInput('x', 'emptra'), loginEmail: email }, 'emptra');
      if (!v.fields.loginEmail && !ZOD_EMAIL.test(email)) rejeitadosPeloEmptra.push(email);
    }
    assert.deepEqual(rejeitadosPeloEmptra, [],
      'BUG: a landing aceita e-mails que o Emptra rejeita com 422 (o mock aceita qualquer e-mail): o cliente cai em "manual" sem motivo claro.');
  });
});

describe('REV-6 — webhook: notificações IPN (sem x-signature) com MP_WEBHOOK_SECRET configurado', () => {
  test('?topic=payment&id=… sem assinatura é processado (o MP não assina IPN e re-tenta 401 indefinidamente)', async () => {
    const restore = patchEnv({ MP_ACCESS_TOKEN: 'APP_USR-rev', AQTA_TOKEN_SECRET: 'r'.repeat(48), MP_WEBHOOK_SECRET: 'segredo-configurado' });
    const mock = installFetchMock((url) => (url.hostname === 'api.mercadopago.com' ? { status: 200, json: mpPayment({ id: 4242 }) } : undefined));
    try {
      const r = await srv.request('/api/webhook?topic=payment&id=4242', { method: 'POST' });
      assert.equal(r.status, 200, `BUG: IPN legítimo recusado com ${r.status} (${r.text}); o MP vai re-tentar por dias.`);
    } finally { mock.restore(); restore(); }
  });
});
