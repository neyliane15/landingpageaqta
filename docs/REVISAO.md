# Revisão — Landing Aqta (Obtra + Emptra)

Data: 22/10/2026 · Node v22.22.0 · Chromium (Playwright em `/opt/pw-browsers`) · agente REVISOR

Escopo: a suíte e o relatório do TESTADOR (`tests/`, `tests/RELATORIO-TESTES.md`), o código de produção (`api/`, `lib/`,
`assets/js/`, `*.html`, `vercel.json`) e o contrato com os produtos reais: Supabase do Obtra (`supabase/instalar.sql`)
e backend do Emptra (`backend/src`, `prisma/schema.prisma`). Nenhum arquivo de produção foi alterado. Acrescentei
`tests/api/revisao.test.js` com 7 testes que provam os achados novos. Hoje os 7 falham de propósito.

## Números conferidos

| Comando | Testes | Passaram | Falharam | Observação |
| --- | ---: | ---: | ---: | --- |
| `npm test` (antes da revisão) | 190 | 189 | 1 | BUG-2. Bate com o relatório. |
| `npm run test:e2e` | 54 | 49 | 5 | BUG-3, BUG-4 ×2, BUG-5, BUG-6. Bate com o relatório (~88 s). |
| `npm test` (com `revisao.test.js`) | 197 | 189 | 8 | +7 falhas: REV-1, REV-3 ×2, REV-4, REV-5, REV-7, REV-9. |

---

## (a) Parecer sobre a suíte do testador

**Nota: 7,5/10.** A suíte é boa e honesta: os testes falham pelos motivos certos, não há `try/catch` engolindo
asserção nem `assert.ok(true)`, e os testes de defeito ficam vermelhos de propósito. Mas ela verifica sobretudo o
**servidor local** e **mocks feitos à imagem do próprio código**. Por isso deixou passar justamente os riscos de
plataforma (Vercel) e de dinheiro (reembolso, modo demo).

### Pontos fortes
- O ambiente é isolado (`tests/helpers/server.js:24-37` zera todas as variáveis). A produção é simulada com
  `fetch` falso, sem rede real.
- A assinatura do webhook é calculada **pela documentação do MP**, sem reaproveitar o código testado
  (`tests/api/webhook.test.js:37-40`: manifesto `id:<data.id minúsculo>;request-id:…;ts:…;`, HMAC-SHA256 em hex). Os casos
  negativos são bons: outro request-id, outro id, outro segredo, `v1` malformado.
- O fixture do pagamento (`tests/helpers/fetch-mock.js:36-58`) segue o formato real de `GET /v1/payments/{id}`: `id`
  numérico, `status`/`status_detail`, `currency_id`, `transaction_amount`, `external_reference`, `payment_type_id` e
  `metadata` em snake_case (o MP converte as chaves).
- O teste de "outra instância serverless" (`onboarding.test.js:327`, com `importProject(..., { fresh: true })`) é a forma
  certa de provar o BUG-2.
- O rollback e a garantia de que a senha não vaza no modo manual estão bem cobertos (`onboarding.test.js:283`,
  `:393`).
- O e2e roda num navegador real e cobre layout em 4 larguras, foco, teclado e console limpo.

### Falhas da suíte

