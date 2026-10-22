# Relatório de testes — Landing Aqta (Obtra + Emptra)

Data: 22/10/2026 · Node v22.22.0 · Chromium 1194 (Playwright global) · agente TESTADOR

## Como rodar

```bash
# API (sem navegador) — 190 testes, ~3 s
node --test 'tests/api/**/*.test.js'

# Navegador (e2e) — 54 testes, ~3 min
node --test 'tests/e2e/**/*.test.js'

# Inspeção visual (não é teste): screenshots 1440/390 de cada página/estado + report.json
node tests/tools/screenshots.mjs /caminho/da/pasta
```

> **Atenção:** `npm test` e `npm run test:e2e` **não funcionam** hoje (ver BUG-1). Use os comandos acima
> até o `package.json` ser corrigido.

- Sem dependências npm. Só `node:test` + `node:assert`.
- O servidor sobe dentro do processo do teste (`createServer()` de `server.js`, porta 0) com ambiente
  controlado: todas as variáveis conhecidas são zeradas (um `.env` local não interfere) e o padrão é o **modo demo**.
- Produção é simulada setando `MP_ACCESS_TOKEN`/`AQTA_TOKEN_SECRET` e trocando `globalThis.fetch` por um
  Mercado Pago falso (`tests/helpers/fetch-mock.js`). As URLs que não são do MP vão para o fetch real.
- Notificações da equipe (`AQTA_NOTIFY_WEBHOOK`) vão para um servidor local de captura (`tests/helpers/capture.js`).
- O provisionamento automático é testado contra servidores falsos do Supabase do Obtra e da API do Emptra
  (`tests/helpers/mock-products.js`), que imitam as chamadas de `lib/provision/*.js`.
- Playwright: `tests/helpers/browser.js` importa `/opt/node-tools/node_modules/playwright/index.mjs` e usa
  `/opt/pw-browsers/chromium`. Os dois podem ser trocados por `PLAYWRIGHT_MODULE` / `PLAYWRIGHT_CHROMIUM`. Se não
  existirem, todos os e2e se auto-pulam (SKIP). Requisições externas (Google Fonts, wa.me) são respondidas
  localmente com corpo vazio, o que deixa os testes determinísticos. Nas screenshots as fontes reais são baixadas via `curl`.

### Arquivos

