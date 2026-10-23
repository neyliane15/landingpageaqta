// Notificação da equipe Aqta (vendas, onboarding, leads, estornos).
// POST JSON para AQTA_NOTIFY_WEBHOOK (n8n, Make, Zapier, Slack...): até 3 tentativas com backoff curto, timeout
// por tentativa, e NUNCA lança — uma notificação que falha não pode derrubar o fluxo de venda.
// Além do webhook, todo evento é gravado no armazenamento durável (lista `aqta:events`, últimos 1000) quando
// existir (lib/store.js): é a cópia que sobra se o webhook estiver fora do ar.
// Em produção sem webhook E sem armazenamento, cada evento gera um console.error bem visível (dados só no log).
import { isDemo } from './http.js';
import { pushLog, hasDurableStore, storeMode } from './store.js';

const TIMEOUT_MS = 4000;
const ATTEMPTS = 3;
const BACKOFF_MS = [300, 900];
const EVENTS_LIST = 'aqta:events';
const SECRET_KEYS = /pass(word)?|senha|secret|token|service.?key|authorization/i;

/** Remove qualquer campo com cara de segredo (defesa extra: senha temporária nunca vai para a equipe). */
function scrub(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.test(k)) continue;
    out[k] = scrub(v, depth + 1);
  }
  return out;
}

const LABELS = {
  'payment.approved': 'Pagamento aprovado',
  'onboarding.completed': 'Onboarding concluído',
  'lead.custom_system': 'Novo lead — sistema personalizado',
  'payment.revoked': 'PAGAMENTO ESTORNADO/CANCELADO — REVOGAR ACESSO',
  'payment.in_mediation': 'Pagamento em disputa (mediação)',
};

/** Linha legível para webhooks de chat (Slack/Discord/Google Chat leem `text`). */
function summary(e) {
  const parts = [`[Aqta] ${LABELS[e.event] || e.event || 'evento'}`];
  const product = e.productName || e.product;
  if (product) parts.push(product);
  const who = e.company || e.customer?.company || e.name || e.customer?.name;
  if (who) parts.push(who);
  const mail = e.loginEmail || e.email || e.customer?.email;
  if (mail) parts.push(mail);
  if (e.mode) parts.push(e.mode === 'manual' ? 'LIBERAÇÃO MANUAL PENDENTE' : e.mode === 'demo' ? 'DEMONSTRAÇÃO (nada foi criado)' : 'acesso automático');
  if (e.status && e.event?.startsWith('payment.') && e.event !== 'payment.approved') parts.push(`status: ${e.status}`);
  if (e.provisionError) parts.push(`erro: ${e.provisionError}`);
  return parts.join(' · ');
}

/**
 * @param {object} event ex.: { event: 'onboarding.completed', product, ... }
 * @returns {Promise<boolean>} true se o webhook aceitou (2xx); false se não há webhook ou falhou.
 */
export async function notifyTeam(event) {
  let payload;
  try {
    const clean = scrub(event && typeof event === 'object' ? event : { event: String(event) });
    payload = { ...clean, timestamp: new Date().toISOString(), source: 'landing-aqta' };
    if (!payload.text) payload.text = summary(payload);
  } catch {
    payload = { event: 'unknown', timestamp: new Date().toISOString(), source: 'landing-aqta' };
  }

  // Cópia durável (não depende do webhook). Em modo memória (demo) também grava, sem garantia.
  const logged = storeMode() !== 'none' ? await pushLog(EVENTS_LIST, payload) : false;

  const url = process.env.AQTA_NOTIFY_WEBHOOK;
  if (!url) {
    if (!isDemo() && !hasDurableStore()) {
      try {
        console.error(JSON.stringify({
          level: 'error',
          msg: '!!! notifyTeam: SEM AQTA_NOTIFY_WEBHOOK E SEM ARMAZENAMENTO (KV_REST_API_URL) EM PRODUÇÃO — este evento só existe neste log. Configure um dos dois.',
          ...payload,
        }));
      } catch { /* nada */ }
    } else {
      try { console.log(JSON.stringify({ level: 'info', msg: 'notifyTeam (sem webhook)', logged, ...payload })); } catch { /* nada */ }
    }
    return false;
  }

  const bodyText = JSON.stringify(payload);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'aqta-landing/1.0' },
        body: bodyText,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return true;
      // 4xx (exceto 408/429) não melhora tentando de novo.
      const retriable = res.status >= 500 || res.status === 408 || res.status === 429;
      console.error(JSON.stringify({ level: 'error', msg: 'notifyTeam: webhook respondeu erro', status: res.status, attempt, event: payload.event, logged }));
      if (!retriable) break;
    } catch (err) {
      try {
        console.error(JSON.stringify({ level: 'error', msg: 'notifyTeam: falha ao enviar', error: String(err?.message || err), attempt, event: payload.event, logged }));
      } catch { /* nada */ }
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1] ?? 1000));
  }
  if (!logged) {
    try {
      console.error(JSON.stringify({ level: 'error', msg: '!!! notifyTeam: evento PERDIDO (webhook falhou e não há armazenamento durável)', ...payload }));
    } catch { /* nada */ }
  }
  return false;
}
