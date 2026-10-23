// Página /acesso — dados de acesso ao produto contratado e primeiros passos.
// Lê ?token= (ou sessionStorage), revalida em GET /api/onboarding e mostra o resultado.
// A senha temporária NUNCA vem do servidor aqui: só existe em sessionStorage['aqta.tempPassword'],
// gravada pela página /obrigado logo após o onboarding.

import { loadSupport, applySupportLinks, waAttrs } from './support.js';

const $view = document.getElementById('ac-view');
const TOKEN_KEYS = ['aqta.access', 'aqta.accessToken'];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function storage(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch { /* modo privado / bloqueado */ }
  return null;
}

const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '#');

function readToken() {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    storage('aqta.access', fromUrl);
    return fromUrl;
  }
  for (const k of TOKEN_KEYS) {
    const t = storage(k);
    if (t) return t;
  }
  return '';
}

function readTempPassword() {
  const raw = storage('aqta.tempPassword');
  if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') return String(j.tempPassword || j.password || '');
  } catch { /* string simples */ }
  return raw;
}

function render(html, { focus = true } = {}) {
  $view.innerHTML = html;
  applySupportLinks($view);
  if (focus) {
    const t = $view.querySelector('.ac-title');
    if (t) { t.setAttribute('tabindex', '-1'); t.focus({ preventScroll: false }); }
  }
}

// ---------------------------------------------------------------- primeiros passos (funcionalidades reais)

const STEPS = {
  obtra: () => [
    ['Entre e troque a senha', 'Acesse com o e-mail e a senha temporária. No menu do seu usuário, use <em>Trocar senha</em> e defina uma senha só sua.'],
    ['Configure a empresa', 'Em <em>Configurações</em>, confira os dados da empresa e envie a logo — ela aparece nos relatórios e no portal do cliente.'],
    ['Monte os cadastros', 'Em <em>Mão de Obra</em>, <em>Funções</em>, <em>Materiais</em> e <em>Equipamentos</em>, cadastre o que se repete no dia a dia — o diário fica muito mais rápido.'],
    ['Cadastre a primeira obra', 'Em <em>Obras</em>, crie a obra com endereço, prazo e foto de capa.'],
    ['Preencha o primeiro RDO', 'Em <em>Relatórios (RDO)</em>, registre clima, mão de obra, equipamentos, atividades, ocorrências e fotos do dia. Depois exporte em PDF em <em>Relatórios &amp; Exportação</em>.'],
    ['Convide a equipe e o cliente', 'Em <em>Usuários &amp; Clientes</em>, crie acessos para colaboradores e libere o portal para o cliente acompanhar a obra.'],
  ],
  comprador: () => [
    ['Entre e troque a senha', 'Acesse com o e-mail e a senha temporária. Em <em>Perfil</em>, altere a senha (mínimo de 8 caracteres).'],
    ['Crie a primeira cotação', 'Em <em>Minhas cotações → Nova cotação</em>, informe título, prazo, cidade de entrega e o que priorizar (preço, entrega ou pagamento).'],
    ['Monte a lista pelo catálogo', 'Comece a digitar o material e escolha do catálogo — a unidade vem preenchida. Anexe fotos da obra ou a planta em PDF.'],
    ['Envie no WhatsApp', 'Marque os fornecedores que atendem a sua região e clique em <em>Criar e enviar no WhatsApp</em>. As respostas chegam sozinhas.'],
    ['Compare e aprove', 'O mapa comparativo destaca o melhor preço por item. Aprove com fornecedor único ou compra dividida; todos são avisados na hora.'],
    ['Acompanhe os preços', 'Em <em>Histórico de preços</em>, veja a evolução de cada material e a economia de cada compra.'],
  ],
  fornecedor: () => [
    ['Entre e troque a senha', 'Acesse com o e-mail e a senha temporária. Em <em>Perfil</em>, altere a senha (mínimo de 8 caracteres).'],
    ['Confira o seu WhatsApp', 'É por esse número que as cotações chegam e que o robô reconhece você. Confira em <em>Perfil</em>.'],
    ['Responda pelo WhatsApp', 'Ao receber a lista numerada, responda com o número do item e o preço, por exemplo <code>1 45,90</code>, <code>PRAZO 7</code> e, para fechar, <code>ENVIAR</code>.'],
    ['Ou responda pelo painel', 'Em <em>Cotações recebidas</em>, preencha preços, descontos e prazo direto no navegador.'],
    ['Baixe os pedidos ganhos', 'Em <em>Pedidos ganhos</em>, baixe a planilha XLSX com itens, valores, prazo e contato do comprador.'],
    ['Acompanhe o faturamento', 'Em <em>Faturamento</em>, veja o total vendido pela plataforma.'],
  ],
};

