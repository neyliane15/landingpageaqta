// Página /acesso — dados de acesso ao produto contratado e primeiros passos.
// Lê ?token= (ou sessionStorage), revalida em GET /api/onboarding e mostra o resultado.
// A senha temporária NUNCA vem do servidor aqui: só existe em sessionStorage['aqta.tempPassword'],
// gravada pela página /obrigado logo após o onboarding.

const $view = document.getElementById('ac-view');
const SUPPORT_WA = (document.body.dataset.supportWhatsapp || '').replace(/\D/g, '');
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

function waLink(text) {
  const base = SUPPORT_WA ? `https://wa.me/${SUPPORT_WA}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(text)}`;
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

function stepsHTML(d) {
  const list = d.product === 'obtra' ? STEPS.obtra() : STEPS[d.profile === 'fornecedor' ? 'fornecedor' : 'comprador']();
  const who = d.product === 'emptra' ? ` <span class="badge">${d.profile === 'fornecedor' ? 'Fornecedor' : 'Comprador'}</span>` : '';
  return `
    <section class="frame ac-card" aria-labelledby="ac-steps-title">
      <p class="eyebrow">Primeiros passos</p>
      <h2 class="ac-h2" id="ac-steps-title">Comece a usar o ${esc(d.productName)}${who}</h2>
      <ol class="ac-steps-list">
        ${list.map(([t, txt]) => `<li><strong>${esc(t)}</strong>${txt}</li>`).join('')}
      </ol>
    </section>`;
}

// ---------------------------------------------------------------- estados

function viewInvalid(kind) {
  const expired = kind === 'expired';
  document.getElementById('ac-step-3')?.setAttribute('data-s', 'wait');
  render(`
    <section class="frame ac-card">
      <span class="badge badge--err">${expired ? 'Link expirado' : 'Link inválido'}</span>
      <h1 class="ac-title">${expired ? 'Este link de acesso expirou' : 'Não encontramos o seu acesso'}</h1>
      <p class="ac-lead">${expired
        ? 'Por segurança, o link de acesso tem validade. Seu pagamento e seu acesso continuam garantidos — fale com a gente que reenviamos os dados.'
        : 'O link pode estar incompleto. Abra o link exatamente como recebeu ou fale com o suporte — seu pagamento está garantido.'}</p>
      <div class="ac-actions">
        <a class="btn btn--primary" href="${esc(waLink('Olá! Preciso de ajuda com o link de acesso ao meu sistema Aqta.'))}" target="_blank" rel="noopener">Falar com o suporte no WhatsApp</a>
        <a class="btn btn--ghost" href="/">Voltar ao site</a>
      </div>
    </section>`);
}

function viewNetworkError(token) {
  render(`
    <section class="frame ac-card">
      <span class="badge badge--warn">Sem conexão</span>
      <h1 class="ac-title">Não conseguimos carregar seus dados</h1>
      <p class="ac-lead">Verifique sua internet e tente novamente.</p>
      <div class="ac-actions">
        <button class="btn btn--primary" type="button" id="ac-retry">Tentar novamente</button>
        <a class="btn btn--ghost" href="${esc(waLink('Olá! Não consigo abrir a página de acesso do meu sistema Aqta.'))}" target="_blank" rel="noopener">Falar com o suporte</a>
      </div>
    </section>`);
  document.getElementById('ac-retry').addEventListener('click', () => load(token));
}

function viewPending(d) {
  document.getElementById('ac-step-3')?.setAttribute('data-s', 'wait');
  render(`
    <section class="frame ac-card">
      <span class="badge badge--warn">Ativação pendente</span>
      <h1 class="ac-title">Falta concluir a ativação do ${esc(d.productName)}</h1>
      <p class="ac-lead">Seu pagamento foi aprovado, mas ainda precisamos dos dados da empresa para criar o acesso. Volte à página do pagamento para concluir, ou fale com a gente.</p>
      <div class="ac-actions">
        <a class="btn btn--primary" href="${esc(safeUrl(d.supportWhatsappUrl) !== '#' ? d.supportWhatsappUrl : waLink(`Olá! Paguei o ${d.productName} e preciso concluir a ativação.`))}" target="_blank" rel="noopener">Falar com o suporte no WhatsApp</a>
        <a class="btn btn--ghost" href="/">Voltar ao site</a>
      </div>
    </section>`);
}

function viewReady(d) {
  const manual = d.mode === 'manual';
  const pwd = manual ? '' : readTempPassword();
  const support = safeUrl(d.supportWhatsappUrl) !== '#'
    ? d.supportWhatsappUrl
    : waLink(manual
      ? `Olá! Contratei o ${d.productName}${d.company ? ` para a empresa ${d.company}` : ''} e aguardo a liberação do acesso.`
      : `Olá! Preciso de ajuda com o meu acesso ao ${d.productName}.`);
  const enter = `Entrar no ${esc(d.productName)}`;
  const forgot = d.product === 'obtra'
    ? `Se não anotou a senha, use <em>Esqueci minha senha</em> na tela de login do Obtra com o e-mail acima.`
    : `Se não anotou a senha, <a href="${esc(support)}" target="_blank" rel="noopener">fale com o suporte</a> que geramos uma nova.`;
  const changeWhere = d.product === 'obtra' ? 'no menu do seu usuário, em <em>Trocar senha</em>' : 'em <em>Perfil</em>';

  if (manual) document.getElementById('ac-step-3')?.setAttribute('data-s', 'wait');

  const passwordRow = manual ? '' : pwd
    ? `<dt>Senha temporária</dt>
       <dd>
         <div class="ac-secret">
           <output class="ac-mono" id="ac-pwd" aria-label="Senha temporária (oculta)">••••••••••••</output>
           <span class="ac-inline">
             <button class="btn btn--ghost btn--sm" type="button" id="ac-show" aria-pressed="false" aria-controls="ac-pwd">Mostrar</button>
             <button class="btn btn--ghost btn--sm" type="button" data-copy="pwd">Copiar</button>
           </span>
         </div>
       </dd>`
    : `<dt>Senha temporária</dt><dd><span class="ac-note" style="margin:0">Exibida apenas no momento da ativação, neste navegador. ${forgot}</span></dd>`;

  render(`
    <section class="frame frame--glow ac-card">
      <span class="badge ${manual ? 'badge--warn' : 'badge--ok'}">${manual ? 'Liberação em andamento' : 'Acesso liberado'}</span>
      <h1 class="ac-title">${manual
        ? `Recebemos tudo. Seu ${esc(d.productName)} será liberado ${esc(d.manualDeadline || 'em até 1 dia útil')}`
        : `Seu acesso ao ${esc(d.productName)} está pronto`}</h1>
      <p class="ac-lead">${manual
        ? `A equipe Aqta está criando o ambiente da <strong>${esc(d.company)}</strong> e avisa você no WhatsApp e no e-mail <strong>${esc(d.loginEmail)}</strong> assim que estiver tudo pronto. Se preferir, chame a gente agora.`
        : `Use os dados abaixo para entrar. Guarde a senha temporária em local seguro — ela aparece só nesta sessão.`}</p>

      <dl class="ac-data">
        <dt>Produto</dt><dd>${esc(d.productName)} · Plano Básico</dd>
        <dt>Empresa</dt><dd>${esc(d.company || '—')}</dd>
        ${d.product === 'emptra' && d.profile ? `<dt>Perfil</dt><dd>${d.profile === 'fornecedor' ? 'Fornecedor' : 'Comprador'}</dd>` : ''}
        <dt>E-mail de login</dt>
        <dd>
          <div class="ac-secret">
            <span class="ac-mono" id="ac-email">${esc(d.loginEmail)}</span>
            <button class="btn btn--ghost btn--sm" type="button" data-copy="email">Copiar</button>
          </div>
        </dd>
        ${passwordRow}
        ${manual ? `<dt>Prazo</dt><dd>${esc(d.manualDeadline || 'até 1 dia útil')}</dd>` : ''}
      </dl>

      ${!manual && pwd ? `<p class="alert alert--warn" style="margin-top:16px">Por segurança, troque a senha no primeiro acesso: ${changeWhere}.</p>` : ''}

      <div class="ac-actions">
        ${manual
          ? `<a class="btn btn--primary" href="${esc(support)}" target="_blank" rel="noopener">Falar com a Aqta no WhatsApp</a>
             <a class="btn btn--ghost" href="${esc(safeUrl(d.loginUrl))}">${enter}</a>`
          : `<a class="btn btn--primary" href="${esc(safeUrl(d.loginUrl))}">${enter}</a>
             <a class="btn btn--ghost" href="${esc(support)}" target="_blank" rel="noopener">Precisa de ajuda?</a>`}
      </div>
      ${manual ? `<p class="ac-note">O botão “${enter}” funciona assim que o acesso for liberado.</p>` : ''}
      <p class="ac-sr" id="ac-live" aria-live="polite"></p>
    </section>
    ${stepsHTML(d)}`);

  wireCopy(d, pwd);
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
  const out = document.getElementById('ac-pwd');
  if (show && out) {
    show.addEventListener('click', () => {
      const visible = show.getAttribute('aria-pressed') === 'true';
      show.setAttribute('aria-pressed', String(!visible));
      show.textContent = visible ? 'Mostrar' : 'Ocultar';
      out.textContent = visible ? '••••••••••••' : pwd;
      out.setAttribute('aria-label', visible ? 'Senha temporária (oculta)' : 'Senha temporária');
    });
  }
}

// ---------------------------------------------------------------- carga

async function load(token) {
  render(`
    <section class="frame ac-card">
      <div class="ac-center" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <p class="ac-lead">Carregando seus dados de acesso…</p>
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
  if (!res.ok || !data.ok) return viewNetworkError(token);

  document.title = `Acesso ao ${data.productName} — Aqta`;
  if (!data.onboarded) return viewPending(data);
  return viewReady(data);
}

const token = readToken();
if (!token) viewInvalid('invalid');
else load(token);