| Arquivo | O que cobre |
| --- | --- |
| `tests/api/catalog.test.js` | preços em centavos e texto, `demo`, métodos, sem dados internos |
| `tests/api/static.test.js` | páginas 200, cleanUrls, 404 HTML/JSON, arquivos privados (`lib/`, `.env`, `server.js`...), path traversal, assets com Content-Type |
| `tests/api/checkout.test.js` | CPF e CNPJ válidos, normalização, 23 casos de campo inválido (um por vez), cliente com tipos errados, produto/plano inválido (`__proto__`, `constructor`, `toString`, não-string), poluição de protótipo, métodos, corpo > 4 KB, JSON inválido, preço sempre do catálogo, produção simulada (preferência, back_urls, notification_url, idempotência, metadata, falhas do MP ⇒ 502 sem vazar detalhe) |
| `tests/api/token.test.js` | assinatura HMAC conferida, adulteração de payload/assinatura, malformados, expiração, outro segredo, segredo ausente/placeholder/curto em produção, token demo inválido em produção |
| `tests/api/demo-pay.test.js` | resumo do pedido, 3 resultados, outcome inválido, ref adulterado/expirado/de outro tipo/valor menor, 404 em produção |
| `tests/api/payment-status.test.js` | demo aprovado/pendente/recusado, `?status=` ignorado, `collection_id`, sem payment_id, sem/errada external_reference, token adulterado, troca de tipo de token; produção: aprovado, pendente, valor menor, moeda, ref de outra loja, MP 404/400/401/500/rede, id não numérico, segredo ausente, fallback do payer |
| `tests/api/webhook.test.js` | HMAC correta/incorreta/ausente/malformada, data.id do corpo não engana, sem segredo, tipos ignorados, IPN legado, pendente, inexistente, valor inválido, MP 500 ⇒ 500, deduplicação, webhook da equipe fora do ar, demo |
| `tests/api/onboarding.test.js` | GET/POST com token válido/inválido/adulterado/expirado/de outro tipo, validação (15 casos + perfil Emptra + extra malformado), 413/405, modo manual (Obtra/Emptra, `OBTRA_APP_URL`/`EMPTRA_APP_URL`), idempotência (alreadyDone, token onboarded, duplo clique simultâneo), **auto Obtra** (empresa + RPC, senha forte, chave JWT legada, e-mail existente, falha da RPC ⇒ rollback + manual sem vazar senha, rede), **auto Emptra** (comprador CNPJ, fornecedor CPF, falha ⇒ rollback + logout, admin não-ADMIN, senha errada, e-mail existente), um pagamento ⇒ uma conta entre instâncias |
| `tests/api/lead.test.js` | sucesso + notificação, whatsappUrl com e sem `AQTA_WHATSAPP`, opcionais, honeypot, 12 casos de validação, 413/405, rate limit (6º envio ⇒ 429) |
| `tests/e2e/purchase.test.js` | **fluxo completo Obtra e Emptra** (landing → `[data-checkout]` → modal → `/checkout-demo` → aprovar → `/obrigado` → ativação → `/acesso` → "Entrar no X" com href `…/entrar`), revisita/alreadyDone, validação e máscaras do modal, Esc/foco, pendente (polling e "Já paguei"), recusado → `/#planos` |
| `tests/e2e/polling.test.js` | produção simulada no navegador: pendente → aprovado pelo polling de 5 s, "em análise" → aprovado pelo botão, pendente → cancelado/expirado, PIX vs boleto, ref divergente |
| `tests/e2e/landing.test.js` | console limpo e sem 404, imagens carregam, preços batem com o catálogo, âncoras e links internos, `[data-checkout]` válidos, sem scroll horizontal em 360/390/768/1440 (8 páginas/estados + modal), mensagens dinâmicas no mobile, menu mobile, FAQ (mouse e teclado), lead (sucesso, erro do navegador, erro do servidor, 500, 429) |
| `tests/e2e/pages.test.js` | `/obrigado` sem parâmetros / sem ref / inexistente, `/acesso` sem token / inválido / expirado / sem ativação, `/checkout-demo` sem ref / inválido, 404, número de WhatsApp de suporte |
| `tests/e2e/a11y.test.js` | alt, labels, um único h1 visível, nome acessível de botões e links, ids únicos, referências ARIA, âncoras, em 14 páginas/estados; "pular para o conteúdo" existe e aparece no foco |
| `tests/tools/screenshots.mjs` | inspeção visual: 35 capturas (1440 e 390, mais checkout demo em 768) |

## Resultado

| Suíte | Testes | Passaram | Falharam |
| --- | ---: | ---: | ---: |
| API (`tests/api`) | 190 | 189 | 1 (BUG-2) |
| E2E (`tests/e2e`) | 54 | 49 | 5 (BUG-3, BUG-4 ×2, BUG-5, BUG-6) |
| **Total** | **244** | **238** | **6** |

Os testes que falham expõem defeitos reais do produto. Deixei-os falhando de propósito, sem `todo`, para que voltem a
passar quando o defeito for corrigido. Os testes que falharam por erro meu foram corrigidos durante a rodada:
`networkidle` no checkout demo com ref inválido, e o 1º Tab partindo do título focado via JS.

O fluxo principal funciona de ponta a ponta para Obtra e Emptra. Funcionam também o checkout, os tokens, o webhook, o
provisionamento automático com fallback manual (sem vazar a senha) e as páginas de erro. Os preços (R$ 200 / R$ 300)
estão consistentes em landing, modal, checkout demo, `/obrigado` e API.

Screenshots: `/tmp/claude-0/-home-user-landingpageaqta/7321b974-90c0-55ac-9f24-1a1b29515ffe/scratchpad/tester/`.

## Defeitos

### BUG-1 — `npm test` e `npm run test:e2e` não rodam nada (alto)
- **Arquivo:** `package.json:10-11` (`"test": "node --test tests/api/"`, `"test:e2e": "node --test tests/e2e/"`)
- **Reproduzir:** `npm test` no Node 22 (o projeto exige `>=20`).
- **Esperado:** rodar os testes de `tests/api/`.
- **Obtido:** `Error: Cannot find module '/home/user/landingpageaqta/tests/api'`, 1 falha e 0 testes executados.
  Desde o Node 21, `--test` recebe arquivos/globs, não diretórios.
