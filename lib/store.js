// Armazenamento durável opcional: Upstash Redis via REST (Vercel KV / Upstash no Marketplace da Vercel).
// Zero dependências: fetch nativo. Docs: https://upstash.com/docs/redis/features/restapi
//
// Variáveis (a integração da Vercel cria as duas primeiras; as outras são o nome "puro" do Upstash):
//   KV_REST_API_URL + KV_REST_API_TOKEN   ou   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//
// Modos (storeMode()):
//   'redis'  — configurado: estado compartilhado entre todas as instâncias serverless.
//   'memory' — sem configuração e FORA de produção (modo demo / desenvolvimento): Map local da instância.
//   'none'   — sem configuração EM PRODUÇÃO: nada é guardado (e quem depende de durabilidade, como o
//              provisionamento automático, se desliga). Memória em produção daria uma falsa garantia.
//
// Valores são guardados como JSON. Erros de rede/timeout do Redis lançam StoreError (exceto pushLog, que nunca lança).
import { isDemo } from './http.js';

const TIMEOUT_MS = 3000;
const LOG_MAX = 1000;

export class StoreError extends Error {
  constructor(message, code = 'store_error') {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

function config() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

/** @returns {'redis'|'memory'|'none'} */
export function storeMode() {
  if (config()) return 'redis';
  return isDemo() ? 'memory' : 'none';
}

/** true quando o estado é compartilhado entre instâncias (Redis configurado). */
export const hasDurableStore = () => storeMode() === 'redis';

// ---------------------------------------------------------------- Redis (REST)

async function rest(path, payload) {
  const cfg = config();
  let res;
  try {
    res = await fetch(cfg.url + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new StoreError(`Redis: ${err?.name === 'TimeoutError' ? 'timeout' : `falha de rede (${err?.message || err})`}`, 'store_unavailable');
  }
  let data = null;
  try { data = await res.json(); } catch { /* corpo não-JSON */ }
  if (!res.ok) throw new StoreError(`Redis respondeu ${res.status}: ${data?.error || ''}`.trim(), 'store_unavailable');
  return data;
}

async function command(...args) {
  const data = await rest('', args.map(String));
  if (data && data.error) throw new StoreError(`Redis: ${data.error}`);
  return data ? data.result : null;
}

async function pipeline(commands) {
  const data = await rest('/pipeline', commands.map((c) => c.map(String)));
  if (!Array.isArray(data)) throw new StoreError('Redis: resposta inesperada do pipeline');
  const failed = data.find((d) => d && d.error);
  if (failed) throw new StoreError(`Redis: ${failed.error}`);
  return data.map((d) => d?.result);
}

// ---------------------------------------------------------------- memória (só fora de produção)

const mem = new Map();   // key → { value: string, exp: number|null }
const lists = new Map(); // key → string[]

function memGet(key) {
  const e = mem.get(key);
  if (!e) return null;
  if (e.exp && e.exp <= Date.now()) { mem.delete(key); return null; }
  return e.value;
}
function memSet(key, value, ttl) {
  mem.set(key, { value, exp: ttl ? Date.now() + ttl * 1000 : null });
  if (mem.size > 10000) mem.delete(mem.keys().next().value);
}

// ---------------------------------------------------------------- API

const encode = (v) => JSON.stringify(v ?? null);
function decode(s) {
  if (s === null || s === undefined) return null;
  try { return JSON.parse(s); } catch { return s; }
}
const ttlOf = (ttl) => {
  const n = Math.floor(Number(ttl));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Grava só se a chave não existir (SET NX EX). Trava distribuída barata.
 * @returns {Promise<boolean>} true se gravou (era a primeira); false se já existia.
 */
export async function setIfAbsent(key, value, ttlSeconds) {
  const ttl = ttlOf(ttlSeconds);
  const mode = storeMode();
  if (mode === 'redis') {
    const r = await command('SET', key, encode(value), 'NX', ...(ttl ? ['EX', ttl] : []));
    return r === 'OK';
  }
  if (mode === 'memory') {
    if (memGet(key) !== null) return false;
    memSet(key, encode(value), ttl);
    return true;
  }
  throw new StoreError('Armazenamento não configurado', 'store_not_configured');
}

/** @returns {Promise<any|null>} valor (JSON decodificado) ou null. Em modo 'none' devolve null. */
export async function get(key) {
  const mode = storeMode();
  if (mode === 'redis') return decode(await command('GET', key));
  if (mode === 'memory') return decode(memGet(key));
  return null;
}

/** Grava (sobrescreve). ttlSeconds opcional. Em modo 'none' lança StoreError. */
export async function set(key, value, ttlSeconds) {
  const ttl = ttlOf(ttlSeconds);
  const mode = storeMode();
  if (mode === 'redis') { await command('SET', key, encode(value), ...(ttl ? ['EX', ttl] : [])); return true; }
  if (mode === 'memory') { memSet(key, encode(value), ttl); return true; }
  throw new StoreError('Armazenamento não configurado', 'store_not_configured');
}

/** Remove uma chave. */
export async function del(key) {
  const mode = storeMode();
  if (mode === 'redis') { await command('DEL', key); return true; }
  if (mode === 'memory') { mem.delete(key); return true; }
  return false;
}

/**
 * Acrescenta um registro no início de uma lista (LPUSH) e mantém só os 1000 mais recentes (LTRIM).
 * Nunca lança. @returns {Promise<boolean>} true se gravou.
 */
export async function pushLog(list, obj) {
  const mode = storeMode();
  try {
    if (mode === 'redis') {
      await pipeline([['LPUSH', list, encode(obj)], ['LTRIM', list, 0, LOG_MAX - 1]]);
      return true;
    }
    if (mode === 'memory') {
      const arr = lists.get(list) || [];
      arr.unshift(encode(obj));
      if (arr.length > LOG_MAX) arr.length = LOG_MAX;
      lists.set(list, arr);
      return true;
    }
  } catch (err) {
    try { console.error(JSON.stringify({ level: 'error', msg: 'store.pushLog falhou', list, error: String(err?.message || err) })); } catch { /* nada */ }
  }
  return false;
}

// ---------------------------------------------------------------- chaves usadas pela aplicação

export const KEYS = {
  /** Estado do onboarding de um pagamento: { state: 'in_progress'|'done', ... } (sem senha). */
  onboarding: (paymentId) => `aqta:onboarding:${paymentId}`,
  /** Pagamento estornado/contestado/cancelado depois de aprovado: { status, at }. */
  revoked: (paymentId) => `aqta:revoked:${paymentId}`,
  /** Deduplicação de avisos à equipe entre instâncias. */
  notified: (event, paymentId) => `aqta:notified:${event}:${paymentId}`,
};
