import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, patchEnv } from '../helpers/server.js';
import { installFetchMock } from '../helpers/fetch-mock.js';
import { customer, decodeToken, CPF_DIGITS, CNPJ, CNPJ_DIGITS } from '../helpers/fixtures.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

const post = (body, opts = {}) => srv.request('/api/checkout', { method: 'POST', body, ...opts });
const REF_RE = /^aqta:(obtra|emptra):basico:[0-9a-f-]{36}$/;

describe('POST /api/checkout — modo demo', () => {
  for (const [product, cents] of [['obtra', 20000], ['emptra', 30000]]) {
    test(`${product} com CPF válido ⇒ 200, init_point do checkout demo e token com preço do catálogo`, async () => {
      const r = await post({ product, plan: 'basico', customer: customer() });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.demo, true);
      assert.match(r.body.external_reference, REF_RE);
      assert.ok(r.body.external_reference.startsWith(`aqta:${product}:basico:`));
      const u = new URL(r.body.init_point);
      assert.equal(u.origin, srv.base);
      assert.equal(u.pathname, '/checkout-demo');
      const t = decodeToken(u.searchParams.get('ref'));
      assert.equal(t.t, 'demo');
      assert.equal(t.product, product);
      assert.equal(t.plan, 'basico');
      assert.equal(t.amountCents, cents);
      assert.equal(t.ref, r.body.external_reference);
      assert.equal(t.customer.document, CPF_DIGITS, 'documento normalizado só com dígitos');
      assert.equal(t.customer.whatsapp, '21987654321');
      assert.ok(t.exp - t.iat === 3600, 'validade de 1h');
    });
  }

  test('CNPJ válido, e-mail com maiúsculas e espaços extras são normalizados', async () => {
    const r = await post({ product: 'emptra', customer: customer({ document: CNPJ, email: '  Maria@Example.COM ', name: '  Maria   Souza  ' }) });
    assert.equal(r.status, 200, r.text);
    const t = decodeToken(new URL(r.body.init_point).searchParams.get('ref'));
    assert.equal(t.customer.document, CNPJ_DIGITS);
    assert.equal(t.customer.email, 'maria@example.com');
    assert.equal(t.customer.name, 'Maria Souza');
    assert.equal(t.plan, 'basico', 'plano ausente ⇒ basico');
  });

  test('produto em maiúsculas é aceito; WhatsApp com +55 e fixo de 10 dígitos são aceitos', async () => {
    assert.equal((await post({ product: 'OBTRA', customer: customer({ whatsapp: '+55 21 98765-4321' }) })).status, 200);
    assert.equal((await post({ product: 'obtra', customer: customer({ whatsapp: '(21) 3333-4444' }) })).status, 200);
  });

  test('empresa é opcional', async () => {
    const r = await post({ product: 'obtra', customer: customer({ company: '' }) });
    assert.equal(r.status, 200, r.text);
  });

  test('preço vem SEMPRE do catálogo, mesmo se o cliente mandar preço', async () => {
    const r = await post({
      product: 'emptra', plan: 'basico', price: 1, priceCents: 1, amountCents: 1, unit_price: 0.01, amount: 'R$ 0,01',
      customer: { ...customer(), amountCents: 1 },
    });
    assert.equal(r.status, 200, r.text);
    const t = decodeToken(new URL(r.body.init_point).searchParams.get('ref'));
    assert.equal(t.amountCents, 30000);
    assert.equal(t.customer.amountCents, undefined, 'campos desconhecidos do cliente não entram no token');
  });
});

