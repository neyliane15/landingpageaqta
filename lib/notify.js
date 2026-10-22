// Notificação da equipe Aqta (vendas, onboarding, leads).
// POST JSON para AQTA_NOTIFY_WEBHOOK (n8n, Make, Zapier, Slack...). Timeout de 5s e NUNCA lança:
// uma notificação que falha não pode derrubar o fluxo de venda. Sem webhook, só loga (JSON estruturado).

const TIMEOUT_MS = 5000;
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
  if (e.mode) parts.push(e.mode === 'manual' ? 'LIBERAÇÃO MANUAL PENDENTE' : 'acesso automático');
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

  const url = process.env.AQTA_NOTIFY_WEBHOOK;
  if (!url) {
    try { console.log(JSON.stringify({ level: 'info', msg: 'notifyTeam (sem webhook)', ...payload })); } catch { /* nada */ }
    return false;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'aqta-landing/1.0' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(JSON.stringify({ level: 'error', msg: 'notifyTeam: webhook respondeu erro', status: res.status, event: payload.event }));
      return false;
    }
    return true;
  } catch (err) {
    try {
      console.error(JSON.stringify({ level: 'error', msg: 'notifyTeam: falha ao enviar', error: String(err?.message || err), event: payload.event }));
    } catch { /* nada */ }
    return false;
  }
}
