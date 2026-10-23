// POST /api/webhook — notificações do Mercado Pago (Webhooks / IPN).
// Docs: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
// - Valida x-signature (ts=...,v1=...) com MP_WEBHOOK_SECRET quando o segredo existe. Assinatura presente e
//   inválida ⇒ 401. Notificação IPN (?topic=payment&id=…) SEM x-signature é aceita mesmo com o segredo: o MP não
//   assina IPN, e a notificação é só um gatilho — o pagamento é sempre reconsultado na API com o nosso token.
// - Idade do `ts`: NÃO rejeitamos por idade. A doc do MP não garante que as re-tentativas (que podem vir horas
//   depois) tragam um ts novo; rejeitar faria o MP re-tentar para sempre. Replay não tem efeito: a verdade vem da
//   consulta ao MP e os avisos são deduplicados. Só registramos um aviso no log quando ts tem mais de 10 min.
// - type/topic "payment": consulta o pagamento no MP (nunca confia no corpo) e
//     approved                                  ⇒ notifyTeam payment.approved
//     refunded | charged_back | cancelled*      ⇒ notifyTeam payment.revoked (ação: revogar acesso) e grava
//                                                  aqta:revoked:<id> no armazenamento (bloqueia ativação/acesso)
//     in_mediation                              ⇒ notifyTeam payment.in_mediation (acompanhar a disputa)
//   (*cancelled só conta como revogação se o pagamento já tinha sido aprovado — date_approved — ou ativado;
//    um PIX/boleto que expira sem pagar também vira "cancelled" e não é revogação.)
// - Respostas não-2xx fazem o MP re-tentar: 500 só para falhas transitórias de consulta.
import crypto from 'node:crypto';
import { send, allow, isDemo } from '../lib/http.js';
import { resolvePayment } from './payment-status.js';
import { setIfAbsent, get as storeGet, set as storeSet, del as storeDel, storeMode, KEYS } from '../lib/store.js';

const MAX_TS_AGE_S = 600;
const REVOKED_STATUSES = new Set(['refunded', 'charged_back', 'cancelled']);
const REVOKED_TTL = 400 * 86400;

// Evita avisar a equipe duas vezes pelo mesmo evento (payment.created + payment.updated, re-tentativas).
// Com armazenamento, a deduplicação vale entre instâncias; sem ele, só na mesma instância.
const notified = new Set();

/** true se este (evento, pagamento) ainda não foi avisado. Falha do armazenamento ⇒ avisa (melhor repetir que perder). */
async function firstTime(event, paymentId) {
  const k = `${event}:${paymentId}`;
  if (notified.has(k)) return false;
  notified.add(k);
  if (notified.size > 5000) notified.delete(notified.values().next().value);
  if (storeMode() === 'none') return true;
  try {
    return await setIfAbsent(KEYS.notified(event, paymentId), { at: new Date().toISOString() }, 90 * 86400);
  } catch (err) {
    console.error('[webhook] store indisponível na deduplicação:', err?.message);
    return true;
  }
}

/** Libera a deduplicação para o próximo reenvio do Mercado Pago tentar avisar de novo. */
async function forget(event, paymentId) {
  notified.delete(`${event}:${paymentId}`);
  if (storeMode() === 'none') return;
  try { await storeDel(KEYS.notified(event, paymentId)); } catch { /* expira sozinho */ }
}

/**
 * Avisa a equipe uma única vez por (evento, pagamento). Se há webhook configurado e a entrega falhou, libera a
 * deduplicação para a próxima notificação deste pagamento avisar de novo (o evento já ficou em aqta:events).
 * A resposta ao Mercado Pago continua 200: a falha é do webhook da equipe, não do processamento do pagamento.
 */
async function notifyOnce(payload, paymentId) {
  if (!(await firstTime(payload.event, paymentId))) return true;
  const ok = await notify(payload);
  if (ok || !process.env.AQTA_NOTIFY_WEBHOOK) return true;
  await forget(payload.event, paymentId);
  return false;
}

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

  const q = req.query || {};
  let b = {};
  try { b = req.body && typeof req.body === 'object' ? req.body : {}; } catch { b = {}; } // Vercel lança com JSON inválido
  req = { ...req, query: q, body: b, headers: req.headers || {} };

  const secret = process.env.MP_WEBHOOK_SECRET;
  const sigHeader = header(req, 'x-signature');
  const unsignedIpn = !sigHeader && q.topic !== undefined && q.id !== undefined;
  if (secret && !unsignedIpn) {
    if (!verifySignature(req, secret)) {
      console.warn('[webhook] assinatura inválida', { requestId: header(req, 'x-request-id') });
      return send(res, 401, { error: 'invalid_signature' });
    }
    const ts = Number(/(?:^|,)\s*ts=(\d+)/.exec(String(sigHeader))?.[1]);
    const ageS = Math.floor(Date.now() / 1000) - (ts > 1e11 ? Math.floor(ts / 1000) : ts);
    if (Number.isFinite(ageS) && Math.abs(ageS) > MAX_TS_AGE_S) {
      console.warn('[webhook] ts da assinatura com mais de 10 min (aceito; o pagamento é reconsultado no MP)', { ageS });
    }
  } else if (!secret) {
    console.warn('[webhook] MP_WEBHOOK_SECRET não configurado: assinatura não verificada');
  }

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
  const base = {
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
  };

  if (p.status === 'approved' && !(p.refundedCents > 0)) {
    await notifyOnce({ event: 'payment.approved', ...base }, p.paymentId);
    return send(res, 200, { ok: true, status: p.status });
  }

  let revoke = REVOKED_STATUSES.has(p.status) || (p.status === 'approved' && p.refundedCents > 0);
  let onboarding = null;
  if (revoke && p.status === 'cancelled' && !p.dateApproved) {
    try { onboarding = await storeGet(KEYS.onboarding(p.paymentId)); } catch { /* sem store */ }
    revoke = Boolean(onboarding); // PIX/boleto expirado sem pagar: não é revogação
  }

  if (revoke) {
    if (storeMode() !== 'none') {
      try {
        await storeSet(KEYS.revoked(p.paymentId), { status: p.status, statusDetail: p.statusDetail, at: base.at }, REVOKED_TTL);
      } catch (err) {
        console.error('[webhook] não foi possível gravar a revogação:', err?.message);
        return send(res, 500, { error: 'store_unavailable' }); // MP re-tenta; a revogação não pode se perder
      }
    }
    await notifyOnce({
        event: 'payment.revoked',
        ...base,
        status: p.status,
        statusDetail: p.statusDetail,
        refundedCents: p.refundedCents,
        action: 'REVOGAR/SUSPENDER O ACESSO deste cliente no produto',
        mpAction: base.action,
      }, p.paymentId);
    return send(res, 200, { ok: true, status: p.status, revoked: true });
  }

  if (p.status === 'in_mediation') {
    await notifyOnce({ event: 'payment.in_mediation', ...base, status: p.status, statusDetail: p.statusDetail }, p.paymentId);
  }
  return send(res, 200, { ok: true, status: p.status });
}
