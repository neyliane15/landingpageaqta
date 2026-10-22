// GET /api/payment-status?payment_id=...&external_reference=...   (ambos obrigatórios)
// A verdade vem do Mercado Pago (produção) ou de um token demo assinado — nunca dos parâmetros da URL de retorno.
// external_reference (contém um uuid) é exigido e precisa bater com o do pagamento: impede que alguém enumere
// ids numéricos do Mercado Pago para obter dados do cliente ou o accessToken.
// Erros: 400 missing_payment_id | 400 missing_reference | 404 not_found/invalid_payment | 502 Mercado Pago.
import crypto from 'node:crypto';
import { send, allow, isDemo } from '../lib/http.js';
import { getPlan, formatBRL } from '../lib/catalog.js';
import { signToken, verifyToken } from '../lib/token.js';
import { getPayment } from '../lib/mercadopago.js';

const REF_RE = /^aqta:([a-z0-9-]{1,40}):([a-z0-9-]{1,40}):[A-Za-z0-9-]{8,64}$/;
const ACCESS_TTL = 7 * 86400;

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : v == null ? '' : String(v).slice(0, max));

/** Mascara CPF/CNPJ deixando só alguns dígitos visíveis (nunca devolvemos o documento completo). */
export function maskDocument(doc) {
  const d = str(doc, 32).replace(/\D/g, '');
  if (d.length === 11) return `***.${d.slice(3, 6)}.***-**`;
  if (d.length === 14) return `**.${d.slice(2, 5)}.***/${d.slice(8, 12)}-**`;
  return d ? '***' : '';
}

/** Lê o cliente do metadata do MP (chaves em snake_case) com fallback para o payer. */
export function customerFromPayment(p) {
  const m = (p && typeof p.metadata === 'object' && p.metadata) || {};
  const payer = (p && typeof p.payer === 'object' && p.payer) || {};
  const payerName = [payer.first_name, payer.last_name].filter(Boolean).join(' ');
  const phone = payer.phone && typeof payer.phone === 'object'
    ? `${payer.phone.area_code || ''}${payer.phone.number || ''}` : '';
  return {
    name: str(m.customer_name ?? m.customerName) || str(payerName),
    email: str(m.customer_email ?? m.customerEmail) || str(payer.email),
    whatsapp: str(m.customer_whatsapp ?? m.customerWhatsapp).replace(/\D/g, '') || phone.replace(/\D/g, ''),
    document: str(m.customer_document ?? m.customerDocument).replace(/\D/g, '')
      || str(payer.identification?.number).replace(/\D/g, ''),
    company: str(m.customer_company ?? m.customerCompany),
  };
}

function demoPaymentId(token) {
  return 'demo_' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 20);
}

/**
 * Resolve um pagamento (produção ou demo) e valida que é uma venda Aqta legítima.
 * @returns {Promise<{ok:true, payment:object} | {ok:false, code:number, error:string}>}
 *   payment = { paymentId, status, statusDetail, product, plan, productName, planName, amountCents, amount,
 *               externalReference, customer:{name,email,whatsapp,document,company}, demo, paymentMethod }
 * Erros: code 404 (inexistente / não-Aqta / valor ou moeda inválidos) ou 502 (falha do Mercado Pago).
 */