const ICONS = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 7v6M12 16.5v.5"/><circle cx="12" cy="12" r="8.5"/></svg>',
};

function head(kind, badge, title) {
  return `
    <div class="ac-head">
      <span class="page-shell__icon page-shell__icon--${kind}">${ICONS[kind]}</span>
      <span class="badge badge--${kind}">${esc(badge)}</span>
    </div>
    <h1 class="page-shell__title ac-title">${title}</h1>`;
}

function stepsHTML(d, { demo = false } = {}) {
  const list = d.product === 'obtra' ? STEPS.obtra() : STEPS[d.profile === 'fornecedor' ? 'fornecedor' : 'comprador']();
  const who = d.product === 'emptra' ? ` · ${d.profile === 'fornecedor' ? 'Fornecedor' : 'Comprador'}` : '';
  return `
    <section class="frame page-shell__card" aria-labelledby="ac-steps-title">
      <p class="eyebrow">Primeiros passos${esc(who)}</p>
      <h2 class="ac-h2" id="ac-steps-title">${demo ? `Como é o primeiro uso do ${esc(d.productName)} (após a contratação real)` : `Comece a usar o ${esc(d.productName)}`}</h2>
      <ol class="steps">
        ${list.map(([t, txt]) => `<li><strong>${esc(t)}</strong>${txt}</li>`).join('')}
      </ol>
    </section>`;
}

const setProgressWait = () => document.getElementById('ac-step-3')?.setAttribute('data-s', 'wait');

// ---------------------------------------------------------------- estados

function viewInvalid(kind) {
  const expired = kind === 'expired';
  setProgressWait();
  render(`
    <section class="frame page-shell__card">
      ${head('err', expired ? 'Link expirado' : 'Link inválido', expired ? 'Este link de acesso expirou' : 'Não encontramos o seu acesso')}
      <p class="page-shell__lead">${expired
        ? 'Por segurança, o link de acesso tem validade. Seu pagamento e seu acesso continuam garantidos — fale com a gente que reenviamos os dados.'
        : 'O link pode estar incompleto. Abra o link exatamente como recebeu ou fale com o suporte — seu pagamento está garantido.'}</p>
      <div class="page-shell__actions">
        <a class="btn btn--primary" ${waAttrs('Olá! Preciso de ajuda com o link de acesso ao meu sistema Aqta.')}>Falar com o suporte</a>
        <a class="btn btn--ghost" href="/">Voltar ao site</a>
      </div>
    </section>`);
}

function viewRevoked(d) {
  setProgressWait();
  render(`
    <section class="frame page-shell__card">
      ${head('err', 'Pagamento estornado', 'Este acesso não está mais ativo')}
      <p class="page-shell__lead">${esc(d.message || 'O pagamento deste acesso foi reembolsado, estornado ou contestado junto ao Mercado Pago, por isso o acesso foi desativado.')}
        Se acha que é um engano, fale com o suporte; para voltar a usar, faça uma nova contratação.</p>
      <div class="page-shell__actions">
        <a class="btn btn--primary" href="/#planos">Ver planos</a>
        <a class="btn btn--ghost" ${waAttrs('Olá! Meu acesso a um sistema Aqta aparece como estornado. Podem verificar?')}>Falar com o suporte</a>
      </div>
    </section>`);
}

function viewNetworkError(token) {
  render(`
    <section class="frame page-shell__card">
      ${head('warn', 'Sem conexão', 'Não conseguimos carregar seus dados')}
      <p class="page-shell__lead">Verifique sua internet e tente novamente.</p>
      <div class="page-shell__actions">
        <button class="btn btn--primary" type="button" id="ac-retry">Tentar novamente</button>
        <a class="btn btn--ghost" ${waAttrs('Olá! Não consigo abrir a página de acesso do meu sistema Aqta.')}>Falar com o suporte</a>
      </div>
    </section>`);
  document.getElementById('ac-retry').addEventListener('click', () => load(token));
}

function viewPending(d) {
  setProgressWait();
  const support = `Olá! Paguei o ${d.productName} e preciso concluir a ativação.`;
  render(`
    <section class="frame page-shell__card">
      ${head('warn', 'Ativação pendente', `Falta concluir a ativação do ${esc(d.productName)}`)}
      <p class="page-shell__lead">Seu pagamento foi aprovado, mas ainda precisamos dos dados da empresa para criar o acesso. Volte à página do pagamento para concluir, ou fale com a gente.</p>
      <div class="page-shell__actions">
        <a class="btn btn--primary" ${waAttrs(support)}>Falar com o suporte</a>
        <a class="btn btn--ghost" href="/">Voltar ao site</a>
      </div>
    </section>`);
}