| # | Onde | Problema |
| --- | --- | --- |
| S1 | `tests/api/static.test.js:35-37` | Testa que `/lib/token.js`, `/server.js`, `/docs/…` e `/tests/…` dão 404. Quem bloqueia esses caminhos é o `PRIVATE` do **server.js local** (`server.js:23`). Na Vercel essa regra não existe e os arquivos são publicados (ver REV-4). O teste dá uma segurança falsa. |
| S2 | `tests/helpers/mock-products.js:120,133` | O mock do Emptra aceita qualquer e-mail e devolve `400 VALIDATION`. A API real valida com `z.string().email()` (`companies.routes.ts:42`, `admin.routes.ts:85`) e responde `422 VALIDATION_ERROR` (`middlewares/error.ts:13-20`). O mock aceita o que a API real rejeita (REV-7). |
| S3 | `tests/helpers/mock-products.js:135` | E-mail duplicado em `POST /admin/users` vem do mock como `409 "E-mail já cadastrado"`. A API real devolve P2002 → `409 "Já existe um registro com este email"` (`error.ts:28-33`). Com a mensagem real, `lib/provision/emptra.js:81` classifica o erro como `conflict` e não como `email_exists`, e o cliente recebe a nota genérica. |
| S4 | `tests/helpers/mock-products.js:69` | No mock do Obtra, a RPC com e-mail duplicado devolve `400 P0001`. O real é `409` com `code 23505` (`instalar.sql:1702`, que o PostgREST mapeia para 409). A lib trata os dois casos pela mensagem, então não há efeito. Mesmo assim, o mock deveria imitar o real. |
| S5 | `tests/api/webhook.test.js:130` | O teste do "IPN legado" **desliga** o `MP_WEBHOOK_SECRET`. Com o segredo configurado, como em produção, o IPN sem assinatura leva 401 (REV-9). O teste esconde esse caso. |
| S6 | `payment-status.test.js` / `onboarding.test.js` | Nenhum teste cobre `refunded`, `charged_back`, `in_mediation` ou `partially_refunded` **depois** da emissão do accessToken (REV-3). |
| S7 | `onboarding.test.js` | Nenhum teste cobre o modo demo com credenciais de provisionamento configuradas (REV-1). Esse é o achado mais grave. |
| S8 | `tests/helpers/browser.js:136` | Sem Chromium, os 54 e2e são marcados como SKIP e `npm run test:e2e` termina **verde**. Em CI, isso precisa falhar, por exemplo com `E2E_REQUIRED=1` ⇒ `throw` em vez de skip. |
| S9 | `tests/helpers/fetch-mock.js:21` | Uma URL não tratada vai para o `fetch` real. Um teste mal escrito pode chamar a internet sem ninguém perceber. Melhor falhar quando o host não estiver na lista. |
| S10 | `tests/RELATORIO-TESTES.md` ("Como rodar", BUG-1) | O relatório está desatualizado. Ele diz que `npm test` não funciona, mas o próprio commit `108a0f1` já corrigiu o `package.json`. A suíte também só foi rodada no Node 22, embora `engines` peça `>=20` (ver BUG-1). |

---

## (b) Veredito dos BUG-1..10

