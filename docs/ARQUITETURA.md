# Aqta — Landing page de vendas (Obtra + Emptra)

Contrato de arquitetura. **Todo agente lê este arquivo antes de começar e só edita os arquivos que são seus.**

## Visão geral

- Site estático (HTML/CSS/JS puro, sem build) + funções serverless em `api/*.js` (formato Vercel Node:
  `export default async function handler(req, res)`). ESM (`"type": "module"`), Node ≥ 20, **zero dependências npm**
  (usar `fetch` e `node:crypto` nativos).
- Local: `node server.js` emula a Vercel (estático + `/api/*`, `req.query`, `req.body` JSON já parseado, cleanUrls:
  `/obrigado` serve `obrigado.html`). Use `send/allow/body/baseUrl/isDemo` de `lib/http.js`.
- Preços e produtos: **somente** `lib/catalog.js` (centavos). Obtra Plano Básico = R$ 200/mês, Emptra Plano Básico =
  R$ 300/mês. Sistemas personalizados: custo de implantação sob consulta (formulário de lead).
- Pagamento: **Mercado Pago Checkout Pro** (PIX, cartão, boleto) via REST. Sem `MP_ACCESS_TOKEN` ⇒ **modo demo**:
  gateway simulado local (`/checkout-demo`), fluxo completo funcionando sem cobrar nada.
- Sem banco de dados: o estado vive no Mercado Pago (pagamento + `external_reference` + `metadata`) e em
  **tokens HMAC assinados** (`lib/token.js`).

## Identidade visual (logo em `assets/img/logo-aqta.jpg`)

- Fundo quase preto `#05070b`, superfícies `#0b0f16`/`#101620`, texto `#e8edf3`, texto secundário `#8a94a3`.
- Ciano Aqta `#01bffd` (cor do traço do "Q"), variações `#00e0ff` (brilho) e `#0a84c6` (profundo).
- Tipografia: fonte geométrica larga para títulos (ex.: "Michroma"/"Orbitron"-like — sugerido **Michroma** só
  em títulos curtos/marca, Google Fonts) + **Inter** para texto. **Fonte pequena**: corpo 14px, legendas 12px,
  letras espaçadas em rótulos (`letter-spacing: .3em`, maiúsculas — como "DESENVOLVIMENTO DE SOFTWARE").
- Bordas com detalhes nas cores Aqta: bordas finas 1px com gradiente ciano, cantos "cortados"/marcadores de canto
  (como molduras HUD), brilho sutil no hover. Visual moderno, escuro, premium.

## Design system — `assets/css/aqta.css` (dono: FE-B)

Tokens CSS em `:root` (todos usam estes nomes):
`--bg --surface --surface-2 --line --text --muted --cyan --cyan-glow --cyan-deep --radius --font-display --font-body`

Classes de componentes (todas as páginas usam estas; ninguém redefine fora de `aqta.css`):

| Classe | Uso |
| --- | --- |
| `.container` | largura máx. 1160px, gutter 16px no mobile |
| `.btn`, `.btn--primary`, `.btn--ghost`, `.btn--sm`, `.btn--block` | botões; `[aria-busy="true"]` mostra spinner |
| `.frame` | cartão com borda gradiente ciano + 4 marcadores de canto (detalhe Aqta) |
| `.frame--glow` | variante destacada (plano em destaque) |
| `.eyebrow` | rótulo pequeno maiúsculo espaçado ciano |
| `.badge`, `.badge--ok`, `.badge--warn`, `.badge--err` | selos de status |
| `.field`, `.field label`, `.field input/select/textarea`, `.field-error` | formulários |
| `.alert`, `.alert--ok`, `.alert--warn`, `.alert--err` | mensagens |
| `.spinner` | carregando |
| `.modal`, `.modal__dialog`, `.modal__close` | modal (`<dialog class="modal">`) |
| `.page-shell` | layout de páginas internas (checkout-demo, obrigado, acesso): header com logo + card central |
| `.logo` | wordmark AQTA (FE-B entrega `assets/img/logo-aqta.svg` vetorizado, com o traço do Q em ciano) |
| `.reveal` / `.is-visible` | animação de entrada ao rolar |