- **Correção:** `"test": "node --test tests/api/*.test.js"` e `"test:e2e": "node --test tests/e2e/*.test.js"`. O shell
  expande o glob, então funciona no Node 20 e no 22. (`package.json` é arquivo do orquestrador.)

### BUG-2 — Um mesmo pagamento pode criar várias contas (médio)
- **Arquivo:** `api/onboarding.js:26` (`const done = new Map()`) e `:284`. A idempotência existe só na memória da instância.
- **Reproduzir:** teste `onboarding.test.js › um pagamento não pode criar duas contas…`.
  1. Ative com o accessToken (válido 7 dias) e o e-mail `conta1@…`. O Obtra cria a empresa e o admin.
  2. Em outra instância serverless (ou depois de deploy ou cold start), reenvie o formulário com o **mesmo token** e o
     e-mail `conta2@…`.
- **Esperado:** `alreadyDone` ou recusa. Um pagamento dá direito a um acesso.
- **Obtido:** `mode=auto`, com segunda empresa e segundo usuário criados ("o mesmo pagamento criou 2 contas"). Basta
  abrir de novo o link `/obrigado` (o accessToken é regenerado a cada consulta) em outro momento.
- **Correção:** fazer a idempotência fora da memória. Opções: gravar `paymentId` no provedor e consultar antes de
  criar (coluna/observação em `empresas` no Obtra, campo de referência em `companies` no Emptra) ou usar um KV
  (Vercel KV/Upstash) com a chave `paymentId`. Paliativo: recusar quando o provedor já tiver uma empresa com o mesmo CNPJ.

### BUG-3 — Checkout demo com scroll horizontal em tablet (768 px) (médio)
- **Arquivo:** `checkout-demo.html:66` (`.cd-actions { grid-template-columns: 1.4fr 1fr 1fr }`) e `:73`
  (`@media (max-width: 760px)`).
- **Reproduzir:** abrir `/checkout-demo?ref=…` com a largura em 768 px (teste `landing.test.js › 768px…`, screenshot
  `05b-checkout-demo-768-768.png`).
- **Esperado:** botões dentro do cartão e sem scroll horizontal.
- **Obtido:** a página ganha +118 px de largura. "Deixar pendente" e "Recusar" saem do cartão e da tela, e a faixa
  "Ambiente de demonstração" não cobre a largura toda.
- **Correção:** subir o breakpoint para ~900 px ou usar `grid-template-columns: repeat(auto-fit, minmax(150px, 1fr))`
  em `.cd-actions`.

### BUG-4 — Mensagem de sucesso do lead quebrada no celular (médio)
- **Arquivo:** `assets/js/landing.js:222-226` (HTML solto dentro de `.alert`) com `assets/css/aqta.css:584`
  (`.alert { display: flex }`).
- **Reproduzir:** em 360/390 px, envie o formulário "Sistema personalizado" com `AQTA_WHATSAPP` configurado (testes
  `landing.test.js › 360px/390px: mensagem de sucesso do lead…`).
- **Esperado:** texto em bloco e botão "Continuar no WhatsApp" abaixo, dentro do alerta.
- **Obtido:** `<strong>`, o texto e o botão viram colunas do flex. O texto fica espremido numa coluna estreita e o botão
  sai do alerta (direita em 391 px contra 358 px do alerta), criando scroll horizontal de +31 px em 360 px.
- **Correção:** envolver o conteúdo num `<div>` (`showStatus('ok', '<div>…</div>')`, como o próprio `aqta.css` prevê em
  `.alert > :is(div,p)`).

### BUG-5 — WhatsApp de suporte fixo e de exemplo (5521999999999) em `/obrigado` e `/acesso` (médio)
- **Arquivos:** `obrigado.html:134,140,170`, `acesso.html:46,51` (`data-support-whatsapp="5521999999999"` e hrefs).
- **Reproduzir:** suba com `AQTA_WHATSAPP=5521988887777` e abra `/obrigado` ou `/acesso` (teste
  `pages.test.js › links de suporte usam o WhatsApp configurado…`).
- **Esperado:** todos os botões "Falar com o suporte" levam ao número configurado (que a landing e a API já usam).
- **Obtido:** 5 links apontam para `https://wa.me/5521999999999`, o número de exemplo do `.env.example`. Só a tela
  "pronto" do `/acesso` usa o número do servidor. Em produção, um cliente que pagou e tem problema cai num número inexistente.