| Bug | Veredito | Severidade (testador → revisor) | Nota do revisor |
| --- | --- | --- | --- |
| BUG-1 `npm test` não roda | **Parcialmente corrigido** | alto → **baixo** | O `package.json` atual usa glob entre aspas (`'tests/api/**/*.test.js'`) e funciona no Node 22: rodei os dois scripts. Ainda falha no Node 20, que o `engines` promete, porque o glob dentro de `--test` só existe a partir do Node 21. Correção: `node --test tests/api/*.test.js` sem aspas, ou subir `engines` para `>=22`. |
| BUG-2 um pagamento ⇒ várias contas | **Confirmado** | médio → **ALTO** | Reproduzi com o teste do testador. Fica pior por causa do REV-6: `/obrigado` emite um accessToken novo a cada visita, então o link de retorno funciona como credencial permanente para criar contas. Na Vercel, a idempotência em memória (`api/onboarding.js:26,283-287`) some a cada cold start. No Obtra, `empresas` não tem restrição única (`instalar.sql:19-33`). No Emptra, só o CNPJ é único (`schema.prisma:105`): com CPF, nada impede a duplicata. |
| BUG-3 checkout demo em 768 px | **Confirmado** | médio → **baixo** | Só aparece no gateway simulado, que não existe em produção (`api/demo-pay.js:39` ⇒ 404). |
| BUG-4 alerta do lead no celular | **Confirmado** | médio | `landing.js:174,222-226` + `.alert{display:flex}`. Causa scroll horizontal de +31 px em 360 px. |
| BUG-5 WhatsApp de exemplo fixo | **Confirmado** | médio → **ALTO** | `obrigado.html:134,140,170`, `acesso.html:46,51`. Quem já pagou e precisa de ajuda cai num número inexistente. A landing também não tem nenhum link direto de WhatsApp (REV-11). |
| BUG-6 skip-link invisível | **Confirmado** | baixo | `obrigado.html:135`, `acesso.html:47` usam `.sr-only` sem regra de `:focus`. |
| BUG-7 documento não vem no demo | **Confirmado** | baixo | `api/demo-pay.js:70`. Só afeta o demo. |
| BUG-8 textos que prometem demais | **Parcialmente confirmado** | baixo | "Você receberá um e-mail quando for confirmado" (`obrigado.js:284`) **é verdade**: o próprio Mercado Pago manda o comprovante ao pagador. "No mesmo dia" (`index.html:16,94,105,362,399`) é falso na configuração padrão, que é manual "até 1 dia útil". `acesso.js:199` promete aviso "no WhatsApp e no e-mail", o que depende de a equipe receber a notificação (REV-5). |
| BUG-9 termos sem link | **Confirmado** | baixo → **MÉDIO** | Além dos termos, falta a **política de privacidade**, e o site coleta CPF/CNPJ (LGPD). O rodapé (`index.html`, `<footer>`) também não traz razão social, CNPJ, endereço nem contato, que o Decreto 7.962/2013 exige em vendas online. |
| BUG-10 OG com URL relativa | **Confirmado** | baixo | `index.html:10,17,22`. O `logo` do JSON-LD (`index.html:35`) também é relativo. |

Observações do testador: concordo com todas. O replay do webhook sem checar `ts` (`webhook.js:46-56`) é baixo, porque o
código sempre reconsulta o MP.

---

## (c) Achados novos

Legenda: **CRÍTICO** bloqueia a publicação · **ALTO** corrigir antes de ir ao ar · **MÉDIO** corrigir logo · **BAIXO** melhoria.

### REV-1 — CRÍTICO (depende da configuração): o modo demo cria contas reais de graça, e qualquer pessoa pode forjar o token
- **Onde:** `lib/http.js:33` (`isDemo = !MP_ACCESS_TOKEN`), `lib/token.js:8,20` (segredo fixo do demo, público no
  código e servido pela Vercel, ver REV-4), `api/onboarding.js:269-320`, que **nunca** verifica `isDemo()`, e
  `lib/provision/obtra.js:101-108` / `lib/provision/emptra.js:277-287`, que provisionam sempre que há credenciais.
- **Cenário:** deploy ainda sem `MP_ACCESS_TOKEN`, porque as credenciais do MP não chegaram ou porque é um preview da
  Vercel, mas com `OBTRA_SUPABASE_*` / `EMPTRA_*` cadastrados em "All Environments". Qualquer visitante:
  (1) usa o checkout demo e clica em "Aprovar", ou (2) nem passa pelo checkout e assina
  `{t:'access', product:'obtra', …}` com `aqta-demo-secret-nao-use-em-producao`. Nos dois casos, `POST /api/onboarding`
  cria empresa e administrador **reais** no Obtra ou no Emptra.
- **Prova:** `tests/api/revisao.test.js` › REV-1. Resultado: "o token forjado criou 1 usuário real no Obtra (mode=auto)".
- **Correção:**
  1. Em `api/onboarding.js`, logo no início de `runOnboarding`:
     `if (isDemo()) result = { mode: 'manual', notes: 'Demonstração: nenhum acesso real é criado.' }`, sem chamar
     `PROVISIONERS`. Repita a trava dentro de cada `provision()`, como defesa em profundidade.
  2. Tornar o demo **explícito**: `isDemo = () => process.env.AQTA_DEMO === '1' && !process.env.MP_ACCESS_TOKEN`. Sem
     token e sem `AQTA_DEMO`, `/api/checkout` responde `503 payments_unavailable`. Em `VERCEL_ENV === 'production'`,
     nunca aceitar demo.

