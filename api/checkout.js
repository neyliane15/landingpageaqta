// POST /api/checkout — inicia a compra: valida o cliente, cria a preferência do Mercado Pago
// (ou, em modo demo, um link para o gateway simulado) e devolve o init_point.
//
// Também exporta os validadores para reuso (ex.: api/onboarding.js, api/lead.js):
//   import { validateCustomer, isValidCpfCnpj, isValidEmail, ... } from './checkout.js';
import { randomUUID } from 'node:crypto';
import { send, allow, body, baseUrl, isDemo } from '../lib/http.js';
import { getPlan } from '../lib/catalog.js';
import { createPreference } from '../lib/mercadopago.js';

const MAX_BODY_CHARS = 4096;
export const LIMITS = { name: 120, email: 254, company: 120 };

// ---------------------------------------------------------------- normalização

export const onlyDigits = (v) => String(v ?? '').replace(/\D+/g, '');
export const cleanText = (v, max = 200) =>
  String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
export const normalizeEmail = (v) => String(v ?? '').trim().toLowerCase();

// ---------------------------------------------------------------- validadores

export function isValidEmail(v) {
  const s = String(v ?? '');
  if (s.length < 6 || s.length > LIMITS.email) return false;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i.test(s)
    && !s.includes('..');
}

export function isValidCpf(v) {
  const d = onlyDigits(v);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const dv = ((sum * 10) % 11) % 10;
    if (dv !== Number(d[len])) return false;
  }
  return true;
}

export function isValidCnpj(v) {
  const d = onlyDigits(v);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

export const isValidCpfCnpj = (v) => isValidCpf(v) || isValidCnpj(v);
export const documentType = (v) => (onlyDigits(v).length === 14 ? 'CNPJ' : 'CPF');

/** Separa WhatsApp BR em { country, area, number } (aceita com ou sem 55). null se inválido. */
export function parseWhatsapp(v) {
  let d = onlyDigits(v);
  if (d.length < 10 || d.length > 13) return null;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  const area = d.slice(0, 2);
  const number = d.slice(2);
  if (!/^[1-9][1-9]$/.test(area)) return null;
  if (number.length === 9 && number[0] !== '9') return null; // celular com 9 dígitos começa com 9
  if (number.length === 8 && !/^[2-9]/.test(number)) return null;
  return { country: '55', area, number };
}
export const isValidWhatsapp = (v) => parseWhatsapp(v) !== null;

export function isValidName(v) {
  const s = cleanText(v, LIMITS.name + 1);
  return s.length >= 3 && s.length <= LIMITS.name && /\p{L}/u.test(s);
}

/** Normaliza: trim, e-mail minúsculo, só dígitos em documento/WhatsApp. */
export function normalizeCustomer(c = {}) {
  const src = c && typeof c === 'object' ? c : {};
  return {
    name: cleanText(src.name, LIMITS.name + 1),
    email: normalizeEmail(src.email),
    whatsapp: onlyDigits(src.whatsapp).slice(0, 20),
    document: onlyDigits(src.document).slice(0, 20),
    company: cleanText(src.company, LIMITS.company + 1),
  };
}

/**
 * Valida (e normaliza) os dados do cliente com as mesmas regras do checkout.
 * @param {object} input { name, email, whatsapp, document, company }
 * @param {{ requireCompany?: boolean }} [opts]
 * @returns {{ ok: boolean, customer: object, fields: Record<string,string> }}
 */
export function validateCustomer(input, { requireCompany = false } = {}) {
  const customer = normalizeCustomer(input);
  const fields = {};
  if (!isValidName(customer.name)) fields.name = 'Informe o nome completo (mínimo 3 letras).';
  if (!isValidEmail(customer.email)) fields.email = 'Informe um e-mail válido.';
  if (!isValidWhatsapp(customer.whatsapp)) fields.whatsapp = 'Informe um WhatsApp com DDD (ex.: (11) 91234-5678).';
  if (!customer.document) fields.document = 'Informe o CPF ou CNPJ.';
  else if (!isValidCpfCnpj(customer.document)) {
    fields.document = customer.document.length === 14 ? 'CNPJ inválido.' : customer.document.length === 11 ? 'CPF inválido.' : 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).';
  }
  if (customer.company.length > LIMITS.company) fields.company = `Máximo de ${LIMITS.company} caracteres.`;
  else if (requireCompany && customer.company.length < 2) fields.company = 'Informe o nome da empresa.';
  return { ok: Object.keys(fields).length === 0, customer, fields };
}

