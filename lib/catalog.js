// Catálogo único de produtos e planos. Preços em centavos (BRL).
// Toda a aplicação (front via /api/catalog e back) lê daqui — nunca confie em preço vindo do cliente.

export const PRODUCTS = {
  obtra: {
    id: 'obtra',
    name: 'Obtra',
    tagline: 'Diário de Obra digital',
    appUrl: process.env.OBTRA_APP_URL || 'https://obtra.vercel.app',
    loginPath: '/login',
    plans: {
      basico: { id: 'basico', name: 'Plano Básico', priceCents: 20000, interval: 'mês' },
    },
  },
  emptra: {
    id: 'emptra',
    name: 'Emptra',
    tagline: 'Cotação de materiais via WhatsApp',
    appUrl: process.env.EMPTRA_APP_URL || 'https://emptra.srv1848886.hstgr.cloud',
    loginPath: '/login',
    plans: {
      basico: { id: 'basico', name: 'Plano Básico', priceCents: 30000, interval: 'mês' },
    },
  },
};

export function getPlan(productId, planId = 'basico') {
  const product = Object.hasOwn(PRODUCTS, productId) ? PRODUCTS[productId] : null;
  if (!product) return null;
  const plan = Object.hasOwn(product.plans, planId) ? product.plans[planId] : null;
  if (!plan) return null;
  return { product, plan };
}

export function formatBRL(cents) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
