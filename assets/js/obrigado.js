// Página /obrigado — retorno do pagamento (Mercado Pago ou gateway demo) e ativação do acesso.
// Máquina de estados: loading → approved | pending | rejected | error.
// A verdade vem sempre de GET /api/payment-status (nunca do ?status= da URL de retorno).

const POLL_INTERVAL_MS = 5000;
const POLL_WINDOW_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;

const $state = document.getElementById('ob-state');
const $announce = document.getElementById('ob-announce');
const $steps = document.getElementById('ob-steps');
const SUPPORT_WA = (document.body.dataset.supportWhatsapp || '').replace(/\D/g, '');

const params = new URLSearchParams(location.search);
const paymentId = (params.get('payment_id') || params.get('collection_id') || '').trim();
const validId = paymentId && paymentId !== 'null' && paymentId !== 'undefined';
const extRefRaw = (params.get('external_reference') || '').trim();
const extRef = extRefRaw && extRefRaw !== 'null' && extRefRaw !== 'undefined' ? extRefRaw : '';
// O servidor exige external_reference junto do payment_id (proteção contra enumeração de ids).
const statusUrl = `/api/payment-status?payment_id=${encodeURIComponent(paymentId)}&external_reference=${encodeURIComponent(extRef)}`;

let current = null;    // último payload de /api/payment-status
let poll = null;       // estado do polling (pendente)

// ---------------------------------------------------------------- utilidades

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const digits = (v) => String(v ?? '').replace(/\D/g, '');

function waLink(text) {
  const base = SUPPORT_WA ? `https://wa.me/${SUPPORT_WA}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(text)}`;
}

function storage(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch { /* modo privado / bloqueado */ }
  return null;
}

async function request(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal, cache: 'no-store',
      headers: { Accept: 'application/json', ...(options.headers || {}) } });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data: data || {} };
  } catch (err) {
    return { ok: false, status: 0, data: {}, network: true, aborted: err?.name === 'AbortError' };
  } finally {
    clearTimeout(timer);
  }
}

function setSteps(payment, activation = 'todo', access = 'todo') {
  const labels = { done: 'concluída', current: 'em andamento', warn: 'aguardando', err: 'com problema', todo: 'a fazer' };
  const map = { payment, activation, access };
  for (const li of $steps.querySelectorAll('.ob-step')) {
    const s = map[li.dataset.step];
    li.dataset.s = s;
    if (s === 'current' || s === 'warn' || s === 'err') li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
    li.querySelector('[data-status-text]').textContent = ` — ${labels[s]}`;
  }
}

function render(html, { announce, focus = true, busy = false } = {}) {
  $state.setAttribute('aria-busy', String(busy));
  $state.innerHTML = html;
  if (announce) {
    $announce.textContent = '';
    // pequeno atraso para leitores de tela perceberem a troca de texto
    setTimeout(() => { $announce.textContent = announce; }, 60);
  }
  if (focus) {
    const title = $state.querySelector('.page-shell__title');
    if (title) title.focus({ preventScroll: false });
  }
}

// ---------------------------------------------------------------- estados

function renderLoading(text = 'Confirmando seu pagamento…') {
  setSteps('current');
  render(`
    <div class="ob-head ob-loading">
      <span class="spinner spinner--lg" aria-hidden="true"></span>
      <p class="eyebrow">Pagamento</p>
      <h1 class="page-shell__title" id="ob-title" tabindex="-1">${esc(text)}</h1>
      <p class="page-shell__lead">Estamos consultando o Mercado Pago. Isso leva só alguns segundos.</p>
    </div>`, { busy: true, focus: false });
}

function renderError({ title, message, retry = true }) {
  stopPolling();
  setSteps('err');
  render(`
    <div class="ob-head">
      <div class="page-shell__icon page-shell__icon--err" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 7v6M12 17h.01"/></svg></div>
      <p class="eyebrow">Algo não saiu como esperado</p>
      <h1 class="page-shell__title" id="ob-title" tabindex="-1">${esc(title)}</h1>
      <p class="page-shell__lead">${message}</p>
      <div class="page-shell__actions">
        ${retry ? '<button type="button" class="btn btn--primary" data-action="retry">Tentar novamente</button>' : ''}
        <a class="btn btn--ghost" href="${esc(waLink(`Olá! Preciso de ajuda com meu pagamento na Aqta.${validId ? ` Código: ${paymentId.slice(0, 40)}` : ''}`))}" target="_blank" rel="noopener">Falar com o suporte</a>
        ${retry ? '' : '<a class="btn btn--ghost" href="/#planos">Ver planos</a>'}
      </div>
    </div>`, { announce: title });
  $state.querySelector('[data-action="retry"]')?.addEventListener('click', () => load());
}