## Arquivos e donos

| Agente | Arquivos (exclusivos) |
| --- | --- |
| **FE-A** — Landing (estrutura, conteúdo, seções) | `index.html`, `assets/css/landing.css`, `assets/js/landing.js`, `assets/img/obtra-*`, `assets/img/emptra-*`, `404.html` |
| **FE-B** — Design system, marca e páginas internas | `assets/css/aqta.css`, `assets/img/logo-aqta.svg`, `assets/img/favicon.svg`, `assets/img/og-image.*` |
| **PAY-A** — Início do checkout | `api/catalog.js`, `api/checkout.js`, `lib/mercadopago.js`, `assets/js/checkout.js` (modal de compra) |
| **PAY-B** — Confirmação do pagamento | `api/webhook.js`, `api/payment-status.js`, `lib/token.js`, `checkout-demo.html`, `assets/js/checkout-demo.js`, `api/demo-pay.js` |
| **POST-A** — Página pós-pagamento | `obrigado.html`, `assets/js/obrigado.js` |
| **POST-B** — Provisionamento e acesso ao produto | `api/onboarding.js`, `api/lead.js`, `lib/provision/obtra.js`, `lib/provision/emptra.js`, `lib/notify.js`, `acesso.html`, `assets/js/acesso.js` |
| **TESTER** | `tests/**` |
| **REVISOR** | `docs/REVISAO.md` (somente leitura no resto) |

Arquivos do orquestrador (não editar): `server.js`, `lib/http.js`, `lib/catalog.js`, `package.json`, `vercel.json`,
`.env.example`, `docs/ARQUITETURA.md`, `README.md`. Se precisar mudar um deles, descreva no seu relatório final.

## Contratos entre módulos

### Landing → checkout (FE-A ↔ PAY-A)

- Botões de compra: `<button class="btn btn--primary" data-checkout="obtra" data-plan="basico">` (ou `emptra`).
- `index.html` carrega, no fim do body: `<script type="module" src="/assets/js/landing.js"></script>` e
  `<script type="module" src="/assets/js/checkout.js"></script>`.
- `checkout.js` cria seu próprio `<dialog class="modal" id="checkout-modal">` via JS (FE-A não escreve essa marcação),
  escuta cliques em `[data-checkout]` (delegação no `document`), coleta: nome, e-mail, WhatsApp, CPF/CNPJ,
  nome da empresa; valida; `POST /api/checkout`; redireciona para `init_point`.
- Formulário de sistema personalizado: `<form id="lead-form">` com campos `name, email, whatsapp, company, message`
  (+ honeypot `website` oculto). O envio (`POST /api/lead`) é tratado por `landing.js` (FE-A).
- Preços exibidos: FE-A pode escrever os valores no HTML (R$ 200 / R$ 300 por mês) e também pode ler `GET /api/catalog`.

### `GET /api/catalog` (PAY-A)
`200 { products: [{ id, name, tagline, plans: [{ id, name, priceCents, price: "R$ 200,00", interval }] }], demo: bool }`

### `POST /api/checkout` (PAY-A)
Entrada JSON: `{ product: "obtra"|"emptra", plan: "basico", customer: { name, email, whatsapp, document, company } }`
- Valida tudo no servidor (e-mail, CPF/CNPJ com dígito verificador, WhatsApp BR 10–13 dígitos, nome ≥ 3).
  Erro ⇒ `400 { error: "validation", fields: { email: "mensagem" ... } }`.
- `external_reference` = `aqta:<product>:<plan>:<uuid>`. `metadata` = `{ product, plan, customer_name, customer_email,
  customer_whatsapp, customer_document, customer_company }`.
- Produção: cria preferência `POST https://api.mercadopago.com/checkout/preferences` com `items` (preço do catálogo),
  `payer`, `back_urls` = `${base}/obrigado` (success/pending/failure), `auto_return: "approved"`,
  `notification_url` = `${base}/api/webhook`, `statement_descriptor: "AQTA"`, header `X-Idempotency-Key`.