describe('POST /api/checkout — validação campo a campo', () => {
  const cases = [
    ['name', { name: '' }], ['name', { name: 'Al' }], ['name', { name: '1234' }], ['name', { name: 'A'.repeat(121) }],
    ['email', { email: '' }], ['email', { email: 'maria' }], ['email', { email: 'maria@' }], ['email', { email: 'a@b.c' }],
    ['email', { email: 'maria..x@example.com' }], ['email', { email: 'maria @example.com' }],
    ['whatsapp', { whatsapp: '' }], ['whatsapp', { whatsapp: '123' }], ['whatsapp', { whatsapp: '(01) 98765-4321' }],
    ['whatsapp', { whatsapp: '(21) 88765-4321' }], ['whatsapp', { whatsapp: '(21) 1234-5678' }], ['whatsapp', { whatsapp: '9'.repeat(14) }],
    ['document', { document: '' }], ['document', { document: '529.982.247-24' }], ['document', { document: '111.111.111-11' }],
    ['document', { document: '11.222.333/0001-80' }], ['document', { document: '123' }], ['document', { document: '00000000000000' }],
    ['company', { company: 'E'.repeat(121) }],
  ];
  for (const [field, patch] of cases) {
    test(`${field} inválido (${JSON.stringify(Object.values(patch)[0]).slice(0, 30)}) ⇒ 400 validation.fields.${field}`, async () => {
      const r = await post({ product: 'obtra', customer: customer(patch) });
      assert.equal(r.status, 400, r.text);
      assert.equal(r.body.error, 'validation');
      assert.ok(r.body.fields[field], `esperava erro em ${field}: ${r.text}`);
      assert.deepEqual(Object.keys(r.body.fields), [field], 'só o campo inválido deve ter erro');
    });
  }

  test('cliente ausente ⇒ 400 com todos os campos obrigatórios', async () => {
    const r = await post({ product: 'obtra' });
    assert.equal(r.status, 400);
    assert.deepEqual(Object.keys(r.body.fields).sort(), ['document', 'email', 'name', 'whatsapp']);
  });

  test('cliente com tipos errados (array/número/objeto) não derruba o servidor', async () => {
    for (const c of [[], 42, 'texto', null, { name: { a: 1 }, email: ['x'], whatsapp: 1, document: true }]) {
      const r = await post({ product: 'obtra', customer: c });
      assert.equal(r.status, 400, JSON.stringify(c));
      assert.equal(r.body.error, 'validation');
    }
  });
});

describe('POST /api/checkout — produto/plano, métodos e corpo', () => {
  for (const [product, plan] of [['', 'basico'], ['xpto', 'basico'], ['__proto__', 'basico'], ['constructor', 'basico'],
    ['toString', 'basico'], ['obtra', 'premium'], ['obtra', '__proto__'], ['obtra', 'constructor'], ['hasOwnProperty', undefined]]) {
    test(`produto/plano inválido (${product}/${plan}) ⇒ 400 invalid_product`, async () => {
      const r = await post({ product, plan, customer: customer() });
      assert.equal(r.status, 400, r.text);
      assert.equal(r.body.error, 'invalid_product');
    });
  }

  test('produto não-string (objeto/array/número) ⇒ 400 invalid_product', async () => {
    for (const product of [{ id: 'obtra' }, ['obtra'], 1, null, true]) {
      const r = await post({ product, customer: customer() });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'invalid_product');
    }
  });

  test('chave "__proto__" literal no JSON não polui o protótipo', async () => {
    const raw = `{"product":"obtra","__proto__":{"polluted":"yes"},"customer":${JSON.stringify(customer())}}`;
    const r = await srv.request('/api/checkout', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(({}).polluted, undefined);
  });

  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    test(`${method} ⇒ 405 com Allow: POST`, async () => {
      const r = await srv.request('/api/checkout', { method, ...(method === 'GET' ? {} : { body: {} }) });
      assert.equal(r.status, 405);
      assert.equal(r.headers.get('allow'), 'POST');
    });
  }

  test('corpo grande (> 4 KB) ⇒ 413', async () => {
    const r = await post({ product: 'obtra', customer: customer({ company: 'x'.repeat(5000) }) });
    assert.equal(r.status, 413);
    assert.equal(r.body.error, 'payload_too_large');
    const r2 = await post({ product: 'obtra', customer: customer(), junk: 'y'.repeat(10_000) });
    assert.equal(r2.status, 413);
  });

  test('JSON inválido / corpo vazio / array ⇒ 400 sem 500', async () => {
    const bad = await srv.request('/api/checkout', { method: 'POST', body: '{"product":', headers: { 'Content-Type': 'application/json' } });
    assert.equal(bad.status, 400);
    const empty = await srv.request('/api/checkout', { method: 'POST', body: '', headers: { 'Content-Type': 'application/json' } });
    assert.equal(empty.status, 400);
    const arr = await srv.request('/api/checkout', { method: 'POST', body: '[1,2]', headers: { 'Content-Type': 'application/json' } });
    assert.equal(arr.status, 400);
  });
});

describe('REV-7 / REV-10', () => {
  test('e-mail com a regra do Zod do Emptra: recusa os que o Emptra recusaria com 422', async () => {
    for (const email of ['joao.@empresa.com.br', 'a!b@empresa.com', 'ana#1@empresa.com', 'compras{obra}@empresa.com.br', '.ana@empresa.com']) {
      const r = await srv.request('/api/checkout', { method: 'POST', body: { product: 'obtra', customer: customer({ email }) } });
      assert.equal(r.status, 400, email);
      assert.ok(r.body.fields?.email, email);
    }
    for (const email of ['ana.silva+obra@empresa.com.br', "o'brien@empresa.com"]) {
      const r = await srv.request('/api/checkout', { method: 'POST', body: { product: 'obtra', customer: customer({ email }) } });
      assert.equal(r.status, 200, `${email}: ${r.text}`);
    }
  });

  test('POST sem application/json ⇒ 415 (text/plain cross-site não passa)', async () => {
    const body = JSON.stringify({ product: 'obtra', customer: customer() });
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded']) {
      const r = await srv.request('/api/checkout', { method: 'POST', body, headers: { 'Content-Type': ct } });
      assert.equal(r.status, 415, ct);
    }
    const bad = await srv.request('/api/checkout', { method: 'POST', body: '{"product":', headers: { 'Content-Type': 'application/json' } });
    assert.equal(bad.body.error, 'invalid_json');
  });
});