function summaryHTML(d) {
  const c = d.customer || {};
  const who = c.company || c.name || '—';
  const sub = c.company && c.name ? c.name : (c.email || '');
  return `
    <dl class="ob-summary">
      <div><dt>Produto</dt><dd>${esc(d.productName || d.product || '—')}</dd></div>
      <div><dt>Plano</dt><dd>${esc(d.planName || planLabel(d.plan))}</dd></div>
      <div><dt>Valor</dt><dd class="ob-amount">${esc(d.amount || '—')}<small>por mês</small></dd></div>
      <div><dt>Cliente</dt><dd>${esc(who)}${sub ? `<small>${esc(sub)}</small>` : ''}</dd></div>
    </dl>`;
}

function planLabel(plan) {
  if (!plan) return '—';
  if (plan === 'basico') return 'Plano Básico';
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function renderApproved(d) {
  stopPolling();
  setSteps('done', 'current');
  const product = d.product === 'emptra' ? 'emptra' : 'obtra';
  const name = d.productName || (product === 'emptra' ? 'Emptra' : 'Obtra');
  const first = (d.customer?.name || '').trim().split(/\s+/)[0];
  render(`
    <div class="ob-head">
      <div class="ob-seal" aria-hidden="true">
        <svg viewBox="0 0 80 80">
          <circle class="ob-seal__ring2" cx="40" cy="40" r="39"/>
          <circle class="ob-seal__ring" cx="40" cy="40" r="34" transform="rotate(-90 40 40)"/>
          <path class="ob-seal__check" d="M26 41 l9 9 l19 -20"/>
          <g class="ob-seal__ticks">
            <line x1="40" y1="-4" x2="40" y2="-10"/><line x1="40" y1="84" x2="40" y2="90"/>
            <line x1="-4" y1="40" x2="-10" y2="40"/><line x1="84" y1="40" x2="90" y2="40"/>
            <line x1="9" y1="9" x2="5" y2="5"/><line x1="71" y1="71" x2="75" y2="75"/>
            <line x1="71" y1="9" x2="75" y2="5"/><line x1="9" y1="71" x2="5" y2="75"/>
          </g>
        </svg>
      </div>
      <span class="badge badge--ok">Pagamento aprovado</span>
      <h1 class="page-shell__title" id="ob-title" tabindex="-1">Pagamento confirmado</h1>
      <p class="page-shell__lead">${first ? `${esc(first)}, falta` : 'Falta'} só um passo para começar a usar o <strong>${esc(name)}</strong>: confirme os dados abaixo e ativamos o seu acesso.</p>
    </div>
    ${summaryHTML(d)}
    ${activationFormHTML(d, product)}`, { announce: `Pagamento aprovado. Preencha os dados para ativar o ${name}.` });
  wireForm(d, product);
}

const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

function activationFormHTML(d, product) {
  const c = d.customer || {};
  const ufOptions = ['<option value="">UF</option>', ...UFS.map((u) => `<option>${u}</option>`)].join('');
  const extra = product === 'emptra' ? `
      <fieldset class="ob-fieldset form-grid__full" id="f-perfil" aria-describedby="err-perfil">
        <legend>Como você vai usar o Emptra?</legend>
        <div class="ob-radios">
          <label class="ob-radio"><input type="radio" name="perfil" value="comprador" required>
            <span><strong>Comprador</strong><small>Arquiteto, engenheiro ou construtora que cota materiais.</small></span></label>
          <label class="ob-radio"><input type="radio" name="perfil" value="fornecedor">
            <span><strong>Fornecedor</strong><small>Loja ou distribuidor que recebe e responde cotações.</small></span></label>
        </div>
        <p class="field-error" id="err-perfil" data-error-for="perfil"></p>
      </fieldset>
      <div class="ob-city form-grid__full">
        <div class="field">
          <label for="f-cidade">Cidade de atuação</label>
          <input id="f-cidade" name="cidade" autocomplete="address-level2" required maxlength="80" aria-describedby="err-cidade">
          <p class="field-error" id="err-cidade" data-error-for="cidade"></p>
        </div>
        <div class="field">
          <label for="f-uf">UF</label>
          <select id="f-uf" name="uf" autocomplete="address-level1" required aria-describedby="err-uf">${ufOptions}</select>
          <p class="field-error" id="err-uf" data-error-for="uf"></p>
        </div>
      </div>` : `
      <div class="field">
        <label for="f-obras">Obras ativas hoje</label>
        <select id="f-obras" name="obrasAtivas" required aria-describedby="err-obrasAtivas">
          <option value="">Selecione</option>
          <option value="1-3">1 a 3 obras</option>
          <option value="4-10">4 a 10 obras</option>
          <option value="11-30">11 a 30 obras</option>
          <option value="30+">Mais de 30 obras</option>
        </select>
        <p class="field-error" id="err-obrasAtivas" data-error-for="obrasAtivas"></p>
      </div>
      <div class="ob-city">
        <div class="field">
          <label for="f-cidade">Cidade</label>
          <input id="f-cidade" name="cidade" autocomplete="address-level2" required maxlength="80" aria-describedby="err-cidade">
          <p class="field-error" id="err-cidade" data-error-for="cidade"></p>
        </div>
        <div class="field">
          <label for="f-uf">UF</label>
          <select id="f-uf" name="uf" autocomplete="address-level1" required aria-describedby="err-uf">${ufOptions}</select>
          <p class="field-error" id="err-uf" data-error-for="uf"></p>
        </div>
      </div>`;

  const doc = digits(c.document);
  const wa = waDisplayDigits(c.whatsapp);
  return `
    <div class="ob-divider" aria-hidden="true"><span class="eyebrow">Ativação</span></div>
    <form id="ob-form" class="ob-form" novalidate aria-describedby="ob-form-desc">
      <h2 class="ob-form-title">Dados da conta</h2>
      <p class="ob-note" id="ob-form-desc">Usaremos estes dados para criar o acesso da sua empresa. Todos os campos são obrigatórios.</p>
      <div class="form-grid">
        <div class="field form-grid__full">
          <label for="f-company">Nome da empresa</label>
          <input id="f-company" name="company" autocomplete="organization" required minlength="2" maxlength="120"
            value="${esc(c.company || '')}" aria-describedby="err-company">
          <p class="field-error" id="err-company" data-error-for="company"></p>
        </div>
        <div class="field">
          <label for="f-document">CNPJ ou CPF</label>
          <input id="f-document" name="document" inputmode="numeric" autocomplete="off" required maxlength="18"
            placeholder="00.000.000/0000-00" value="${esc(maskDocument(doc))}" aria-describedby="${!doc && c.documentMasked ? 'hint-document ' : ''}err-document">
          ${!doc && c.documentMasked ? `<small class="field-hint" id="hint-document">Informado no pagamento: ${esc(c.documentMasked)}</small>` : ''}
          <p class="field-error" id="err-document" data-error-for="document"></p>
        </div>
        <div class="field">
          <label for="f-responsible">Responsável</label>
          <input id="f-responsible" name="responsible" autocomplete="name" required minlength="3" maxlength="120"
            value="${esc(c.name || '')}" aria-describedby="err-responsible">
          <p class="field-error" id="err-responsible" data-error-for="responsible"></p>
        </div>
        <div class="field">
          <label for="f-loginEmail">E-mail de login</label>
          <input id="f-loginEmail" name="loginEmail" type="email" autocomplete="email" required maxlength="160"
            value="${esc(c.email || '')}" aria-describedby="hint-loginEmail err-loginEmail">
          <small class="field-hint" id="hint-loginEmail">Será o seu usuário no ${esc(d.productName || product)}.</small>
          <p class="field-error" id="err-loginEmail" data-error-for="loginEmail"></p>
        </div>
        <div class="field">
          <label for="f-whatsapp">WhatsApp</label>
          <input id="f-whatsapp" name="whatsapp" type="tel" inputmode="tel" autocomplete="tel-national" required maxlength="16"
            placeholder="(00) 00000-0000" value="${esc(maskPhone(wa))}" aria-describedby="err-whatsapp">
          <p class="field-error" id="err-whatsapp" data-error-for="whatsapp"></p>
        </div>
        ${extra}
      </div>
      <div id="ob-form-alert" role="alert" aria-live="assertive"></div>
      <button type="submit" class="btn btn--primary btn--block">Ativar meu acesso</button>
      <p class="ob-note" style="text-align:center">Ao ativar, você concorda com os termos de uso do ${esc(d.productName || product)}.</p>
    </form>`;
}

function renderPending(d) {
  setSteps('warn');
  const isPix = /pix|bank_transfer/i.test(d.paymentMethod || d.payment_type || '');
  const isBoleto = /boleto|ticket/i.test(d.paymentMethod || d.payment_type || '');
  render(`
    <div class="ob-head">
      <div class="page-shell__icon page-shell__icon--warn" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9.5 2.5h5"/></svg></div>
      <span class="badge badge--warn">${d.status === 'in_process' ? 'Em análise' : 'Aguardando pagamento'}</span>
      <h1 class="page-shell__title" id="ob-title" tabindex="-1">${d.status === 'in_process' ? 'Seu pagamento está em análise' : 'Estamos aguardando a confirmação'}</h1>
      <p class="page-shell__lead">${d.status === 'in_process'
        ? 'O Mercado Pago está revisando o pagamento — normalmente leva poucos minutos. Assim que for aprovado, esta página avança sozinha.'
        : `Seu pedido do <strong>${esc(d.productName || 'sistema Aqta')}</strong> foi criado. Assim que o pagamento cair, esta página avança sozinha para a ativação.`}</p>
    </div>
    ${summaryHTML(d)}
    <div class="ob-methods">
      ${isBoleto ? '' : '<div><h3>PIX</h3><p>Confirmado em segundos após o pagamento. Se ainda não pagou, use o QR Code ou o código copia-e-cola do Mercado Pago.</p></div>'}
      ${isPix ? '' : '<div><h3>Boleto</h3><p>A compensação leva até 3 dias úteis. Você receberá um e-mail quando for confirmado — pode fechar esta página.</p></div>'}
    </div>
    <div class="ob-center">
      <p class="ob-poll" id="ob-poll"><span class="ob-dot" aria-hidden="true"></span><span id="ob-poll-text">Verificando automaticamente…</span></p>
      <div class="ob-meter" aria-hidden="true"><i id="ob-meter"></i></div>
      <div class="page-shell__actions">
        <button type="button" class="btn btn--primary" data-action="check">Já paguei — verificar agora</button>
        <a class="btn btn--ghost" href="${esc(waLink(`Olá! Fiz o pagamento do ${d.productName || 'sistema Aqta'} e ele ainda aparece como pendente.`))}" target="_blank" rel="noopener">Falar com o suporte</a>
      </div>
      <p class="ob-note">Guarde este link: você pode voltar a esta página a qualquer momento para continuar a ativação.</p>
    </div>`, { announce: 'Pagamento pendente. Verificaremos automaticamente a cada 5 segundos.' });
  $state.querySelector('[data-action="check"]').addEventListener('click', (e) => checkNow(e.currentTarget));
  startPolling();
}

const REJECT_REASONS = {
  cc_rejected_insufficient_amount: 'O cartão não tem limite suficiente para esta compra.',
  cc_rejected_bad_filled_security_code: 'O código de segurança (CVV) do cartão foi recusado.',
  cc_rejected_bad_filled_date: 'A data de validade do cartão não confere.',
  cc_rejected_bad_filled_card_number: 'O número do cartão não confere.',
  cc_rejected_bad_filled_other: 'Algum dado do cartão não confere.',
  cc_rejected_call_for_authorize: 'O banco emissor pediu autorização. Ligue para o seu banco e tente de novo.',
  cc_rejected_card_disabled: 'O cartão está inativo. Ative-o com o banco ou use outro.',
  cc_rejected_duplicated_payment: 'Já existe um pagamento igual recente. Confira seu extrato antes de tentar de novo.',
  cc_rejected_high_risk: 'O pagamento foi recusado pela análise de segurança. Tente outro meio, como o PIX.',
  cc_rejected_max_attempts: 'Limite de tentativas atingido. Use outro cartão ou o PIX.',
  cc_rejected_blacklist: 'O pagamento não pôde ser processado com este cartão. Tente outro meio.',
  expired: 'O prazo para pagamento expirou.',
  by_payer: 'O pagamento foi cancelado.',
  by_collector: 'O pagamento foi cancelado.',
};

function renderRejected(d) {
  stopPolling();
  setSteps('err');
  const cancelled = d.status === 'cancelled';
  const detail = d.statusDetail || d.status_detail || '';
  const reason = d.reason || REJECT_REASONS[detail]
    || (cancelled ? 'O pagamento foi cancelado ou expirou antes de ser concluído.'
      : 'O meio de pagamento não foi autorizado. Nenhum valor foi cobrado.');
  const title = cancelled ? 'Pagamento cancelado' : 'Pagamento não aprovado';
  render(`
    <div class="ob-head">
      <div class="page-shell__icon page-shell__icon--err" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg></div>
      <span class="badge badge--err">${cancelled ? 'Cancelado' : 'Recusado'}</span>
      <h1 class="page-shell__title" id="ob-title" tabindex="-1">${title}</h1>
      <p class="page-shell__lead">${esc(reason)}</p>
    </div>
    ${d.product ? summaryHTML(d) : ''}
    <div class="ob-center">
      <div class="page-shell__actions">
        <a class="btn btn--primary" href="/#planos">Tentar novamente</a>
        <a class="btn btn--ghost" href="${esc(waLink(`Olá! Meu pagamento do ${d.productName || 'sistema Aqta'} não foi aprovado. Podem me ajudar?`))}" target="_blank" rel="noopener">Falar com o suporte no WhatsApp</a>
      </div>
      <p class="ob-note">Dica: o PIX é aprovado na hora e não depende de limite do cartão.</p>
    </div>`, { announce: `${title}. ${reason}` });
}

// ---------------------------------------------------------------- polling (pendente)

function startPolling() {
  stopPolling();
  poll = { deadline: Date.now() + POLL_WINDOW_MS, next: Date.now() + POLL_INTERVAL_MS, tick: null, busy: false, expired: false };
  poll.tick = setInterval(onTick, 1000);
  updatePollUI();
}

function stopPolling() {
  if (poll?.tick) clearInterval(poll.tick);
  poll = null;
}

function pausePolling() {
  if (poll?.tick) { clearInterval(poll.tick); poll.tick = null; updatePollUI(); }
}

function resumePolling() {
  if (!poll || poll.tick || poll.expired) return;
  if (Date.now() >= poll.deadline) { expirePolling(); return; }
  poll.next = Date.now(); // verifica assim que a aba volta
  poll.tick = setInterval(onTick, 1000);
  onTick();
}

function expirePolling() {
  if (!poll) return;
  if (poll.tick) clearInterval(poll.tick);
  poll.tick = null;
  poll.expired = true;
  updatePollUI();
  $announce.textContent = 'Verificação automática encerrada. Use o botão "Já paguei — verificar agora".';
}

async function onTick() {
  if (!poll || poll.busy) return;
  if (Date.now() >= poll.deadline) { expirePolling(); return; }
  if (Date.now() >= poll.next) {
    poll.busy = true;
    updatePollUI(true);
    await refresh({ silent: true });
    if (poll) { poll.busy = false; poll.next = Date.now() + POLL_INTERVAL_MS; }
  }
  updatePollUI();
}

function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function updatePollUI(checking = false) {
  const text = document.getElementById('ob-poll-text');
  const meter = document.getElementById('ob-meter');
  const dot = document.querySelector('.ob-dot');
  if (!text || !poll) return;
  const left = poll.deadline - Date.now();
  if (poll.expired) {
    text.innerHTML = 'Verificação automática encerrada. Assim que pagar, toque em <b>verificar agora</b>.';
    dot?.setAttribute('data-paused', '');
    if (meter) meter.style.transform = 'scaleX(0)';
    return;
  }
  if (!poll.tick) {
    text.innerHTML = 'Verificação pausada enquanto a aba está em segundo plano.';
    dot?.setAttribute('data-paused', '');
    return;
  }
  dot?.removeAttribute('data-paused');
  const nextIn = Math.max(0, Math.ceil((poll.next - Date.now()) / 1000));
  text.innerHTML = checking || poll.busy
    ? `Verificando agora… · encerra em <b>${fmt(left)}</b>`
    : `Próxima verificação em <b>${nextIn}s</b> · encerra em <b>${fmt(left)}</b>`;
  if (meter) meter.style.transform = `scaleX(${Math.max(0, left / POLL_WINDOW_MS).toFixed(4)})`;
}

async function checkNow(btn) {
  if (btn.getAttribute('aria-busy') === 'true') return;
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  const res = await refresh({ silent: true, manual: true });
  if (!btn.isConnected) return; // estado mudou (aprovado/recusado)
  btn.removeAttribute('aria-busy');
  btn.disabled = false;
  if (res === 'pending') {
    $announce.textContent = '';
    setTimeout(() => { $announce.textContent = 'Ainda não recebemos a confirmação. Se pagou por PIX, aguarde alguns segundos e tente de novo.'; }, 60);
    const text = document.getElementById('ob-poll-text');
    if (text && poll?.expired) {
      text.innerHTML = `Ainda não confirmado (verificado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}).`;
    }
  } else if (res === 'error') {
    $announce.textContent = 'Não conseguimos verificar agora. Tente novamente em instantes.';
  }
}

document.addEventListener('visibilitychange', () => {
  if (!poll) return;
  if (document.hidden) pausePolling();
  else resumePolling();
});

// ---------------------------------------------------------------- carga / transições

const PENDING = new Set(['pending', 'in_process', 'authorized', 'in_mediation']);
const FAILED = new Set(['rejected', 'cancelled', 'refunded', 'charged_back']);

function classify(status) {
  if (status === 'approved') return 'approved';
  if (PENDING.has(status)) return 'pending';
  if (FAILED.has(status)) return 'rejected';
  return 'unknown';
}

// Consulta o status. silent = não mostra "carregando" (usado no polling). Retorna a classe do status.
async function refresh({ silent = false } = {}) {
  const res = await request(statusUrl);
  if (!res.ok) {
    if (silent && current) return 'error'; // falha transitória durante polling: mantém a tela
    if (res.status === 400) {
      renderError({ title: 'Não encontramos o código do pagamento', message: 'O link de retorno está incompleto. Se você concluiu o pagamento, fale com a gente pelo WhatsApp que liberamos seu acesso.', retry: false });
    } else if (res.status === 404) {
      renderError({ title: 'Pagamento não encontrado', message: 'Não localizamos este pagamento entre os pedidos da Aqta. Confira se abriu o link correto ou fale com o suporte.', retry: true });
    } else if (res.network) {
      renderError({ title: 'Sem conexão com o servidor', message: 'Verifique sua internet e tente novamente. Se o pagamento foi feito, ele está seguro — nada será cobrado em dobro.' });
    } else {
      renderError({ title: 'Não conseguimos confirmar agora', message: 'O Mercado Pago não respondeu a tempo. Seu pagamento não é afetado — tente novamente em alguns segundos.' });
    }
    return 'error';
  }
  const d = res.data;
  const kind = classify(d.status);
  const prevKind = current ? classify(current.status) : null;
  current = d;
  if (kind === 'approved') {
    if (!d.accessToken) {
      renderError({ title: 'Pagamento aprovado, ativação indisponível', message: 'Recebemos seu pagamento, mas não conseguimos gerar o link de ativação. Fale com o suporte — liberamos seu acesso rapidamente.' });
      return 'error';
    }
    storage('aqta.access', d.accessToken);
    renderApproved(d);
  } else if (kind === 'pending') {
    if (prevKind !== 'pending' || !poll) renderPending(d);
  } else if (kind === 'rejected') {
    renderRejected(d);
  } else {
    renderError({ title: 'Status de pagamento desconhecido', message: `O Mercado Pago informou o status “${esc(d.status || 'indefinido')}”. Tente novamente ou fale com o suporte.` });
    return 'error';
  }
  return kind;
}

async function load() {
  current = null;
  stopPolling();
  renderLoading();
  await refresh();
}

// ---------------------------------------------------------------- máscaras e validação

function maskDocument(v) {
  const d = digits(v).slice(0, 14);
  if (d.length <= 11) {
    return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  }
  return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d{1,2})$/, '$1-$2');
}

