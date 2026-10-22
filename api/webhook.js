// POST /api/webhook — notificações do Mercado Pago (Webhooks / IPN).
// Docs: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
// - Valida x-signature (ts=...,v1=...) com MP_WEBHOOK_SECRET quando o segredo existe.
// - type/topic "payment": consulta o pagamento no MP (nunca confia no corpo) e, se aprovado, avisa a equipe.
// - Respostas não-2xx fazem o MP re-tentar: 500 só para falhas transitórias de consulta.
import crypto from 'node:crypto';
import { send, allow, isDemo } from '../lib/http.js';
import { resolvePayment } from './payment-status.js';

// Evita avisar a equipe duas vezes pelo mesmo pagamento na mesma instância (payment.created + payment.updated,
// re-tentativas). Melhor esforço: sem banco, outra instância serverless pode repetir o aviso.
const notified = new Set();

async function notify(event) {
  try {
    const mod = await import('../lib/notify.js');
    if (typeof mod.notifyTeam === 'function') return await mod.notifyTeam(event);
  } catch (err) {
    console.error('[webhook] lib/notify.js indisponível:', err?.message);
  }
  console.log(JSON.stringify({ level: 'info', source: 'webhook', ...event }));
  return false;
}

function header(req, name) {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Extrai o data.id da notificação: query `data.id` (oficial para a assinatura), body `data.id` ou query `id` (IPN). */
export function notificationId(req) {
  const q = req.query || {};
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const id = q['data.id'] ?? b.data?.id ?? q.id ?? b.id ?? '';
  return String(id).trim();
}

/**
 * Valida o header x-signature do Mercado Pago.
 * manifesto = `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` (partes ausentes são omitidas, como na doc oficial)
 * v1 = HMAC-SHA256(MP_WEBHOOK_SECRET, manifesto) em hex. data.id alfanumérico vai em minúsculas.
 */
export function verifySignature(req, secret) {
  const sigHeader = header(req, 'x-signature');
  if (!sigHeader || typeof sigHeader !== 'string') return false;
  let ts = '';
  let v1 = '';
  for (const part of sigHeader.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 'ts') ts = v;
    else if (k === 'v1') v1 = v;
  }
  if (!ts || !/^[0-9a-f]{64}$/i.test(v1)) return false;

  const q = req.query || {};
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  let dataId = String(q['data.id'] ?? b.data?.id ?? '').trim();
  if (/^[a-z0-9]+$/i.test(dataId)) dataId = dataId.toLowerCase();
  const requestId = String(header(req, 'x-request-id') ?? '').trim();

  let manifest = '';
  if (dataId) manifest += `id:${dataId};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;

  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(manifest).digest('hex'), 'utf8');
  const given = Buffer.from(v1.toLowerCase(), 'utf8');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export default async function handler(req, res) {
  if (!allow(req, res, ['POST'])) return;

  if (isDemo()) return send(res, 200, { ok: true, ignored: 'demo_mode' });

  const secret = process.env.MP_WEBHOOK_SECRET;
  if (secret) {
    if (!verifySignature(req, secret)) {
      console.warn('[webhook] assinatura inválida', { requestId: header(req, 'x-request-id') });
      return send(res, 401, { error: 'invalid_signature' });
    }
  } else {
    console.warn('[webhook] MP_WEBHOOK_SECRET não configurado: assinatura não verificada');
  }

  const q = req.query || {};
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const type = String(b.type ?? q.type ?? b.topic ?? q.topic ?? '').trim();
  if (type !== 'payment') return send(res, 200, { ok: true, ignored: type || 'unknown_type' });

  const id = notificationId(req);
  if (!/^\d{1,30}$/.test(id)) return send(res, 200, { ok: true, ignored: 'invalid_id' });

  const r = await resolvePayment(id);
  if (!r.ok) {
    if (r.code === 502) return send(res, 500, { error: 'payment_lookup_failed' }); // MP re-tenta
    // Pagamento inexistente (ex.: "testar notificação" do painel) ou não-Aqta: aceita para não gerar re-tentativas.
    return send(res, 200, { ok: true, ignored: r.error });
  }

  const p = r.payment;
  if (p.status === 'approved' && !notified.has(p.paymentId)) {
    notified.add(p.paymentId);
    if (notified.size > 5000) notified.delete(notified.values().next().value);
    await notify({
      event: 'payment.approved',
      paymentId: p.paymentId,
      externalReference: p.externalReference,
      product: p.product,
      plan: p.plan,
      productName: p.productName,
      planName: p.planName,
      amount: p.amount,
      amountCents: p.amountCents,
      paymentMethod: p.paymentMethod,
      customer: p.customer,
      action: String(b.action ?? ''),
      at: new Date().toISOString(),
    });
  }
  return send(res, 200, { ok: true, status: p.status });
}
