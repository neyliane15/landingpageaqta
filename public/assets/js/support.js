// Canal de suporte da Aqta (WhatsApp) — fonte única: GET /api/catalog → support { whatsapp, whatsappUrl } | null
// (configurado no servidor por AQTA_WHATSAPP). Nenhum número fica escrito no HTML ou no JS.
//
// Marcação:
//   <a data-wa-text="mensagem pré-preenchida">…</a>   link de suporte: vira wa.me/<número>?text=… quando há número;
//                                                      sem número, cai em FALLBACK (formulário de contato do site).
//   <… data-wa-only hidden>…</…>                      bloco que só aparece quando existe WhatsApp configurado.

export const FALLBACK = '/#sob-medida';
const WA_RE = /^https:\/\/(wa\.me|api\.whatsapp\.com)\//;

let catalogPromise = null;
let promise = null;
let base = null; // "https://wa.me/55…" ou null

/** GET /api/catalog (uma vez por página). Resolve com o JSON ou {} — nunca rejeita. */
export function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch('/api/catalog', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return catalogPromise;
}

function baseFrom(support) {
  if (!support || typeof support !== 'object') return null;
  const digits = String(support.whatsapp || '').replace(/\D/g, '');
  if (digits.length >= 10 && digits.length <= 15) return `https://wa.me/${digits}`;
  const url = String(support.whatsappUrl || '');
  if (WA_RE.test(url)) return url.split('?')[0];
  return null;
}

/** Carrega (uma vez) o canal de suporte. Resolve com a URL base do WhatsApp ou null. Nunca rejeita. */
export function loadSupport() {
  if (!promise) {
    promise = loadCatalog()
      .then((data) => { base = baseFrom(data?.support); return base; })
      .catch(() => { base = null; return null; });
  }
  return promise;
}

/** Link de suporte com mensagem pré-preenchida (ou o fallback, enquanto/caso não haja número). */
export function supportHref(text) {
  if (!base) return FALLBACK;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

export const hasWhatsapp = () => Boolean(base);

/** Aplica o canal atual a todos os [data-wa-text] e [data-wa-only] dentro de root. */
export function applySupportLinks(root = document) {
  for (const a of root.querySelectorAll('a[data-wa-text]')) {
    a.href = supportHref(a.dataset.waText);
    if (base) { a.target = '_blank'; a.rel = 'noopener'; } else { a.removeAttribute('target'); a.removeAttribute('rel'); }
  }
  for (const el of root.querySelectorAll('[data-wa-only]')) el.hidden = !base;
}

/** Atributo pronto para templates: data-wa-text="…" href="…" (escapado). */
export function waAttrs(text) {
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const href = supportHref(text);
  return `data-wa-text="${esc(text)}" href="${esc(href)}"${base ? ' target="_blank" rel="noopener"' : ''}`;
}