function waDisplayDigits(v) {
  let d = digits(v);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d.slice(0, 11);
}

function maskPhone(v) {
  const d = digits(v).slice(0, 11);
  if (!d) return '';
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

function validCPF(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  for (let t = 9; t < 11; t++) {
    let sum = 0;
    for (let i = 0; i < t; i++) sum += Number(cpf[i]) * (t + 1 - i);
    const dv = ((sum * 10) % 11) % 10;
    if (dv !== Number(cpf[t])) return false;
  }
  return true;
}

function validCNPJ(cnpj) {
  if (!/^\d{14}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;
  const calc = (len) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((acc, wi, i) => acc + Number(cnpj[i]) * wi, 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(cnpj[12]) && calc(13) === Number(cnpj[13]);
}

function validateForm(form, product) {
  const v = (n) => (form.elements[n]?.value || '').trim();
  const errors = {};
  if (v('company').length < 2) errors.company = 'Informe o nome da empresa.';
  const doc = digits(v('document'));
  if (!doc) errors.document = 'Informe o CNPJ ou CPF.';
  else if (doc.length === 11 ? !validCPF(doc) : doc.length === 14 ? !validCNPJ(doc) : true) {
    errors.document = doc.length === 11 ? 'CPF inválido — confira os dígitos.' : doc.length === 14 ? 'CNPJ inválido — confira os dígitos.' : 'Digite um CPF (11 dígitos) ou CNPJ (14 dígitos).';
  }
  if (v('responsible').length < 3) errors.responsible = 'Informe o nome completo do responsável.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v('loginEmail'))) errors.loginEmail = 'Informe um e-mail válido.';
  const wa = digits(v('whatsapp'));
  if (wa.length < 10 || wa.length > 11) errors.whatsapp = 'Informe o WhatsApp com DDD.';
  if (product === 'obtra' && !v('obrasAtivas')) errors.obrasAtivas = 'Selecione a quantidade de obras.';
  if (product === 'emptra' && !form.querySelector('input[name="perfil"]:checked')) errors.perfil = 'Escolha um perfil.';
  if (v('cidade').length < 2) errors.cidade = 'Informe a cidade.';
  if (!v('uf')) errors.uf = 'Selecione a UF.';
  return errors;
}

function clearErrors(form) {
  for (const p of form.querySelectorAll('[data-error-for]')) p.textContent = '';
  for (const f of form.querySelectorAll('.has-error')) f.classList.remove('has-error');
  for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
  form.querySelector('#ob-form-alert').innerHTML = '';
}

function showErrors(form, errors) {
  let first = null;
  for (const [rawKey, msg] of Object.entries(errors)) {
    const key = rawKey.replace(/^extra\./, '');
    const p = form.querySelector(`[data-error-for="${CSS.escape(key)}"]`);
    if (!p) continue;
    p.textContent = String(msg);
    p.closest('.field')?.classList.add('has-error');
    const input = form.elements[key];
    const target = input instanceof RadioNodeList ? input[0] : input;
    if (input instanceof RadioNodeList) form.querySelector('#f-perfil')?.setAttribute('aria-invalid', 'true');
    else target?.setAttribute('aria-invalid', 'true');
    if (!first && target) first = target;
  }
  return first;
}

function wireForm(d, product) {
  const form = document.getElementById('ob-form');
  const docInput = form.elements.document;
  const waInput = form.elements.whatsapp;
  docInput.addEventListener('input', () => { docInput.value = maskDocument(docInput.value); });
  waInput.addEventListener('input', () => { waInput.value = maskPhone(waInput.value); });

  // limpa o erro de um campo assim que o usuário o corrige
  form.addEventListener('input', (e) => {
    const name = e.target.name;
    if (!name) return;
    const p = form.querySelector(`[data-error-for="${CSS.escape(name)}"]`);
    if (p && p.textContent) { p.textContent = ''; p.closest('.field')?.classList.remove('has-error'); e.target.removeAttribute('aria-invalid'); form.querySelector('#f-perfil')?.removeAttribute('aria-invalid'); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    if (btn.getAttribute('aria-busy') === 'true') return;
    clearErrors(form);
    const errors = validateForm(form, product);
    if (Object.keys(errors).length) {
      const first = showErrors(form, errors);
      first?.focus();
      return;
    }
    const v = (n) => (form.elements[n]?.value || '').trim();
    const extra = product === 'emptra'
      ? { perfil: form.querySelector('input[name="perfil"]:checked').value, cidade: v('cidade'), uf: v('uf') }
      : { obrasAtivas: v('obrasAtivas'), cidade: v('cidade'), uf: v('uf') };
    const payload = {
      accessToken: d.accessToken,
      company: v('company'),
      document: digits(v('document')),
      responsible: v('responsible'),
      loginEmail: v('loginEmail').toLowerCase(),
      whatsapp: digits(v('whatsapp')),
      extra,
    };

    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    form.setAttribute('aria-busy', 'true');
    const original = btn.textContent;
    btn.textContent = 'Ativando seu acesso…';
    $announce.textContent = 'Ativando seu acesso, aguarde.';

    const res = await request('/api/onboarding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const r = res.data || {};
    if ((res.ok && r.ok) || r.alreadyDone) {
      const token = r.accessToken || d.accessToken;
      storage('aqta.access', token);
      if (r.tempPassword) storage('aqta.tempPassword', r.tempPassword);
      setSteps('done', 'done', 'current');
      btn.textContent = 'Acesso ativado — redirecionando…';
      $announce.textContent = 'Acesso ativado. Redirecionando para a página de acesso.';
      location.assign(`/acesso?token=${encodeURIComponent(token)}`);
      return;
    }

    btn.removeAttribute('aria-busy');
    btn.disabled = false;
    form.removeAttribute('aria-busy');
    btn.textContent = original;
    const alertBox = form.querySelector('#ob-form-alert');
    let msg;
    if (res.status === 400 && r.fields && Object.keys(r.fields).length) {
      const first = showErrors(form, r.fields);
      msg = 'Revise os campos destacados.';
      alertBox.innerHTML = `<p class="alert alert--err">${esc(msg)}</p>`;
      first?.focus();
      return;
    }
    if (res.status === 401 || res.status === 403 || r.error === 'invalid_token' || r.error === 'expired_token') {
      msg = 'O link de ativação expirou. Fale com o suporte para liberarmos seu acesso — seu pagamento está garantido.';
    } else if (res.network) {
      msg = 'Sem conexão com o servidor. Verifique sua internet e tente novamente.';
    } else {
      msg = r.message || 'Não conseguimos ativar agora. Tente novamente em instantes ou fale com o suporte.';
    }
    alertBox.innerHTML = `<p class="alert alert--err">${esc(msg)} <a href="${esc(waLink('Olá! Tive um problema ao ativar meu acesso na Aqta.'))}" target="_blank" rel="noopener">Falar com o suporte</a></p>`;
  });
}

// ---------------------------------------------------------------- início

const supportLink = document.getElementById('ob-support-link');
if (supportLink) supportLink.href = waLink('Olá! Tenho uma dúvida sobre minha contratação na Aqta.');
const supportNav = document.getElementById('ob-support-nav');
if (supportNav) supportNav.href = waLink('Olá! Tenho uma dúvida sobre minha contratação na Aqta.');

if (!validId) {
  renderError({
    title: 'Não encontramos o seu pagamento',
    message: 'Este link não traz o código do pagamento. Se você acabou de pagar, volte pelo botão “Voltar ao site” do Mercado Pago ou fale com a gente — liberamos seu acesso rapidamente.',
    retry: false,
  });
} else if (!extRef) {
  renderError({
    title: 'Link de retorno incompleto',
    message: 'Este link não traz todos os dados do pedido, então não conseguimos confirmar o pagamento por aqui. Fale com o suporte pelo WhatsApp — liberamos seu acesso rapidamente.',
    retry: false,
  });
} else {
  load();
}