- **Correção:** expor o número numa API (ex.: `GET /api/catalog` → `supportWhatsapp`) e preencher via JS, ou trocar pelo
  número real antes de publicar.

### BUG-6 — "Pular para o conteúdo" invisível ao receber foco em `/obrigado` e `/acesso` (baixo)
- **Arquivos:** `obrigado.html:135`, `acesso.html:47` (usam `.sr-only`). `assets/css/aqta.css:868` não tem regra `:focus`.
- **Reproduzir:** foco no link (teste `a11y.test.js › o link "pular para o conteúdo" fica VISÍVEL…`).
- **Esperado:** o link aparece quando recebe foco (WCAG 2.4.7), como acontece na landing (`.lp-skip`).
- **Obtido:** o link focado continua com 1×1 px.
- **Correção:** em `aqta.css`, `.sr-only:focus, .sr-only:focus-visible { position: fixed; left: 12px; top: 12px;
  width: auto; height: auto; clip: auto; padding: 8px 14px; z-index: 200; background: var(--cyan); color: #00131b; }`,
  ou uma classe `.skip-link`.

### BUG-7 — No demo, o CPF/CNPJ digitado no checkout não vem preenchido na ativação (baixo)
- **Arquivo:** `api/demo-pay.js:70` (o documento é removido do token de pagamento demo). Por isso
  `/api/payment-status` devolve `documentMasked: ''`.
- **Reproduzir:** compra demo → aprovar. O campo "CNPJ ou CPF" de `/obrigado` vem vazio (screenshot
  `06-obrigado-aprovado-obtra-390.png`).
- **Esperado:** o mesmo comportamento da produção, onde o documento vem do metadata do MP e é preenchido.
- **Correção:** guardar o documento mascarado no token demo e mostrar a dica "Informado no pagamento: ***.982.***-**",
  como em produção.

### BUG-8 — Textos prometem o que o sistema não faz (baixo)
- `assets/js/obrigado.js:284`: "Você receberá um e-mail quando for confirmado". Nenhum e-mail é enviado ao cliente;
  `notifyTeam` só avisa a equipe.
- `index.html:94,105` e `og:description` (l. 16): "comece a usar no mesmo dia" / "Ativação: No mesmo dia". Sem
  credenciais de provisionamento, o modo é manual "em até 1 dia útil" (FAQ e `/acesso`).
- **Correção:** ajustar os textos ("avisaremos pelo WhatsApp/e-mail", "ativação em até 1 dia útil") ou implementar o e-mail.

### BUG-9 — "Termos de uso" citados sem link (baixo)
- `assets/js/obrigado.js:264` ("Ao ativar, você concorda com os termos de uso…") e o checkbox do modal
  (`assets/js/checkout.js:199`) citam condições, mas não existe página nem link de termos ou política de privacidade.
- **Correção:** criar `/termos` e `/privacidade` e linkar nos dois pontos e no rodapé.

### BUG-10 — Imagem de compartilhamento (OG/Twitter) com URL relativa (baixo)
- `index.html:17,22` (`/assets/img/og-image.png`) e `canonical` relativo (l. 10). WhatsApp, Facebook e LinkedIn exigem
  URL absoluta, então o link compartilhado sai sem imagem.
- **Correção:** usar a URL absoluta do domínio de produção.

## Observações (não são defeitos, mas vale saber)

- **Rate limit do lead** (`api/lead.js:34`): fica em memória por instância e usa o 1º valor de `X-Forwarded-For`. Na
  Vercel o cabeçalho é reescrito pela plataforma, então o limite é de melhor esforço.
- **Webhook** (`api/webhook.js:56`): não verifica a idade do `ts` (permite replay), mas o efeito é só reconsultar o MP e
  a notificação é deduplicada.
- **Formulário de lead:** o navegador exige mensagem com ≥ 10 caracteres (`landing.js:169`), mas no servidor/contrato
  ela é opcional. A inconsistência é inofensiva.
- **`server.js` (local):** `readBody` não limita o tamanho do corpo. Só afeta o servidor de desenvolvimento.
- **Testes de checkout demo:** `checkout-demo.js:133` não consome o corpo da resposta 400, e o Chromium não chega a
  `networkidle`. Sem efeito visível para o usuário.
- **Inspeção visual:** nas 35 capturas não encontrei textos quebrados, preços divergentes nem links mortos (só os
  números de suporte do BUG-5). Também não houve erros de console. A identidade visual está consistente entre as páginas.