### REV-2 — ALTO (produto/negócio): a "assinatura mensal" é uma cobrança única
- **Onde:** `api/checkout.js:118-159` cria uma **preferência** do Checkout Pro, que é um pagamento avulso. Não há
  `preapproval` (Assinaturas do MP), renovação, cobrança do 2º mês nem expiração do acesso. Mesmo assim, a interface
  vende recorrência: "Assinatura" e "Concordo com a contratação da assinatura mensal" (`assets/js/checkout.js:170,199`),
  "Mensal · renovação a cada mês" (`assets/js/checkout-demo.js:138`) e "A assinatura é mensal…" (`index.html:576`).
- **Efeito:** o cliente paga R$ 200 uma vez e o acesso criado não expira, porque o Obtra e o Emptra não têm plano nem
  data de validade. Ou então ele espera uma renovação automática que nunca acontece.
- **Correção (decisão de negócio):** (a) usar **Mercado Pago Assinaturas** (`POST /preapproval` com
  `auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount, currency_id: 'BRL' }`), tratar os
  webhooks `subscription_preapproval` e `subscription_authorized_payment` e suspender o acesso quando um pagamento
  falhar; ou (b) assumir que é um pagamento mensal avulso, trocar os textos ("pagamento referente a 1 mês de uso") e
  criar a rotina de cobrança, aviso e suspensão. Em ambos os casos, a notificação à equipe deve levar a data de
  vencimento.

### REV-3 — ALTO: reembolso e chargeback não bloqueiam a ativação e ninguém fica sabendo
- **Onde:** `api/onboarding.js:269-299` confia no accessToken de 7 dias (`api/payment-status.js:13`) e **não
  reconsulta** o pagamento. `api/webhook.js:105` só reage a `approved`. `refunded`, `charged_back`, `in_mediation` e
  `partially_refunded` são ignorados.
- **Reproduzir:** pagamento aprovado ⇒ `/obrigado` emite o token ⇒ o cliente pede estorno (ou abre chargeback no
  cartão) ⇒ envia o formulário ⇒ conta criada. Depois do chargeback, o webhook responde 200 e não avisa ninguém, e o
  acesso fica ativo para sempre.
- **Prova:** `revisao.test.js` › REV-2 (refunded e charged_back ⇒ `onboarding` 200) e › REV-3 (webhook de
  chargeback sem aviso).
- **Correção:**
  - Em `handlePost`, antes de provisionar, chamar `resolvePayment(payload.paymentId)` (ou `getPayment`) e exigir
    `status === 'approved'` e `!(transaction_amount_refunded > 0)`. Se o MP estiver fora do ar, responder 503.
  - No webhook, para `refunded`, `charged_back`, `in_mediation` e `cancelled` depois de aprovado, chamar
    `notifyTeam({ event: 'payment.reversed', … , action: 'SUSPENDER ACESSO' })`.

### REV-4 — MÉDIO: o deploy na Vercel publica código, documentação e relatórios internos
- **Onde:** não existe `.vercelignore`, e o `vercel.json` não tem build nem `outputDirectory`. A Vercel publica como
  estático tudo o que fica na raiz: `/lib/token.js`, com o segredo do demo usado no REV-1, `/lib/provision/*.js`,
  `/server.js`, `/package.json`, `/.env.example`, `/docs/ARQUITETURA.md`, `/docs/REVISAO.md`, `/tests/**` e
  `/tests/RELATORIO-TESTES.md`, que é uma lista pública de defeitos. O bloqueio testado em `static.test.js:35-37` existe
  só no `server.js:23` local.
