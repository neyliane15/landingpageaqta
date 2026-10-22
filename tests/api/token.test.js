// lib/token.js — assinatura HMAC, adulteração, expiração e regras do segredo.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { applyEnv, importProject } from '../helpers/server.js';
import { signTokenAt } from '../helpers/fixtures.js';

const { signToken, verifyToken } = await importProject('lib/token.js');
let restore;
beforeEach(() => { restore = applyEnv(); });
afterEach(() => restore());

const PROD = { MP_ACCESS_TOKEN: 'APP_USR-123' };

describe('signToken / verifyToken', () => {
  test('ida e volta preserva o payload e acrescenta iat/exp', () => {
    const t = signToken({ t: 'access', a: 1, nested: { b: 'ç' } }, 60);
    assert.match(t, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const p = verifyToken(t);
    assert.equal(p.t, 'access');
    assert.equal(p.a, 1);
    assert.equal(p.nested.b, 'ç');
    assert.equal(p.exp - p.iat, 60);
  });

  test('assinatura é HMAC-SHA256(segredo, corpo) em base64url', () => {
    process.env.AQTA_TOKEN_SECRET = 'segredo-de-teste-com-32-caracteres!!';
    const t = signToken({ x: 1 }, 60);
    const [body, sig] = t.split('.');
    assert.equal(sig, crypto.createHmac('sha256', process.env.AQTA_TOKEN_SECRET).update(body).digest('base64url'));
  });

  test('payload adulterado ⇒ null', () => {
    const t = signToken({ t: 'access', product: 'obtra', amountCents: 20000 }, 60);
    const [body, sig] = t.split('.');
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    p.amountCents = 1;
    const forged = `${Buffer.from(JSON.stringify(p)).toString('base64url')}.${sig}`;
    assert.equal(verifyToken(forged), null);
  });

  test('assinatura adulterada / truncada / ausente ⇒ null', () => {
    const t = signToken({ a: 1 }, 60);
    const [body, sig] = t.split('.');
    const flip = sig[0] === 'A' ? 'B' : 'A';
    assert.equal(verifyToken(`${body}.${flip}${sig.slice(1)}`), null);
    assert.equal(verifyToken(`${body}.${sig.slice(0, -2)}`), null);
    assert.equal(verifyToken(`${body}.`), null);
    assert.equal(verifyToken(body), null);
    assert.equal(verifyToken(`${t}.extra`), null);
  });

  test('entradas malformadas nunca lançam', () => {
    for (const bad of [undefined, null, '', 42, {}, [], '...', 'a.b', '%%%.%%%', 'x'.repeat(9000), `${'a'.repeat(10)}.${'b'.repeat(10)}`]) {
      assert.equal(verifyToken(bad), null, String(bad).slice(0, 20));
    }
  });

  test('corpo assinado mas que não é objeto JSON ⇒ null', () => {
    process.env.AQTA_TOKEN_SECRET = 'segredo-de-teste-com-32-caracteres!!';
    const sign = (s) => { const b = Buffer.from(s).toString('base64url'); return `${b}.${crypto.createHmac('sha256', process.env.AQTA_TOKEN_SECRET).update(b).digest('base64url')}`; };
    assert.equal(verifyToken(sign('[1,2]')), null);
    assert.equal(verifyToken(sign('"str"')), null);
    assert.equal(verifyToken(sign('{nao json')), null);
    assert.equal(verifyToken(sign('{"a":1}')), null, 'sem exp ⇒ inválido');
    assert.equal(verifyToken(sign(`{"a":1,"exp":"${Date.now()}"}`)), null, 'exp não numérico ⇒ inválido');
  });

  test('token expirado ⇒ null; ainda válido ⇒ payload', async () => {
    const expired = await signTokenAt(-120, { a: 1 }, 60);
    assert.equal(verifyToken(expired), null);
    const valid = await signTokenAt(-30, { a: 1 }, 60);
    assert.equal(verifyToken(valid).a, 1);
  });

  test('ttl inválido / payload não-objeto ⇒ TypeError', () => {
    assert.throws(() => signToken({ a: 1 }, 0), TypeError);
    assert.throws(() => signToken({ a: 1 }, -5), TypeError);
    assert.throws(() => signToken({ a: 1 }, 'abc'), TypeError);
    assert.throws(() => signToken(null, 60), TypeError);
    assert.throws(() => signToken([1], 60), TypeError);
    assert.throws(() => signToken('x', 60), TypeError);
  });

  test('token assinado com outro segredo ⇒ null', () => {
    process.env.AQTA_TOKEN_SECRET = 'segredo-A-com-pelo-menos-32-caracteres';
    const t = signToken({ a: 1 }, 60);
    process.env.AQTA_TOKEN_SECRET = 'segredo-B-com-pelo-menos-32-caracteres';
    assert.equal(verifyToken(t), null);
  });
});

describe('segredo (AQTA_TOKEN_SECRET)', () => {
  test('demo sem segredo ⇒ usa segredo de desenvolvimento (funciona)', () => {
    const t = signToken({ a: 1 }, 60);
    assert.equal(verifyToken(t).a, 1);
  });

  test('token demo (segredo de desenvolvimento) NÃO vale em produção', () => {
    const t = signToken({ a: 1 }, 60);
    Object.assign(process.env, PROD, { AQTA_TOKEN_SECRET: 'p'.repeat(40) });
    assert.equal(verifyToken(t), null);
  });

  test('produção sem segredo ⇒ lança erro de configuração (sign e verify)', () => {
    Object.assign(process.env, PROD);
    assert.throws(() => signToken({ a: 1 }, 60), /AQTA_TOKEN_SECRET/);
    assert.throws(() => verifyToken('abc.def'), /AQTA_TOKEN_SECRET/);
  });

  for (const weak of ['troque-este-segredo', 'changeme', 'secret']) {
    test(`produção com segredo de exemplo "${weak}" ⇒ lança`, () => {
      Object.assign(process.env, PROD, { AQTA_TOKEN_SECRET: weak });
      assert.throws(() => signToken({ a: 1 }, 60), /AQTA_TOKEN_SECRET/);
    });
  }

  test('produção com segredo curto (< 16) ⇒ lança', () => {
    Object.assign(process.env, PROD, { AQTA_TOKEN_SECRET: 'curto123' });
    assert.throws(() => signToken({ a: 1 }, 60), /muito curto/);
  });

  test('produção com segredo forte ⇒ funciona', () => {
    Object.assign(process.env, PROD, { AQTA_TOKEN_SECRET: crypto.randomBytes(32).toString('hex') });
    const t = signToken({ a: 1 }, 60);
    assert.equal(verifyToken(t).a, 1);
  });
});
