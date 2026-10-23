// GET /api/catalog — produtos e preços públicos (fonte única: lib/catalog.js) e contato de suporte.
// 200 { products, demo, support: { whatsapp: "<dígitos>", whatsappUrl: "https://wa.me/<dígitos>" } | null,
//       emptraCategories: [{ slug, name }] }
import { send, allow, isDemo, supportWhatsapp } from '../lib/http.js';
import { EMPTRA_CATEGORIES } from '../lib/provision/emptra.js';
import { PRODUCTS, formatBRL } from '../lib/catalog.js';

export default async function handler(req, res) {
  if (!allow(req, res, ['GET', 'HEAD'])) return;
  const products = Object.values(PRODUCTS).map((p) => ({
    id: p.id,
    name: p.name,
    tagline: p.tagline,
    plans: Object.values(p.plans).map((pl) => ({
      id: pl.id,
      name: pl.name,
      priceCents: pl.priceCents,
      price: formatBRL(pl.priceCents),
      interval: pl.interval,
    })),
  }));
  const n = supportWhatsapp();
  const support = n ? { whatsapp: n, whatsappUrl: `https://wa.me/${n}` } : null;
  send(res, 200, {
    products,
    demo: isDemo(),
    support,
    emptraCategories: EMPTRA_CATEGORIES.map(([slug, name]) => ({ slug, name })),
  });
}