// ---------------------------------------------------------------- handler

function splitName(full) {
  const parts = full.split(' ');
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

export function buildPreference({ product, plan, customer, ref, base }) {
  const { first, last } = splitName(customer.name);
  const phone = parseWhatsapp(customer.whatsapp);
  return {
    items: [{
      id: `${product.id}-${plan.id}`,
      title: `${product.name} — ${plan.name} (1 ${plan.interval})`,
      description: `${product.name}: ${product.tagline}. Assinatura ${plan.name}, cobrança por ${plan.interval}.`,
      category_id: 'services',
      quantity: 1,
      currency_id: 'BRL',
      unit_price: plan.priceCents / 100,
    }],
    payer: {
      name: first,
      surname: last || undefined,
      email: customer.email,
      phone: phone ? { area_code: phone.area, number: phone.number } : undefined,
      identification: { type: documentType(customer.document), number: customer.document },
    },
    // Mensalidade: pagamento à vista (sem parcelamento) — PIX, cartão ou boleto continuam disponíveis.
    payment_methods: { installments: 1, default_installments: 1 },
    back_urls: { success: `${base}/obrigado`, pending: `${base}/obrigado`, failure: `${base}/obrigado` },
    auto_return: 'approved',
    notification_url: `${base}/api/webhook`,
    external_reference: ref,
    statement_descriptor: 'AQTA',
    binary_mode: false, // permite "pending" (PIX/boleto aguardando pagamento)
    expires: true,
    expiration_date_from: new Date().toISOString(),
    expiration_date_to: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    metadata: {
      product: product.id,
      plan: plan.id,
      customer_name: customer.name,
      customer_email: customer.email,
      customer_whatsapp: customer.whatsapp,
      customer_document: customer.document,
      customer_company: customer.company,
    },
  };
}

export default async function handler(req, res) {
  if (!allow(req, res, ['POST'])) return;

  if (typeof req.body === 'string' && req.body.length > MAX_BODY_CHARS) {
    return send(res, 413, { error: 'payload_too_large' });
  }
  const data = body(req);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return send(res, 400, { error: 'invalid_json' });
  let size = 0;
  try { size = JSON.stringify(data).length; } catch { size = Infinity; }
  if (size > MAX_BODY_CHARS) return send(res, 413, { error: 'payload_too_large' });

  const productId = typeof data.product === 'string' ? data.product.trim().toLowerCase() : '';
  const planId = typeof data.plan === 'string' && data.plan.trim() ? data.plan.trim().toLowerCase() : 'basico';
  const found = getPlan(productId, planId);
  if (!found) return send(res, 400, { error: 'invalid_product' });
  const { product, plan } = found;

  const { ok, customer, fields } = validateCustomer(data.customer);
  if (!ok) return send(res, 400, { error: 'validation', fields });

  const ref = `aqta:${product.id}:${plan.id}:${randomUUID()}`;
  const base = baseUrl(req);

  if (isDemo()) {
    try {
      const { signToken } = await import('../lib/token.js');
      const token = signToken({ t: 'demo', ref, product: product.id, plan: plan.id, customer, amountCents: plan.priceCents }, 3600);
      return send(res, 200, {
        init_point: `${base}/checkout-demo?ref=${encodeURIComponent(token)}`,
        external_reference: ref,
        demo: true,
      });
    } catch (err) {
      console.error('[checkout] falha no modo demo:', err);
      return send(res, 500, { error: 'internal' });
    }
  }

  try {
    const pref = await createPreference(buildPreference({ product, plan, customer, ref, base }), ref);
    if (!pref?.init_point) throw Object.assign(new Error('Preferência sem init_point'), { status: 502 });
    return send(res, 200, { init_point: pref.init_point, external_reference: ref, demo: false });
  } catch (err) {
    console.error('[checkout] erro ao criar preferência:', err.status, err.message, err.details ? JSON.stringify(err.details).slice(0, 500) : '');
    return send(res, 502, { error: 'payment_provider', message: 'Não foi possível iniciar o pagamento. Tente novamente em instantes.' });
  }
}