- Demo: retorna `init_point` = `${base}/checkout-demo?ref=<token>` onde `<token>` = `signToken({ t:"demo", ref, product,
  plan, customer, amountCents }, 3600)` (de `lib/token.js`).
- Resposta: `200 { init_point, external_reference, demo }`.

### `lib/token.js` (PAY-B)
- `signToken(payload, ttlSeconds) → string` (base64url(JSON) + "." + base64url(HMAC-SHA256), com `exp`).
- `verifyToken(token) → payload | null` (comparação em tempo constante, rejeita expirado/adulterado).
- Segredo: `AQTA_TOKEN_SECRET`; se ausente e modo demo, usa segredo de desenvolvimento fixo; se ausente em produção,
  lança erro.

### Gateway demo (PAY-B)
- `checkout-demo.html` (+ `checkout-demo.js`): lê `ref`, mostra resumo do pedido (produto, plano, valor, cliente),
  simula PIX (QR fake) / cartão; botões "Aprovar pagamento", "Deixar pendente", "Recusar".
- `POST /api/demo-pay { ref, outcome: "approved"|"pending"|"rejected" }` ⇒ só funciona em modo demo (`404` em
  produção); retorna `{ redirect }` = `/obrigado?payment_id=<demoPaymentToken>&status=<outcome>&external_reference=<ref>`
  onde `demoPaymentToken` = `"demo_" + signToken({ t:"demopay", status, product, plan, customer, ref, amountCents }, 86400)`.

### `GET /api/payment-status?payment_id=...&external_reference=...` (PAY-B)
- `external_reference` é **obrigatório** (anti-enumeração): ausente ⇒ `400 missing_reference`; divergente ⇒ `404`.
- Produção: `GET https://api.mercadopago.com/v1/payments/{id}` — **a verdade vem do Mercado Pago**, nunca dos
  parâmetros da URL de retorno. Confere `external_reference` começando com `aqta:`, valor pago ≥ preço do catálogo,
  moeda BRL.
- Demo: `payment_id` começando com `demo_` ⇒ `verifyToken`.
- Resposta: `200 { status: "approved"|"pending"|"in_process"|"rejected"|"cancelled"|..., product, plan, productName,
  amount: "R$ 200,00", customer: { name, email, company }, accessToken? }`
  - `accessToken` só quando `approved`: `signToken({ t:"access", paymentId, product, plan, customer }, 7*86400)`.
- `400` sem payment_id; `404` pagamento inexistente/não-Aqta; `502` falha do Mercado Pago.

### `POST /api/webhook` (PAY-B)
- Valida assinatura `x-signature` (`ts=...,v1=...`) com `MP_WEBHOOK_SECRET` (manifesto
  `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`) quando o segredo existe; inválida ⇒ `401`.
- Para `type=payment`: consulta o pagamento; se `approved`, chama `notifyTeam({ event: "payment.approved", ... })`
  de `lib/notify.js` (POST-B). Sempre responde `200` rápido a eventos válidos (Mercado Pago re-tenta em não-2xx).

### Página `/obrigado` (POST-A)
Recebe `?payment_id=&status=&external_reference=` (Mercado Pago também manda `collection_id`, `collection_status`,
`preference_id` — aceitar `collection_id` como fallback de `payment_id`).
1. Chama `/api/payment-status`. Estados visuais: carregando → aprovado | pendente (PIX/boleto: explica, faz polling a
   cada 5s por até 10 min, botão "já paguei, verificar") | recusado (botão tentar novamente → `/#planos`) | erro.
2. Aprovado ⇒ formulário de ativação (onboarding): dados já conhecidos preenchidos; pede **nome da empresa**,
   **CNPJ/CPF**, **responsável**, **e-mail de login**, **WhatsApp**, e campos específicos por produto:
   - Obtra: quantidade estimada de obras ativas (select), cidade/UF.
   - Emptra: perfil (`comprador` | `fornecedor`), cidade de atuação.
   Envia `POST /api/onboarding` e, ao sucesso, redireciona para `/acesso?token=<accessToken>` (guardar o token em
   `sessionStorage` também). Se `onboarding` já tiver sido feito para aquele token (resposta `alreadyDone`), vai direto.

