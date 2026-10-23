// Gateway de pagamento SIMULADO (somente modo demo — sem MP_ACCESS_TOKEN).
// GET  /api/demo-pay?ref=<token>                      ⇒ resumo verificado do pedido (para checkout-demo.html)
// POST /api/demo-pay { ref, outcome }                 ⇒ { redirect } para /obrigado com um payment_id demo assinado
import { send, allow, readJson, isDemo } from '../lib/http.js';
import { getPlan, formatBRL } from '../lib/catalog.js';
import { signToken, verifyToken } from '../lib/token.js';

const OUTCOMES = ['approved', 'pending', 'rejected'];
const REF_RE = /^aqta:[a-z0-9-]{1,40}:[a-z0-9-]{1,40}:[A-Za-z0-9-]{8,64}$/;
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Valida o token de checkout demo gerado por api/checkout.js. */
function readOrder(ref) {
  const t = verifyToken(typeof ref === 'string' ? ref.trim() : '');
  if (!t || t.t !== 'demo') return null;
  const found = getPlan(t.product, t.plan);
  if (!found || !REF_RE.test(str(t.ref))) return null;
  const amountCents = Number(t.amountCents);
  if (!Number.isInteger(amountCents) || amountCents < found.plan.priceCents) return null;
  const c = t.customer && typeof t.customer === 'object' ? t.customer : {};
  return {
    ref: t.ref,
    exp: t.exp,
    product: found.product.id,
    plan: found.plan.id,
    productName: found.product.name,
    planName: found.plan.name,
    interval: found.plan.interval,
    amountCents,
    customer: {
      name: str(c.name), email: str(c.email, 254), whatsapp: str(c.whatsapp, 20).replace(/\D/g, ''),
      company: str(c.company),
    },
  };
}

export default async function handler(req, res) {
  if (!allow(req, res, ['GET', 'POST'])) return;
  if (!isDemo()) return send(res, 404, { error: 'not_found' });

  if (req.method === 'GET') {
    const order = readOrder(req.query?.ref);
    if (!order) return send(res, 400, { error: 'invalid_ref' });
    return send(res, 200, {
      demo: true,
      product: order.product,
      plan: order.plan,
      productName: order.productName,
      planName: order.planName,
      interval: order.interval,
      amount: formatBRL(order.amountCents),
      amountCents: order.amountCents,
      externalReference: order.ref,
      customer: { name: order.customer.name, email: order.customer.email, company: order.customer.company },
      expiresAt: new Date(order.exp * 1000).toISOString(),
    });
  }

  const b = readJson(req, res, { maxChars: 8192 }); // 415 / 413 / 400 invalid_json
  if (!b) return;
  const outcome = str(b.outcome, 20);
  if (!OUTCOMES.includes(outcome)) return send(res, 400, { error: 'invalid_outcome' });
  const order = readOrder(b.ref);
  if (!order) return send(res, 400, { error: 'invalid_ref' });

  const paymentToken = 'demo_' + signToken({
    t: 'demopay',
    status: outcome,
    product: order.product,
    plan: order.plan,
    customer: order.customer, // sem documento (vai na URL de retorno)
    ref: order.ref,
    amountCents: order.amountCents,
  }, 86400);

  const qs = new URLSearchParams({ payment_id: paymentToken, status: outcome, external_reference: order.ref });
  return send(res, 200, { redirect: `/obrigado?${qs}` });
}
