// GET /api/catalog — produtos e preços públicos (fonte única: lib/catalog.js).
import { send, allow, isDemo } from '../lib/http.js';
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
  send(res, 200, { products, demo: isDemo() });
}