describe('POST /api/checkout — produção simulada (Mercado Pago via fetch mock)', () => {
  test('cria preferência com preço do catálogo, back_urls, notification_url, idempotência e metadata', async () => {
    const restore = patchEnv({ MP_ACCESS_TOKEN: 'TEST-abc', AQTA_TOKEN_SECRET: 's'.repeat(40), PUBLIC_BASE_URL: 'https://aqta.example.com/' });
    const mock = installFetchMock((url) => {
      if (url.hostname === 'api.mercadopago.com') return { status: 201, json: { id: 'pref-1', init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1' } };
    });
    try {
      const r = await post({ product: 'obtra', plan: 'basico', price: 1, customer: customer({ document: CNPJ }) });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.demo, false);
      assert.match(r.body.init_point, /^https:\/\/www\.mercadopago\.com\.br\//);
      const call = mock.calls.find((c) => c.url === 'https://api.mercadopago.com/checkout/preferences');
      assert.ok(call, 'deveria chamar /checkout/preferences');
      assert.equal(call.method, 'POST');
      assert.equal(call.headers.authorization, 'Bearer TEST-abc');
      assert.equal(call.headers['x-idempotency-key'], r.body.external_reference);
      const pref = call.body;
      assert.equal(pref.items.length, 1);
      assert.equal(pref.items[0].unit_price, 200);
      assert.equal(pref.items[0].currency_id, 'BRL');
      assert.equal(pref.items[0].quantity, 1);
      assert.equal(pref.external_reference, r.body.external_reference);
      assert.deepEqual(pref.back_urls, { success: 'https://aqta.example.com/obrigado', pending: 'https://aqta.example.com/obrigado', failure: 'https://aqta.example.com/obrigado' });
      assert.equal(pref.auto_return, 'approved');
      assert.equal(pref.notification_url, 'https://aqta.example.com/api/webhook');
      assert.equal(pref.statement_descriptor, 'AQTA');
      assert.equal(pref.payer.identification.type, 'CNPJ');
      assert.equal(pref.payer.identification.number, CNPJ_DIGITS);
      assert.deepEqual(pref.payer.phone, { area_code: '21', number: '987654321' });
      assert.deepEqual(Object.keys(pref.metadata).sort(), ['customer_company', 'customer_document', 'customer_email', 'customer_name', 'customer_whatsapp', 'plan', 'product']);
    } finally { mock.restore(); restore(); }
  });

  test('Emptra em produção ⇒ unit_price 300', async () => {
    const restore = patchEnv({ MP_ACCESS_TOKEN: 'TEST-abc', AQTA_TOKEN_SECRET: 's'.repeat(40) });
    const mock = installFetchMock((url) => (url.hostname === 'api.mercadopago.com' ? { status: 201, json: { init_point: 'https://mp/x' } } : undefined));
    try {
      const r = await post({ product: 'emptra', customer: customer() });
      assert.equal(r.status, 200);
      assert.equal(mock.calls[0].body.items[0].unit_price, 300);
    } finally { mock.restore(); restore(); }
  });

  test('falha do Mercado Pago (500 / rede / sem init_point) ⇒ 502 com mensagem amigável', async () => {
    const restore = patchEnv({ MP_ACCESS_TOKEN: 'TEST-abc', AQTA_TOKEN_SECRET: 's'.repeat(40) });
    for (const behavior of [{ status: 500, json: { message: 'boom' } }, new TypeError('fetch failed'), { status: 201, json: { id: 'x' } }, { status: 401, json: { message: 'invalid token' } }]) {
      const mock = installFetchMock((url) => (url.hostname === 'api.mercadopago.com' ? behavior : undefined));
      try {
        const r = await post({ product: 'obtra', customer: customer() });
        assert.equal(r.status, 502, JSON.stringify(behavior));
        assert.equal(r.body.error, 'payment_provider');
        assert.ok(r.body.message);
        assert.doesNotMatch(r.text, /boom|invalid token/, 'não vaza detalhe do provedor');
      } finally { mock.restore(); }
    }
    restore();
  });
});