### `POST /api/onboarding` (POST-B)
Entrada: `{ accessToken, company, document, responsible, loginEmail, whatsapp, extra: {...} }`.
- `verifyToken` (`t === "access"`), valida campos (mesmas regras do checkout).
- Provisiona via `lib/provision/<product>.js` → `provision({ product, plan, company, document, responsible,
  loginEmail, whatsapp, extra, paymentId })` ⇒ `{ mode: "auto"|"manual", loginUrl, loginEmail, tempPassword? , notes }`.
  - **Obtra auto** (se `OBTRA_SUPABASE_URL` + `OBTRA_SUPABASE_SERVICE_KEY`): estude
    `docs/ref/obtra` (`supabase/instalar.sql`, RPC `admin_criar_usuario` e criação de empresa) e crie empresa +
    usuário admin da empresa via REST/RPC do Supabase com a service key; gera senha temporária forte.
  - **Emptra auto** (se `EMPTRA_API_URL` + credenciais admin): estude `docs/ref/emptra` (backend Express — rotas de
    auth e admin) e crie empresa/usuário liberado com o perfil escolhido; senha temporária.
  - Sem credenciais ⇒ `manual`: equipe Aqta é notificada para liberar o acesso em até 1 dia útil.
  - Erro no provisionamento automático ⇒ cai para `manual` (nunca perde a venda) e notifica a equipe com o erro.
- Sempre `notifyTeam({ event: "onboarding.completed", ... })`.
- Resposta: `200 { ok: true, mode, product, productName, loginUrl, loginEmail, tempPassword?, accessToken }` onde o
  novo `accessToken` = token `t:"access"` acrescido de `onboarded: true` e do resultado (sem a senha).

### Página `/acesso` (POST-B)
- Lê `?token=` (ou `sessionStorage`), mostra resumo: produto, empresa, e-mail de login, senha temporária (se veio na
  resposta do onboarding, guardada só em `sessionStorage`, com botão copiar), modo manual (prazo de liberação +
  botão WhatsApp Aqta). Botão principal **"Entrar no Obtra" / "Entrar no Emptra"** → `loginUrl` (abre na mesma aba).
  Passo a passo dos primeiros passos no produto. Token inválido ⇒ mensagem + link para suporte.
- Pode usar `GET /api/onboarding?token=...` (POST-B) para revalidar o token e obter os dados públicos.

### `POST /api/lead` (POST-B)
`{ name, email, whatsapp, company, message, website }` — honeypot `website` preenchido ⇒ `200 {ok:true}` sem fazer
nada. Valida, `notifyTeam({ event: "lead.custom_system", ... })`, responde `200 { ok: true, whatsappUrl }`
(link wa.me para `AQTA_WHATSAPP` com mensagem pré-preenchida).

### `lib/notify.js` (POST-B)
`notifyTeam(event) → Promise<boolean>`: POST JSON para `AQTA_NOTIFY_WEBHOOK` (timeout 5s, nunca lança). Sem webhook,
apenas `console.log` estruturado.

## Material de referência

- Código do Obtra e do Emptra (somente leitura): `/tmp/claude-0/-home-user-landingpageaqta/7321b974-90c0-55ac-9f24-1a1b29515ffe/scratchpad/ref/obtra`
  e `.../scratchpad/ref/emptra` (citados acima como `docs/ref/...`). Use para entender funcionalidades (copy da
  landing), telas (mockups) e APIs (provisionamento). Os painéis ao vivo não são acessíveis a partir deste ambiente.

## Regras gerais

- Português do Brasil em todo texto visível. Acessível (labels, foco visível, contraste, `prefers-reduced-motion`).
- Responsivo de 360px a 1440px, sem scroll horizontal.
- Nada de segredo no front. Todo valor monetário vem do servidor/catalog.
- Sem dependências externas além de Google Fonts.
- Testar localmente: `PORT=3000 node server.js` (modo demo).
