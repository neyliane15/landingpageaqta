# Aqta — Landing page de vendas (Obtra + Emptra)

Landing page da **Aqta Desenvolvimento de Software** para vender o **Obtra** (Diário de Obra, R$ 200/mês) e o
**Emptra** (cotação de materiais via WhatsApp, R$ 300/mês). Sistemas personalizados: implantação sob consulta.

Fluxo completo: landing → modal de compra → **Mercado Pago Checkout Pro** (PIX, cartão, boleto) → `/obrigado`
(confirmação do pagamento + formulário de ativação) → criação da conta no Obtra/Emptra → `/acesso`
(login, senha temporária e botão **Entrar no Obtra / Entrar no Emptra**).

- Site estático em `public/` (HTML/CSS/JS puro) + funções serverless em `api/` (Vercel). Zero dependências npm.
- Sem `MP_ACCESS_TOKEN` o site roda em **modo demonstração**: checkout simulado, nada é cobrado e nenhuma conta é criada.
- Arquitetura e contratos: [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) · Testes: [`tests/RELATORIO-TESTES.md`](tests/RELATORIO-TESTES.md) · Revisão: [`docs/REVISAO.md`](docs/REVISAO.md)

## Rodar localmente

```bash
node server.js            # http://localhost:3000 (modo demo)
npm test                  # testes de API
npm run test:e2e          # testes no navegador (Playwright/Chromium)
```

Requer Node 22+.

## Colocar no ar (Vercel)

1. **Vercel → Add New → Project →** importe este repositório (framework: *Other*, sem build command).
   O `vercel.json` já define `outputDirectory: public`, URLs limpas e cabeçalhos de segurança.
2. **Storage → Upstash Redis (KV)** → conecte ao projeto (cria `KV_REST_API_URL` e `KV_REST_API_TOKEN`).
   Sem ele, toda ativação vira manual (é o que garante "1 pagamento = 1 conta").
3. **Settings → Environment Variables** (modelo completo em [`.env.example`](.env.example)):
   - `PUBLIC_BASE_URL` — domínio final com **https** (ex.: `https://aqta.com.br`)
   - `MP_ACCESS_TOKEN` — credencial de produção do Mercado Pago
   - `MP_WEBHOOK_SECRET` — segredo do webhook (painel do MP → Webhooks, URL `https://SEU-DOMINIO/api/webhook`, evento *Pagamentos*)
   - `AQTA_TOKEN_SECRET` — gere com `openssl rand -hex 32`
   - `AQTA_WHATSAPP` — WhatsApp da Aqta com DDI (ex.: `5521987654321`)
   - `AQTA_NOTIFY_WEBHOOK` — webhook (n8n, Make, Zapier, Slack…) que recebe vendas, ativações, leads e estornos
   - Opcional, para criar as contas automaticamente:
     `OBTRA_SUPABASE_URL` + `OBTRA_SUPABASE_SERVICE_KEY`, e
     `EMPTRA_API_URL` + `EMPTRA_ADMIN_EMAIL` + `EMPTRA_ADMIN_PASSWORD` (de preferência um admin exclusivo da landing).
4. Faça um pagamento real de teste (ex.: PIX) e confira o fluxo até o botão "Entrar no …".

## Pendências que dependem da Aqta

- Preencher razão social, CNPJ, endereço e e-mail em `public/termos.html` e `public/privacidade.html`
  (blocos ocultos marcados com `<!-- PREENCHER -->`) e validar os textos com o jurídico.
- Com o domínio definido, trocar `canonical`/`og:image` de `public/index.html` por URLs absolutas.
- A cobrança é **pré-paga mês a mês** (Checkout Pro não renova sozinho); a equipe contata o cliente perto do vencimento.
  Para débito automático no cartão, a evolução é usar Assinaturas (Preapproval) do Mercado Pago.