- **Prova:** `revisao.test.js` › REV-4.
- **Correção:** criar `.vercelignore` com `lib/`, `tests/`, `docs/`, `server.js`, `.env*` e `*.md`. As funções em
  `api/` continuam importando `../lib/*.js`, porque o empacotador (nft) inclui as dependências rastreadas mesmo quando
  estão no ignore do estático. Valide com `vercel build` e confira `.vercel/output/static`. Alternativa:
  `"outputDirectory": "public"`, movendo as páginas e os assets para lá.

### REV-5 — ALTO: sem webhook da equipe (ou com ele fora do ar), os dados de ativação e os leads se perdem
- **Onde:** `lib/notify.js:54-60`: sem `AQTA_NOTIFY_WEBHOOK`, o evento só vai para `console.log`. Com webhook, há um
  único POST com timeout de 5 s e **sem nova tentativa**. `api/onboarding.js:238-258` ignora o retorno, e
  `api/lead.js:83-93` também.
- **Efeito:** na configuração padrão, sem credenciais de provisionamento, **toda venda cai no modo manual**. A
  **única** cópia do formulário de ativação (e-mail de login, empresa, cidade, perfil) é essa notificação. Se ela
  falhar, o cliente lê "Recebemos tudo… será liberado em até 1 dia útil" e ninguém na Aqta recebe nada. O
  pagamento aparece no painel do MP, mas os dados da ativação não. Com o lead acontece o mesmo: "Pedido enviado!" e
  nada chega.
- **Correção:**
  1. Em produção (`!isDemo()`), exigir `AQTA_NOTIFY_WEBHOOK`. Sem ele, `/api/onboarding` e `/api/lead` respondem `503`.
  2. Fazer 2 ou 3 tentativas com backoff.
  3. Devolver `notified:false` e, nesse caso, a página mostra "conclua pelo WhatsApp" com os dados prontos na mensagem.
  4. O ideal é gravar um registro durável (Vercel KV, Upstash ou a própria tabela do produto), o que também resolve o
     BUG-2.

### REV-6 — MÉDIO: o link de retorno é uma credencial permanente
- **Onde:** `api/payment-status.js:169-183` assina um accessToken **novo** a cada consulta aprovada. Com isso, o TTL de
  7 dias não vale nada: quem tiver a URL `/obrigado?payment_id=…&external_reference=…` (histórico do navegador, print,
  encaminhamento) ativa a conta a qualquer momento e, junto com o BUG-2, pode criar outras.
- **Correção:** a mesma do BUG-2. Um registro persistente por `paymentId` faz `payment-status` devolver
  `onboarded:true` e o link de `/acesso` em vez de um token de ativação.

### REV-7 — BAIXO: contrato com a API real do Emptra (mock permissivo)
- **E-mail:** a ativação aceita `joao.@empresa.com.br`, `compras{obra}@…`, `a!b@…` e `ana#1@…`
  (`api/onboarding.js:35-40`). O Zod 3.23 do Emptra rejeita todos (`companies.routes.ts:42`, `admin.routes.ts:85`)
  com 422, e o cliente cai no modo manual sem explicação. Prova: `revisao.test.js` › REV-5. Correção: usar no front
  e no back a mesma regra do Zod (local termina em `[A-Z0-9_+-]` e só aceita `[A-Z0-9_'+-.]`) e fazer o mock validar
  com ela.
- **E-mail duplicado:** a API real responde `409 "Já existe um registro com este email"` (P2002) e
  `lib/provision/emptra.js:81` mapeia para `conflict`. Só a consulta prévia (`GET /admin/users?q=`) evita a mensagem
  errada. Correção: `res.status === 409 && /email/i.test(msg) ? 'email_exists' : …`.
- **CNPJ já cadastrado** (`schema.prisma:105`, único): um cliente que já tem empresa no Emptra cai no modo manual com
  a nota genérica. Vale tratar como `company_exists` e vincular o usuário à empresa existente.
