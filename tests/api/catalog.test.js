import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, patchEnv } from '../helpers/server.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

test('GET /api/catalog devolve Obtra R$ 200 e Emptra R$ 300 (centavos e texto) e demo=true', async () => {
  const r = await srv.request('/api/catalog');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.body.demo, true);
  const byId = Object.fromEntries(r.body.products.map((p) => [p.id, p]));
  assert.deepEqual(Object.keys(byId).sort(), ['emptra', 'obtra']);
  const ob = byId.obtra.plans.find((p) => p.id === 'basico');
  const em = byId.emptra.plans.find((p) => p.id === 'basico');
  assert.equal(ob.priceCents, 20000);
  assert.equal(em.priceCents, 30000);
  // toLocaleString usa NBSP entre "R$" e o número
  assert.equal(ob.price.replace(/\s/g, ' '), 'R$ 200,00');
  assert.equal(em.price.replace(/\s/g, ' '), 'R$ 300,00');
  assert.equal(ob.interval, 'mês');
  for (const p of r.body.products) {
    assert.ok(p.name && p.tagline);
    assert.equal(p.appUrl, undefined, 'não deve expor dados internos');
  }
});

test('GET /api/catalog: demo=false quando MP_ACCESS_TOKEN existe', async () => {
  const restore = patchEnv({ MP_ACCESS_TOKEN: 'TEST-123', AQTA_TOKEN_SECRET: 'x'.repeat(32) });
  try {
    const r = await srv.request('/api/catalog');
    assert.equal(r.status, 200);
    assert.equal(r.body.demo, false);
  } finally { restore(); }
});

test('HEAD /api/catalog é aceito; POST/PUT/DELETE ⇒ 405 com Allow', async () => {
  const h = await srv.request('/api/catalog', { method: 'HEAD' });
  assert.equal(h.status, 200);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await srv.request('/api/catalog', { method, body: {} });
    assert.equal(r.status, 405, method);
    assert.equal(r.body.error, 'method_not_allowed');
    assert.match(r.headers.get('allow'), /GET/);
  }
});

test('BUG-5: support vem de AQTA_WHATSAPP (só dígitos + wa.me); null sem configuração', async () => {
  let r = await srv.request('/api/catalog');
  assert.equal(r.body.support, null);
  const restore = patchEnv({ AQTA_WHATSAPP: '+55 (21) 98888-7777' });
  try {
    r = await srv.request('/api/catalog');
    assert.deepEqual(r.body.support, { whatsapp: '5521988887777', whatsappUrl: 'https://wa.me/5521988887777' });
  } finally { restore(); }
});

test('emptraCategories: categorias do catálogo do Emptra (slug + nome) para o perfil fornecedor', async () => {
  const r = await srv.request('/api/catalog');
  assert.ok(Array.isArray(r.body.emptraCategories) && r.body.emptraCategories.length >= 20);
  assert.ok(r.body.emptraCategories.some((c) => c.slug === 'hidraulica' && c.name === 'Hidráulica — tubos e conexões'));
});