const row = (dt, dd) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`;

function viewReady(d) {
  const manual = d.mode === 'manual';
  const pwd = manual ? '' : readTempPassword();
  const support = manual
    ? `Olá! Contratei o ${d.productName}${d.company ? ` para a empresa ${d.company}` : ''} e aguardo a liberação do acesso.`
    : `Olá! Preciso de ajuda com o meu acesso ao ${d.productName}.`;
  const enter = `Entrar no ${esc(d.productName)}`;
  const forgot = d.product === 'obtra'
    ? 'Se não anotou a senha, use <em>Esqueci minha senha</em> na tela de login do Obtra com o e-mail acima.'
    : `Se não anotou a senha, <a ${waAttrs(support)}>fale com o suporte</a> que geramos uma nova.`;
  const changeWhere = d.product === 'obtra' ? 'no menu do seu usuário, em <em>Trocar senha</em>' : 'em <em>Perfil</em>, no Emptra';
  const help = document.getElementById('ac-help');
  if (help) { help.dataset.waText = support; applySupportLinks(help.parentElement); }
  if (manual) setProgressWait();

  const passwordRow = manual ? '' : pwd
    ? row('<label for="ac-pwd">Senha temporária</label>', `
        <div class="input-group">
          <input id="ac-pwd" type="password" readonly value="${esc(pwd)}" autocomplete="off" spellcheck="false">
          <button class="btn btn--ghost btn--sm" type="button" id="ac-show" aria-pressed="false" aria-controls="ac-pwd">Mostrar</button>
          <button class="btn btn--ghost btn--sm" type="button" data-copy="pwd">Copiar</button>
        </div>`)
    : row('Senha temporária', `<span class="ac-note">Exibida só no momento da ativação, neste navegador. ${forgot}</span>`);

  render(`
    <section class="frame frame--glow page-shell__card">
      ${head(manual ? 'warn' : 'ok', manual ? 'Liberação em andamento' : 'Acesso liberado', manual
        ? `Recebemos tudo. Seu ${esc(d.productName)} será liberado ${esc(d.manualDeadline || 'em até 1 dia útil')}`
        : `Seu acesso ao ${esc(d.productName)} está pronto`)}
      <p class="page-shell__lead">${manual
        ? `A equipe Aqta está criando o ambiente da <strong>${esc(d.company)}</strong> e entra em contato pelo WhatsApp ou pelo e-mail <strong>${esc(d.loginEmail)}</strong> assim que estiver tudo pronto. Se preferir, chame a gente agora.`
        : 'Use os dados abaixo para entrar. Guarde a senha temporária em local seguro — ela aparece só nesta sessão do navegador.'}</p>

      <dl class="summary ac-summary">
        ${row('Produto', `${esc(d.productName)} · Plano Básico`)}
        ${row('Empresa', esc(d.company || '—'))}
        ${d.product === 'emptra' && d.profile ? row('Perfil', d.profile === 'fornecedor' ? 'Fornecedor' : 'Comprador') : ''}
        ${row('E-mail de login', `<span class="mono">${esc(d.loginEmail)}</span> <button class="btn btn--ghost btn--sm" type="button" data-copy="email">Copiar</button>`)}
        ${passwordRow}
        ${manual ? row('Prazo de liberação', esc(d.manualDeadline || 'até 1 dia útil')) : ''}
      </dl>

      ${!manual && pwd ? `<div class="alert alert--warn" role="note"><div><strong>Troque a senha no primeiro acesso.</strong> Por segurança, defina uma senha só sua ${changeWhere}.</div></div>` : ''}

      <div class="page-shell__actions">
        ${manual
          ? `<a class="btn btn--primary" ${waAttrs(support)}>Falar com a Aqta</a>
             <a class="btn btn--ghost" href="${esc(safeUrl(d.loginUrl))}">${enter}</a>`
          : `<a class="btn btn--primary" href="${esc(safeUrl(d.loginUrl))}">${enter}</a>
             <a class="btn btn--ghost" ${waAttrs(support)}>Precisa de ajuda?</a>`}
      </div>
      ${manual ? `<p class="ac-note">O botão “${enter}” funciona assim que o acesso for liberado.</p>` : ''}
    </section>
    ${stepsHTML(d)}`);

  wireCopy(d, pwd);
}

// Demonstração (modo demo do servidor): o fluxo foi simulado e NENHUMA conta foi criada no produto.
function viewDemo(d) {
  const name = esc(d.productName || 'sistema');
  const notes = d.notes || d.note || '';
  render(`
    <section class="frame frame--glow page-shell__card" data-mode="demo">
      <div class="ac-head">
        <span class="page-shell__icon page-shell__icon--warn">${ICONS.warn}</span>
        <span class="badge badge--warn">Demonstração</span>
      </div>
      <h1 class="page-shell__title ac-title">Demonstração concluída — nenhuma conta foi criada</h1>
      <p class="page-shell__lead">Este ambiente está em <strong>modo demonstração</strong>: o pagamento foi simulado, nenhum valor
        foi cobrado e <strong>nenhum acesso real ao ${name} foi criado</strong>. Os dados que você preencheu não foram usados para
        criar empresa nem usuário.</p>
      ${notes ? `<div class="alert alert--warn" role="note"><div>${esc(notes)}</div></div>` : ''}
      <dl class="summary ac-summary">
        ${row('Produto', `${name} · Plano Básico`)}
        ${d.company ? row('Empresa (informada)', esc(d.company)) : ''}
        ${d.loginEmail ? row('E-mail informado', `<span class="mono">${esc(d.loginEmail)}</span>`) : ''}
        ${row('Situação', 'Simulação — sem conta criada')}
      </dl>
      <div class="page-shell__actions">
        ${safeUrl(d.loginUrl) !== '#' ? `<a class="btn btn--primary" href="${esc(safeUrl(d.loginUrl))}">Ver a tela de login do ${name}</a>` : ''}
        <a class="btn btn--ghost" href="/#planos">Ver planos</a>
      </div>
      <p class="ac-note">Para contratar de verdade, assine pelo site em produção — a ativação é imediata após o pagamento aprovado
        (ou em até 1 dia útil quando a liberação for manual).</p>
    </section>
    ${stepsHTML(d, { demo: true })}`);
}

// ---------------------------------------------------------------- copiar / mostrar

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

function wireCopy(d, pwd) {
  const live = document.getElementById('ac-live');
  for (const btn of $view.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const what = btn.dataset.copy;
      const ok = await copyText(what === 'pwd' ? pwd : d.loginEmail);
      const label = btn.textContent;
      btn.textContent = ok ? 'Copiado' : 'Não copiou';
      if (live) live.textContent = ok ? `${what === 'pwd' ? 'Senha' : 'E-mail'} copiado.` : 'Não foi possível copiar. Selecione e copie manualmente.';
      setTimeout(() => { btn.textContent = label; }, 1800);
    });
  }
  const show = document.getElementById('ac-show');
  const input = document.getElementById('ac-pwd');
  if (show && input) {
    show.addEventListener('click', () => {
      const visible = show.getAttribute('aria-pressed') === 'true';
      show.setAttribute('aria-pressed', String(!visible));
      show.textContent = visible ? 'Mostrar' : 'Ocultar';
      input.type = visible ? 'password' : 'text';
    });
  }
}

// ---------------------------------------------------------------- carga

async function load(token) {
  render(`
    <section class="frame page-shell__card">
      <div class="ac-center">
        <span class="spinner spinner--lg" role="status"><span class="sr-only">Carregando</span></span>
        <p class="page-shell__lead">Carregando seus dados de acesso…</p>
      </div>
    </section>`, { focus: false });

  let res;
  let data = {};
  try {
    res = await fetch(`/api/onboarding?token=${encodeURIComponent(token)}`, { headers: { Accept: 'application/json' } });
    data = await res.json().catch(() => ({}));
  } catch {
    return viewNetworkError(token);
  }
  if (res.status === 401) {
    storage('aqta.access', null);
    return viewInvalid(data.error === 'expired_token' ? 'expired' : 'invalid');
  }
  if (res.status === 402 || data.error === 'payment_not_active') {
    storage('aqta.access', null);
    storage('aqta.tempPassword', null);
    return viewRevoked(data);
  }
  if (!res.ok || !data.ok) return viewNetworkError(token);

  document.title = `Acesso ao ${data.productName} — Aqta`;
  if ((data.mode === 'demo' || data.demo === true) && data.onboarded !== false) return viewDemo(data);
  if (!data.onboarded) return viewPending(data);
  return viewReady(data);
}

// Canal de suporte vem do servidor (/api/catalog → support); até lá os links apontam para o contato do site.
loadSupport().then(() => applySupportLinks(document));

const token = readToken();
if (!token) viewInvalid('invalid');
else load(token);
