// Tokens assinados (HMAC-SHA256) — o "estado" do fluxo de compra sem banco de dados.
// Formato: base64url(JSON(payload + exp)) + "." + base64url(HMAC-SHA256(segredo, parte1)).
// Os tokens NÃO são criptografados: qualquer um que tenha o token lê o payload. Não coloque segredos nele.
import crypto from 'node:crypto';
import { isDemo } from './http.js';

// Segredo fixo SOMENTE para modo demo (sem MP_ACCESS_TOKEN). Nunca é usado em produção: getSecret() só o devolve
// quando isDemo(), e em produção ele é recusado mesmo se alguém o cadastrar em AQTA_TOKEN_SECRET. Como cada
// assinatura/verificação chama getSecret() na hora, um token assinado com ele no demo nunca valida em produção.
const DEV_SECRET = 'aqta-demo-secret-nao-use-em-producao';
const PLACEHOLDERS = new Set(['troque-este-segredo', 'changeme', 'secret', DEV_SECRET]);
const MAX_TOKEN_LENGTH = 8192;

function getSecret() {
  const secret = process.env.AQTA_TOKEN_SECRET;
  if (secret && !(PLACEHOLDERS.has(secret) && !isDemo())) {
    if (!isDemo() && secret.length < 16) {
      throw new Error('AQTA_TOKEN_SECRET muito curto: use pelo menos 32 caracteres aleatórios (openssl rand -hex 32).');
    }
    return secret;
  }
  if (isDemo()) return DEV_SECRET;
  throw new Error(
    'AQTA_TOKEN_SECRET não configurado (ou ainda com o valor de exemplo). Em produção (MP_ACCESS_TOKEN definido) ' +
    'é obrigatório: gere com `openssl rand -hex 32` e cadastre nas variáveis de ambiente.',
  );
}

function hmac(data) {
  return crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
}

/**
 * Assina um payload com validade.
 * @param {object} payload dados públicos (serão legíveis por quem tiver o token)
 * @param {number} ttlSeconds validade em segundos
 * @returns {string}
 */
export function signToken(payload, ttlSeconds) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('signToken: payload deve ser um objeto');
  }
  const ttl = Number(ttlSeconds);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new TypeError('signToken: ttlSeconds deve ser um número positivo');
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + Math.floor(ttl) })).toString('base64url');
  return `${body}.${hmac(body)}`;
}

/**
 * Verifica assinatura e validade. Nunca lança por token malformado: devolve null.
 * (Lança apenas se o segredo não estiver configurado em produção — erro de configuração, não de entrada.)
 * @param {string} token
 * @returns {object|null} payload (com iat/exp) ou null
 */
export function verifyToken(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;

  const expected = Buffer.from(hmac(body), 'utf8');
  const given = Buffer.from(sig, 'utf8');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}