export async function resolvePayment(rawId) {
  const id = str(rawId, 9000);

  if (id.startsWith('demo_')) {
    if (!isDemo()) return { ok: false, code: 404, error: 'not_found' }; // tokens demo não valem em produção
    const t = verifyToken(id.slice(5));
    if (!t || t.t !== 'demopay') return { ok: false, code: 404, error: 'not_found' };
    const found = getPlan(t.product, t.plan);
    if (!found || !REF_RE.test(str(t.ref, 200))) return { ok: false, code: 404, error: 'not_found' };
    const amountCents = Number(t.amountCents);
    if (!Number.isInteger(amountCents) || amountCents < found.plan.priceCents) {
      return { ok: false, code: 404, error: 'invalid_payment' };
    }
    const c = t.customer || {};
    return {
      ok: true,
      payment: {
        paymentId: demoPaymentId(id),
        status: ['approved', 'pending', 'rejected'].includes(t.status) ? t.status : 'rejected',
        statusDetail: 'demo',
        product: found.product.id,
        plan: found.plan.id,
        productName: found.product.name,
        planName: found.plan.name,
        amountCents,
        amount: formatBRL(amountCents),
        externalReference: t.ref,
        customer: {
          name: str(c.name), email: str(c.email), whatsapp: str(c.whatsapp).replace(/\D/g, ''),
          document: str(c.document).replace(/\D/g, ''), company: str(c.company),
        },
        demo: true,
        paymentMethod: 'demo',
      },
    };
  }

  if (!/^\d{1,30}$/.test(id)) return { ok: false, code: 404, error: 'not_found' };
  if (isDemo()) return { ok: false, code: 404, error: 'not_found' }; // sem MP_ACCESS_TOKEN não há como consultar

  let p;
  try {
    p = await getPayment(id);
  } catch (err) {
    if (err?.status === 404 || err?.status === 400) return { ok: false, code: 404, error: 'not_found' };
    console.error('[payment-status] falha ao consultar o Mercado Pago:', err?.status, err?.message);
    return { ok: false, code: 502, error: 'mercadopago_unavailable' };
  }
  if (!p || typeof p !== 'object') return { ok: false, code: 404, error: 'not_found' };

  const ref = str(p.external_reference, 200);
  const m = REF_RE.exec(ref);
  if (!m) return { ok: false, code: 404, error: 'not_found' };
  const found = getPlan(m[1], m[2]);
  if (!found) return { ok: false, code: 404, error: 'not_found' };

  const amountCents = Math.round(Number(p.transaction_amount) * 100);
  if (p.currency_id !== 'BRL' || !Number.isFinite(amountCents) || amountCents < found.plan.priceCents) {
    console.warn('[payment-status] pagamento Aqta com valor/moeda inválidos', { id, ref, amount: p.transaction_amount, currency: p.currency_id });
    return { ok: false, code: 404, error: 'invalid_payment' };
  }

  return {
    ok: true,
    payment: {
      paymentId: String(p.id ?? id),
      status: str(p.status, 40) || 'unknown',
      statusDetail: str(p.status_detail, 80),
      product: found.product.id,
      plan: found.plan.id,
      productName: found.product.name,
      planName: found.plan.name,
      amountCents,
      amount: formatBRL(amountCents),
      externalReference: ref,
      customer: customerFromPayment(p),
      demo: false,
      paymentMethod: str(p.payment_type_id || p.payment_method_id, 40),
    },
  };
}

export default async function handler(req, res) {
  if (!allow(req, res, ['GET'])) return;
  const q = req.query || {};
  const paymentId = str(q.payment_id || q.collection_id, 9000);
  if (!paymentId || paymentId === 'null') return send(res, 400, { error: 'missing_payment_id' });
  const givenRef = str(q.external_reference, 200);
  if (!givenRef || givenRef === 'null') return send(res, 400, { error: 'missing_reference' });

  const r = await resolvePayment(paymentId);
  if (!r.ok) return send(res, r.code, { error: r.error });
  const p = r.payment;

  // O external_reference informado pela página de retorno precisa bater com o do pagamento.
  if (givenRef !== p.externalReference) {
    return send(res, 404, { error: 'not_found' });
  }

  const { name, email, whatsapp, document, company } = p.customer;
  const out = {
    status: p.status,
    statusDetail: p.statusDetail,
    paymentId: p.paymentId,
    product: p.product,
    plan: p.plan,
    productName: p.productName,
    planName: p.planName,
    amount: p.amount,
    amountCents: p.amountCents,
    paymentMethod: p.paymentMethod,
    externalReference: p.externalReference,
    demo: p.demo,
    customer: { name, email, company, whatsapp, documentMasked: maskDocument(document) },
  };

  if (p.status === 'approved') {
    try {
      out.accessToken = signToken({
        t: 'access',
        paymentId: p.paymentId,
        product: p.product,
        plan: p.plan,
        ref: p.externalReference,
        customer: { name, email, whatsapp, company }, // sem documento: o token é legível e trafega em URL
      }, ACCESS_TTL);
    } catch (err) {
      console.error('[payment-status] não foi possível assinar o accessToken:', err.message);
      return send(res, 500, { error: 'server_misconfigured' });
    }
  }
  return send(res, 200, out);
}
