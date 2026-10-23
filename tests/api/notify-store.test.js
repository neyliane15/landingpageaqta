// lib/notify.js (REV-5: tentativas + registro durável) e lib/store.js (Upstash REST / memória só fora de produção).
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyEnv, patchEnv, importProject } from '../helpers/server.js';
import { startCaptureServer } from '../helpers/capture.js';
import { startUpstashMock } from '../helpers/mock-upstash.js';

let cap;
let kv;
let restoreEnv;
let notifyTeam;
let store;
before(async () => {
  restoreEnv = applyEnv({});
  cap = await startCaptureServer();
  kv = await startUpstashMock();
  ({ notifyTeam } = await importProject('lib/notify.js'));
  store = await importProject('lib/store.js');
});
after(async () => { restoreEnv(); await cap.close(); await kv.close(); });
beforeEach(() => { cap.clear(); cap.setStatus(200); kv.clear(); kv.state.opts.down = false; });

function captureConsole(fn) {
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  return Promise.resolve(fn()).finally(() => { console.error = orig; }).then(() => errors);
}

describe('notifyTeam', () => {
  test('webhook 500 ⇒ 3 tentativas e devolve false; 200 na 1ª ⇒ 1 envio e true', async () => {
    const restore = patchEnv({ AQTA_NOTIFY_WEBHOOK: cap.url });
    try {
      cap.setStatus(500);
      let ok;
      await captureConsole(async () => { ok = await notifyTeam({ event: 'lead.custom_system', name: 'X' }); });
      assert.equal(ok, false);
      assert.equal(cap.requests.length, 3);
      cap.clear(); cap.setStatus(200);
      assert.equal(await notifyTeam({ event: 'lead.custom_system', name: 'Y' }), true);
      assert.equal(cap.requests.length, 1);
    } finally { restore(); }
  });

  test('webhook 400 (erro permanente) ⇒ não insiste', async () => {
    const restore = patchEnv({ AQTA_NOTIFY_WEBHOOK: cap.url });
    try {
      cap.setStatus(400);
      await captureConsole(() => notifyTeam({ event: 'x' }));
      assert.equal(cap.requests.length, 1);
    } finally { restore(); }
  });

  test('com armazenamento: todo evento vai para aqta:events (sem campos secretos), mesmo com o webhook fora', async () => {
    const restore = patchEnv({ AQTA_NOTIFY_WEBHOOK: cap.url, ...kv.env, MP_ACCESS_TOKEN: 'APP_USR-x' });
    try {
      cap.setStatus(500);
      await captureConsole(() => notifyTeam({ event: 'onboarding.completed', company: 'ACME', tempPassword: 'segredo123', accessToken: 'tok' }));
      const [ev] = kv.list('aqta:events');
      assert.equal(ev.event, 'onboarding.completed');
      assert.equal(ev.company, 'ACME');
      assert.equal(ev.tempPassword, undefined);
      assert.equal(ev.accessToken, undefined);
    } finally { restore(); }
  });

  test('produção sem webhook E sem armazenamento ⇒ console.error bem visível a cada evento', async () => {
    const restore = patchEnv({ MP_ACCESS_TOKEN: 'APP_USR-x', AQTA_NOTIFY_WEBHOOK: '' });
    try {
      const errors = await captureConsole(() => notifyTeam({ event: 'lead.custom_system', name: 'Z' }));
      assert.ok(errors.some((e) => /SEM AQTA_NOTIFY_WEBHOOK E SEM ARMAZENAMENTO/.test(e)), errors.join('\n'));
    } finally { restore(); }
  });
});

describe('store', () => {
  test('Upstash: setIfAbsent (SET NX EX), get, set, del e pushLog (LPUSH + LTRIM 1000)', async () => {
    const restore = patchEnv({ ...kv.env, MP_ACCESS_TOKEN: 'APP_USR-x' });
    try {
      assert.equal(store.storeMode(), 'redis');
      assert.equal(await store.setIfAbsent('k1', { a: 1 }, 60), true);
      assert.equal(await store.setIfAbsent('k1', { a: 2 }, 60), false);
      assert.deepEqual(await store.get('k1'), { a: 1 });
      const setCall = kv.state.calls.find((c) => c.path === '/' && c.body[0] === 'SET');
      assert.deepEqual(setCall.body, ['SET', 'k1', '{"a":1}', 'NX', 'EX', '60']);
      await store.set('k1', { a: 3 });
      assert.deepEqual(await store.get('k1'), { a: 3 });
      await store.del('k1');
      assert.equal(await store.get('k1'), null);
      for (let i = 0; i < 1005; i++) await store.pushLog('lst', { i });
      const l = kv.list('lst');
      assert.equal(l.length, 1000);
      assert.equal(l[0].i, 1004);
    } finally { restore(); }
  });

  test('UPSTASH_REDIS_REST_* é aceito como alternativa a KV_REST_API_*', async () => {
    const restore = patchEnv({ UPSTASH_REDIS_REST_URL: kv.url, UPSTASH_REDIS_REST_TOKEN: kv.token, MP_ACCESS_TOKEN: 'APP_USR-x' });
    try {
      assert.equal(store.storeMode(), 'redis');
      assert.equal(await store.setIfAbsent('k2', 1, 10), true);
    } finally { restore(); }
  });

  test('Redis fora do ar ⇒ StoreError (pushLog nunca lança)', async () => {
    const restore = patchEnv({ ...kv.env, MP_ACCESS_TOKEN: 'APP_USR-x' });
    kv.state.opts.down = true;
    try {
      await assert.rejects(store.setIfAbsent('k3', 1, 10), { name: 'StoreError' });
      await captureConsole(async () => assert.equal(await store.pushLog('l', {}), false));
    } finally { restore(); }
  });

  test('sem configuração: memória no demo, NADA em produção (sem falsa garantia)', async () => {
    let restore = patchEnv({ MP_ACCESS_TOKEN: '' });
    try {
      assert.equal(store.storeMode(), 'memory');
      assert.equal(await store.setIfAbsent('m1', 1, 10), true);
      assert.equal(await store.setIfAbsent('m1', 1, 10), false);
    } finally { restore(); }
    restore = patchEnv({ MP_ACCESS_TOKEN: 'APP_USR-x' });
    try {
      assert.equal(store.storeMode(), 'none');
      assert.equal(store.hasDurableStore(), false);
      assert.equal(await store.get('m1'), null);
      await assert.rejects(store.setIfAbsent('m1', 1, 10), { code: 'store_not_configured' });
    } finally { restore(); }
  });
});