- **Fornecedor sem categorias:** `obrigado.js:622-624` não coleta categorias e `emptra.js:122` envia `[]`. O
  fornecedor criado não aparece nas buscas por categoria (`companies.routes.ts:97`). Correção: coletar as categorias
  (o catálogo está em `GET /catalog/categories`) ou avisar no passo a passo do `/acesso`.

### REV-8 — BAIXO: Obtra grava CPF no campo `cnpj`
- `lib/provision/obtra.js:131` grava o CPF formatado em `empresas.cnpj`, enquanto o Emptra evita isso
  (`emptra.js:128`). O contrato com o Supabase está correto: a RPC `admin_criar_usuario` só pula a checagem de
  master/admin quando `auth.uid()` é nulo, que é o caso da service_role (`instalar.sql:1657-1662`). O `EXECUTE` é
  concedido à service_role (`instalar.sql:2200-2210`), assim como `ALL` nas tabelas (`:2184`), e
  `empresas_proteger` deixa passar quando não há uid (`:720`). A senha temporária, de 14 caracteres, atende o mínimo
  de 6 do Obtra e de 8 do Emptra.

### REV-9 — BAIXO/MÉDIO: com `MP_WEBHOOK_SECRET` configurado, notificações IPN levam 401
- **Onde:** `api/webhook.js:80-84`. O `notification_url` da preferência também recebe notificações no formato IPN
  (`?topic=payment&id=…` e `?topic=merchant_order&id=…`), que **não** trazem `x-signature`. Elas recebem 401 e o MP
  continua tentando de novo, o que suja os logs e o painel de notificações.
- **Prova:** `revisao.test.js` › REV-6.
- **Correção:** quando não houver `x-signature` e vier `topic=`, processar mesmo assim. É seguro porque o código
  sempre reconsulta `GET /v1/payments/{id}` com o token. Outra opção é responder `200 { ignored: 'unsigned_ipn' }`.
  Confirme no sandbox quais formatos chegam.

### REV-10 — BAIXO: diferenças entre o servidor local e a Vercel
- **JSON inválido:** na Vercel, ler `req.body` com JSON inválido lança `ApiError(400, 'Invalid JSON')`, e o runtime
  responde em **texto**, não em JSON. `lib/http.js:18-25` não protege a leitura. Os testes passam porque o
  `server.js:30-31` local devolve a string crua. O front já trata isso, então o efeito é pequeno. Mesmo assim, envolva
  o acesso em `try { b = req.body } catch { return {} }`.
- **CSRF / text/plain:** `lib/http.js:21-23` também faz parse de corpo string. Um site de terceiros consegue mandar
  `fetch(…, { mode: 'no-cors', body: '{"name":…}' })` como `text/plain` sem preflight, o que permite spam no
  `/api/lead`. Correção: exigir `Content-Type: application/json` nos POST.
- **Host:** sem `PUBLIC_BASE_URL`, `back_urls` e `notification_url` saem do cabeçalho `Host` (`lib/http.js:27-31`).
  Na Vercel o risco é pequeno, mas torne a variável obrigatória em produção.
- **Duração:** o provisionamento do Emptra faz até 5 chamadas em sequência com timeout de 10 s cada, mais bcrypt, e o
  `vercel.json` não define `functions.maxDuration`. Se a função for morta no meio, fica uma empresa órfã, sem
  rollback e sem notificação. Defina `maxDuration` e um orçamento total de tempo.
- **Login do admin no Emptra:** cada ativação faz um login novo, e o Emptra limita a 20 logins por 15 minutos por IP
  (`backend/src/app.ts`, `authLimiter`). Num pico de vendas, as ativações seguintes caem no modo manual.

### REV-11 — BAIXO: canais de contato e textos
- A landing não tem **nenhum** link de WhatsApp ou contato direto. Mesmo assim, o FAQ (`index.html:576`) e os erros do
  modal (`checkout.js:298,378`, "Fale com a Aqta pelo WhatsApp") mandam o cliente falar pelo WhatsApp.
