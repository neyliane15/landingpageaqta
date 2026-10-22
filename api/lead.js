// POST /api/lead — formulário "sistema personalizado" da landing.
// { name, email, whatsapp, company, message, website } → 200 { ok: true, whatsappUrl }
// `website` é honeypot: se vier preenchido, responde 200 sem fazer nada (o robô acha que deu certo).
import { send, allow, body } from '../lib/http.js';
import { notifyTeam } from '../lib/notify.js';

const MAX_BODY_CHARS = 6000;
const LIMITS = { name: 120, email: 254, company: 120, message: 2000 };
const RATE = { windowMs: 10 * 60_000, max: 5 }; // por IP, por instância (melhor esforço)
const hits = new Map();

const onlyDigits = (v) => String(v ?? '').replace(/\D+/g, '');
const cleanText = (v, max) =>
  String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, max);

function isValidEmail(s) {
  if (s.length < 6 || s.length > LIMITS.email) return false;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i.test(s)
    && !s.includes('..');
}

function isValidWhatsapp(v) {
  let d = onlyDigits(v);
  if (d.length < 10 || d.length > 13) return false;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return false;
  if (!/^[1-9][1-9]$/.test(d.slice(0, 2))) return false;
  const n = d.slice(2);
  if (n.length === 9 && n[0] !== '9') return false;
  if (n.length === 8 && !/^[2-9]/.test(n)) return false;
  return true;
}

function rateLimited(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  if (!ip) return false;
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return list.length > RATE.max;
}

export function whatsappUrlFor(lead) {
  const n = onlyDigits(process.env.AQTA_WHATSAPP);
  if (!n) return null;
  const text = `Olá, Aqta! Sou ${lead.name}${lead.company ? `, da ${lead.company}` : ''}. `
    + 'Acabei de enviar pelo site um pedido de sistema personalizado e gostaria de conversar sobre o projeto.';
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}

export default async function handler(req, res) {
  if (!allow(req, res, ['POST'])) return;
  const raw = body(req);
  let size = 0;
  try { size = JSON.stringify(raw).length; } catch { size = Infinity; }
  if (size > MAX_BODY_CHARS) return send(res, 413, { error: 'payload_too_large' });

  // Honeypot: finge sucesso, não faz nada.
  if (String(raw.website ?? '').trim()) return send(res, 200, { ok: true });

  const lead = {
    name: cleanText(raw.name, LIMITS.name + 1),
    email: String(raw.email ?? '').trim().toLowerCase().slice(0, LIMITS.email + 1),
    whatsapp: onlyDigits(raw.whatsapp).slice(0, 20),
    company: cleanText(raw.company, LIMITS.company + 1),
    message: cleanText(raw.message, LIMITS.message + 1),
  };
  const fields = {};
  if (lead.name.length < 3 || !/\p{L}/u.test(lead.name)) fields.name = 'Informe seu nome (mínimo 3 letras).';
  else if (lead.name.length > LIMITS.name) fields.name = `Máximo de ${LIMITS.name} caracteres.`;
  if (!isValidEmail(lead.email)) fields.email = 'Informe um e-mail válido.';
  if (!isValidWhatsapp(lead.whatsapp)) fields.whatsapp = 'Informe um WhatsApp com DDD (ex.: (11) 91234-5678).';
  if (lead.company.length > LIMITS.company) fields.company = `Máximo de ${LIMITS.company} caracteres.`;
  if (lead.message.length > LIMITS.message) fields.message = `Máximo de ${LIMITS.message} caracteres.`;
  if (Object.keys(fields).length) return send(res, 400, { error: 'validation', fields });

  if (rateLimited(req)) {
    return send(res, 429, { error: 'rate_limited', message: 'Muitos envios em sequência. Tente de novo em alguns minutos ou fale pelo WhatsApp.', whatsappUrl: whatsappUrlFor(lead) });
  }

  await notifyTeam({
    event: 'lead.custom_system',
    name: lead.name,
    email: lead.email,
    whatsapp: lead.whatsapp,
    company: lead.company || null,
    message: lead.message || null,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
  });

  return send(res, 200, { ok: true, whatsappUrl: whatsappUrlFor(lead) });
}
