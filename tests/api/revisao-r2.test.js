// Testes do REVISOR — rodada 2 (docs/REVISAO.md, seção "Rodada 2"). Provam regressões das correções.
// Falham de propósito enquanto o defeito existir.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { startServer, patchEnv } from '../helpers/server.js';
import { installFetchMock, mpPayment } from '../helpers/fetch-mock.js';
import { startCaptureServer } from '../helpers/capture.js';
import { startObtraMock } from '../helpers/mock-products.js';
import { startUpstashMock } from '../helpers/mock-upstash.js';
import { onboardingInput, CNPJ_DIGITS } from '../helpers/fixtures.js';

// Webhook da equipe que aceita a conexão e nunca responde (n8n/Make lento ou travado).
async function startHangingHook() {
  const sockets = new Set();
  const server = http.createServer(() => { /* nunca responde */ });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/hook`,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

const payments = new Map();
let srv; let kv; let obtra; let hang; let mock; let restoreEnv;
before(async () => {
  hang = await startHangingHook();
  kv = await startUpstashMock();
  obtra = await startObtraMock();
  srv = await startServer({ env: {
    MP_ACCESS_TOKEN: 'APP_USR-r2', AQTA_TOKEN_SECRET: 'q'.repeat(48), MP_WEBHOOK_SECRET: '',
    AQTA_NOTIFY_WEBHOOK: hang.url, OBTRA_SUPABASE_URL: obtra.url, OBTRA_SUPABASE_SERVICE_KEY: obtra.serviceKey, ...kv.env,
  } });
  restoreEnv = () => {};
  mock = installFetchMock((url) => {
    if (url.hostname !== 'api.mercadopago.com') return undefined;
    const p = payments.get(url.pathname.split('/').pop());
    return p ? { status: 200, json: p } : { status: 404, json: { message: 'not found' } };
  });
});
after(async () => { mock.restore(); restoreEnv(); await srv.close(); await kv.close(); await obtra.close(); await hang.close(); });

async function approved() {
  const id = String(930000 + Math.floor(Math.random() * 60000));
  const ref = `aqta:obtra:basico:${crypto.randomUUID()}`;
  payments.set(id, mpPayment({ id: Number(id), external_reference: ref }));
  const st = await srv.request(`/api/payment-status?payment_id=${id}&external_reference=${encodeURIComponent(ref)}`);
  assert.equal(st.status, 200, st.text);
  return { id, accessToken: st.body.accessToken };
}

describe('R2-1 — notificação da equipe no caminho crítico da ativação', () => {
  test('com o webhook da equipe travado, POST /api/onboarding responde bem antes do timeout de 15 s do navegador', async () => {
    const { accessToken } = await approved();
    const t0 = Date.now();
    const r = await srv.request('/api/onboarding', { method: 'POST', body: onboardingInput(accessToken, 'obtra', { document: CNPJ_DIGITS }) });
    const ms = Date.now() - t0;
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.mode, 'auto', r.text);
    assert.ok(ms < 5000,
      `BUG: a resposta (com a senha temporária) levou ${ms} ms só esperando 3 tentativas ao webhook da equipe. ` +
      'Com o MP, o Supabase/Emptra reais e a rede do cliente, passa dos 15 s do obrigado.js (REQUEST_TIMEOUT_MS): ' +
      'o navegador aborta, a conta é criada e a senha temporária nunca chega ao cliente (a nova tentativa vira alreadyDone sem senha).');
  });
});