- No 429 do lead, `landing.js:240-242` ignora o `whatsappUrl` que o servidor devolve.
- O título do item no MP é "Obtra — Plano Básico (1 mês)" (`checkout.js:124`). Ele está coerente com o REV-2(b), mas
  não com "assinatura".

### REV-12 — BAIXO: cabeçalhos e privacidade
- `vercel.json` não define `Content-Security-Policy` (o site só precisa de `self` + Google Fonts) nem
  `Permissions-Policy`. HSTS: a Vercel envia o cabeçalho nos domínios dela, mas confira no domínio próprio.
- O CPF/CNPJ fica em `sessionStorage` (`checkout.js:106-109`). É aceitável, mas precisa constar na política de
  privacidade (BUG-9).

### Verificado e sem problema
- **XSS:** todo HTML dinâmico passa por `esc()` (`obrigado.js`, `acesso.js`). `loginUrl` passa por `safeUrl`
  (só `http(s)`). O `whatsappUrl` é validado por regex (`landing.js:221`). O `redirect` do demo exige `/obrigado?`
  (`checkout-demo.js:107`). Não encontrei open redirect em `init_point`, que vem do próprio servidor.
- **Preço:** sempre vem do catálogo (`checkout.js:175`, testado). Pagamentos com valor menor ou outra moeda são
  recusados (`payment-status.js:109-112`).
- **Tokens:** HMAC com `timingSafeEqual`. Não dá para trocar o tipo do token (`t`). O documento nunca vai no token.
  `/acesso` e `/obrigado` usam `noindex` e `no-referrer`.
- **Preferência do MP:** os campos e formatos batem com a API de Checkout Pro (`items[].unit_price` em reais,
  `currency_id`, `payer.identification.type` CPF/CNPJ, `back_urls` com `auto_return: 'approved'`, `notification_url`,
  `external_reference`, `expires`, `metadata`, `X-Idempotency-Key`).
- **Compatibilidade:** `Object.hasOwn`, `AbortSignal.timeout` e `fetch` existem no Node 20. As funções em `api/`
  importam `../lib` de forma estática ou dinâmica com string literal, então o nft inclui esses arquivos. `cleanUrls`
  combina com as `back_urls` (`/obrigado`).

---

## (d) O que corrigir antes de ir ao ar (em ordem de prioridade)

1. **REV-1:** desligar o provisionamento no modo demo e tornar o demo explícito (`AQTA_DEMO=1`). Sem isso, qualquer
   configuração incompleta dá conta grátis.
2. **BUG-2 + REV-6:** idempotência persistente por `paymentId` (KV, ou um campo de referência no produto com
   consulta antes de criar). `payment-status` deve devolver `onboarded` em vez de um novo token.
3. **REV-3:** reconsultar o MP antes de ativar e avisar a equipe sobre reembolso, chargeback ou mediação.
4. **REV-5:** exigir `AQTA_NOTIFY_WEBHOOK` em produção, com novas tentativas e fallback visível para o cliente
   (WhatsApp com os dados prontos).
5. **REV-2:** decidir entre Assinaturas do MP e pagamento mensal avulso, e alinhar textos e processo.
6. **BUG-5 + REV-11:** número real de WhatsApp vindo da configuração em `/obrigado`, `/acesso` e na landing.
7. **REV-4:** criar `.vercelignore` (e conferir com `vercel build`).
8. **BUG-9:** páginas de termos e de privacidade, além de razão social, CNPJ e contato no rodapé.
9. **BUG-4, BUG-8 ("mesmo dia"), REV-9, REV-7 (e-mail e mensagem de duplicado do Emptra).**
10. **Baixos:** BUG-6, BUG-10, BUG-1 (Node 20), BUG-3, BUG-7, REV-8, REV-10, REV-12. Na suíte: S1-S10 (em especial
    trocar `static.test.js` por uma checagem do `.vercelignore`, deixar os mocks do Emptra rígidos e fazer o e2e
    falhar no CI quando não houver Chromium).
