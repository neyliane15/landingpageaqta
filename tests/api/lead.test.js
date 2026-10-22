import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, patchEnv } from '../helpers/server.js';
import { startCaptureServer } from '../helpers/capture.js';

let srv;
let cap;
let ipSeq = 1;
before(async () => {
  cap = await startCaptureServer();
  srv = await startServer({ env: { AQTA_NOTIFY_WEBHOOK: cap.url, AQTA_WHATSAPP: '+55 (21) 98888-7777' } });
});
after(async () => { await srv.close(); await cap.close(); });
beforeEach(() => cap.clear());

const lead = (o = {}) => ({
  name: 'João Lead', email: 'joao@empresa.com.br', whatsapp: '(21) 99876-5432', company: 'Empresa X',
  message: 'Quero um sistema de medições integrado ao RDO.', website: '', ...o,
});
// Cada teste usa um "IP" próprio para não esbarrar no rate limit dos outros.
const post = (body, ip = `10.0.0.${ipSeq++}`) => srv.request('/api/lead', { method: 'POST', body, headers: { 'x-forwarded-for': ip } });

test('lead válido ⇒ 200 ok, whatsappUrl wa.me com mensagem e notificação lead.custom_system', async () => {
  const r = await post(lead());
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.ok, true);
  const u = new URL(r.body.whatsappUrl);
  assert.equal(u.origin + u.pathname, 'https://wa.me/5521988887777');
  assert.match(u.searchParams.get('text'), /Sou João Lead, da Empresa X/);
  const ev = (await cap.waitFor((b) => b.event === 'lead.custom_system')).body;
  assert.equal(ev.name, 'João Lead');
  assert.equal(ev.email, 'joao@empresa.com.br');
  assert.equal(ev.whatsapp, '21998765432');
  assert.equal(ev.company, 'Empresa X');
  assert.match(ev.message, /medições/);
});

test('sem AQTA_WHATSAPP ⇒ whatsappUrl null (sem link quebrado)', async () => {
  const restore = patchEnv({ AQTA_WHATSAPP: '' });
  try {
    const r = await post(lead());
    assert.equal(r.status, 200);
    assert.equal(r.body.whatsappUrl, null);
  } finally { restore(); }
});

test('empresa e mensagem são opcionais no servidor', async () => {
  const r = await post(lead({ company: '', message: '' }));
  assert.equal(r.status, 200, r.text);
  assert.doesNotMatch(new URL(r.body.whatsappUrl).searchParams.get('text'), /, da /);
});

test('honeypot preenchido ⇒ 200 {ok:true} sem notificar e sem whatsappUrl', async () => {
  const r = await post(lead({ website: 'http://spam.example' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(cap.requests.length, 0);
  // honeypot vence até a validação (robô não aprende nada)
  const r2 = await post({ website: 'x' });
  assert.equal(r2.status, 200);
});

for (const [field, patch] of [
  ['name', { name: '' }], ['name', { name: 'Jo' }], ['name', { name: '12345' }], ['name', { name: 'N'.repeat(121) }],
  ['email', { email: 'joao' }], ['email', { email: '' }], ['email', { email: 'a@b.c' }],
  ['whatsapp', { whatsapp: '' }], ['whatsapp', { whatsapp: '1234' }], ['whatsapp', { whatsapp: '(00) 99876-5432' }],
  ['company', { company: 'C'.repeat(121) }], ['message', { message: 'M'.repeat(2001) }],
]) {
  test(`${field} inválido ⇒ 400 fields.${field}`, async () => {
    const r = await post(lead(patch));
    assert.equal(r.status, 400, r.text);
    assert.equal(r.body.error, 'validation');
    assert.ok(r.body.fields[field], r.text);
  });
}

test('corpo grande ⇒ 413; GET ⇒ 405', async () => {
  const r = await post(lead({ message: 'x'.repeat(7000) }));
  assert.equal(r.status, 413);
  const g = await srv.request('/api/lead');
  assert.equal(g.status, 405);
});

test('rate limit: 6º envio do mesmo IP em 10 min ⇒ 429 com whatsappUrl; outro IP segue livre', async () => {
  const ip = '192.0.2.77';
  for (let i = 0; i < 5; i++) {
    const r = await post(lead(), ip);
    assert.equal(r.status, 200, `envio ${i + 1}`);
  }
  const blocked = await post(lead(), ip);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
  assert.match(blocked.body.whatsappUrl, /^https:\/\/wa\.me\//);
  assert.equal((await post(lead(), '192.0.2.78')).status, 200);
});

