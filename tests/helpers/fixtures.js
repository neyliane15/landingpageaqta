// Dados de teste e atalhos para o fluxo de compra via API (modo demo).
import assert from 'node:assert/strict';
import { importProject } from './server.js';

// CPF/CNPJ com dígitos verificadores válidos (números públicos de exemplo).
export const CPF = '529.982.247-25';
export const CPF_DIGITS = '52998224725';
export const CNPJ = '11.222.333/0001-81';
export const CNPJ_DIGITS = '11222333000181';

export function customer(overrides = {}) {
  return {
    name: 'Maria Teste da Silva',
    email: 'maria.teste@example.com',
    whatsapp: '(21) 98765-4321',
    document: CPF,
    company: 'Construtora Teste Ltda',
    ...overrides,
  };
}

export function onboardingInput(accessToken, product = 'obtra', overrides = {}) {
  const extra = product === 'emptra'
    ? { perfil: 'comprador', cidade: 'Niterói', uf: 'RJ' }
    : { obrasAtivas: '4-10', cidade: 'Niterói', uf: 'RJ' };
  return {
    accessToken,
    company: 'Construtora Teste Ltda',
    document: CNPJ_DIGITS,
    responsible: 'Maria Teste da Silva',
    loginEmail: `login.${Math.random().toString(36).slice(2, 8)}@example.com`,
    whatsapp: '21987654321',
    extra,
    ...overrides,
  };
}

/** Decodifica o payload de um token (sem verificar). */
export function decodeToken(token) {
  const t = String(token).replace(/^demo_/, '');
  return JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'));
}

/** Assina um token como se "agora" fosse deslocado em offsetSeconds (negativo = passado). */
export async function signTokenAt(offsetSeconds, payload, ttl) {
  const { signToken } = await importProject('lib/token.js');
  const orig = Date.now;
  Date.now = () => orig() + offsetSeconds * 1000;
  try { return signToken(payload, ttl); } finally { Date.now = orig; }
}

/** checkout (demo) → { token, init_point, external_reference } */
export async function demoCheckout(srv, product = 'obtra', cust = customer()) {
  const r = await srv.request('/api/checkout', { method: 'POST', body: { product, plan: 'basico', customer: cust } });
  assert.equal(r.status, 200, `checkout falhou: ${r.text}`);
  const token = new URL(r.body.init_point).searchParams.get('ref');
  return { ...r.body, token };
}

/** checkout + demo-pay → { paymentId, externalReference, status, redirect } */
export async function demoPurchase(srv, product = 'obtra', outcome = 'approved', cust) {
  const co = await demoCheckout(srv, product, cust);
  const r = await srv.request('/api/demo-pay', { method: 'POST', body: { ref: co.token, outcome } });
  assert.equal(r.status, 200, `demo-pay falhou: ${r.text}`);
  const u = new URL(r.body.redirect, 'http://x');
  return {
    paymentId: u.searchParams.get('payment_id'),
    externalReference: u.searchParams.get('external_reference'),
    status: u.searchParams.get('status'),
    redirect: r.body.redirect,
    checkoutToken: co.token,
  };
}

/** Compra aprovada (demo) → accessToken de /api/payment-status */
export async function approvedAccess(srv, product = 'obtra') {
  const p = await demoPurchase(srv, product, 'approved');
  const r = await srv.request(`/api/payment-status?payment_id=${encodeURIComponent(p.paymentId)}&external_reference=${encodeURIComponent(p.externalReference)}`);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.body.accessToken, 'accessToken ausente');
  return { ...p, accessToken: r.body.accessToken, status: r.body };
}
