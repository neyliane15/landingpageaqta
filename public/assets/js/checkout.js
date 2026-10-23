// Modal de compra (Checkout Pro do Mercado Pago). Módulo ES sem dependências.
// Uso: qualquer elemento com [data-checkout="obtra|emptra"][data-plan="basico"] abre o modal.

const STORAGE_KEY = 'aqta:checkout:customer';
const MODAL_ID = 'checkout-modal';

// ---------------------------------------------------------------- validação (espelha api/checkout.js)

const onlyDigits = (v) => String(v ?? '').replace(/\D+/g, '');
const cleanText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

function isValidEmail(v) {
  const s = String(v ?? '');
  if (s.length < 6 || s.length > 254) return false;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i.test(s)
    && !s.includes('..');
}
function isValidCpf(v) {
  const d = onlyDigits(v);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    if (((sum * 10) % 11) % 10 !== Number(d[len])) return false;
  }
  return true;
}
function isValidCnpj(v) {
  const d = onlyDigits(v);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * w[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}
function isValidWhatsapp(v) {
  let d = onlyDigits(v);
  if (d.length < 10 || d.length > 13) return false;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return false;
  if (!/^[1-9][1-9]$/.test(d.slice(0, 2))) return false;
  const n = d.slice(2);
  if (n.length === 9) return n[0] === '9';
  return /^[2-9]/.test(n);
}
const isValidName = (v) => { const s = cleanText(v); return s.length >= 3 && s.length <= 120 && /\p{L}/u.test(s); };

function validate(c) {
  const f = {};
  if (!isValidName(c.name)) f.name = 'Informe o nome completo (mínimo 3 letras).';
  if (!isValidEmail(c.email)) f.email = 'Informe um e-mail válido.';
  if (!isValidWhatsapp(c.whatsapp)) f.whatsapp = 'Informe um WhatsApp com DDD (ex.: (11) 91234-5678).';
  const doc = onlyDigits(c.document);
  if (!doc) f.document = 'Informe o CPF ou CNPJ.';
  else if (!isValidCpf(doc) && !isValidCnpj(doc)) {
    f.document = doc.length === 14 ? 'CNPJ inválido.' : doc.length === 11 ? 'CPF inválido.' : 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).';
  }
  if (cleanText(c.company).length > 120) f.company = 'Máximo de 120 caracteres.';
  return f;
}

// ---------------------------------------------------------------- máscaras

function maskWhatsapp(v) {
  let d = onlyDigits(v);
  let prefix = '';
  if (d.length > 11 && d.startsWith('55')) { prefix = '+55 '; d = d.slice(2); }
  d = d.slice(0, 11);
  if (d.length <= 2) return prefix + (d ? `(${d}` : '');
  const ddd = `(${d.slice(0, 2)}) `;
  const n = d.slice(2);
  if (n.length <= 4) return prefix + ddd + n;
  const split = n.length === 9 ? 5 : 4;
  return prefix + ddd + n.slice(0, split) + '-' + n.slice(split);
}
function maskDocument(v) {
  const d = onlyDigits(v).slice(0, 14);
  if (d.length <= 11) {
    return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
  }
  return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3/$4')
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})\/(\d{4})(\d)/, '$1.$2.$3/$4-$5');
}

// ---------------------------------------------------------------- catálogo (cache)

let catalogPromise = null;
function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch('/api/catalog', { headers: { Accept: 'application/json' } })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .catch((err) => { catalogPromise = null; throw err; });
  }
  return catalogPromise;
}

// ---------------------------------------------------------------- armazenamento

function readSaved() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null') || {}; } catch { return {}; }
}
function save(c) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(c)); } catch { /* sem storage */ }
}

// ---------------------------------------------------------------- modal

const FIELDS = [
  { name: 'name', label: 'Nome completo', type: 'text', autocomplete: 'name', maxlength: 120, required: true },
  { name: 'email', label: 'E-mail', type: 'email', autocomplete: 'email', maxlength: 254, required: true, inputmode: 'email' },
  { name: 'whatsapp', label: 'WhatsApp', type: 'tel', autocomplete: 'tel-national', maxlength: 20, required: true, inputmode: 'tel', placeholder: '(11) 91234-5678' },
  { name: 'document', label: 'CPF ou CNPJ', type: 'text', autocomplete: 'off', maxlength: 18, required: true, inputmode: 'numeric', placeholder: '000.000.000-00' },
  { name: 'company', label: 'Empresa', type: 'text', autocomplete: 'organization', maxlength: 120, required: false, hint: 'opcional' },
];

const STYLESHEET = '/assets/css/checkout.css';

const LOCK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

let dialog = null;
let els = {};
let current = { product: null, plan: null, opener: null };

function el(tag, attrs = {}, html) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    node.setAttribute(k, v === true ? '' : v);
  }
  if (html != null) node.innerHTML = html;
  return node;
}

function buildModal() {
  if (dialog) return dialog;
  // Estilos em arquivo (CSP sem 'unsafe-inline'); a landing já os carrega no <head>, aqui é só garantia.
  if (!document.querySelector(`link[href="${STYLESHEET}"]`)) {
    document.head.appendChild(el('link', { rel: 'stylesheet', href: STYLESHEET, 'data-checkout-style': true }));
  }

  dialog = el('dialog', { class: 'modal', id: MODAL_ID, 'aria-labelledby': 'co-title', 'aria-describedby': 'co-secure' });
  dialog.innerHTML = `
    <div class="modal__dialog frame">
      <div class="co-head">
        <div>
          <p class="eyebrow">Plano mensal pré-pago</p>
          <h2 class="co-title" id="co-title">Finalizar compra</h2>
        </div>
        <button type="button" class="modal__close" data-co-close aria-label="Fechar">&times;</button>
      </div>
      <div class="co-summary frame" aria-live="polite">
        <div>
          <div class="co-summary__name" data-co-name>Carregando…</div>
          <div class="co-summary__tag" data-co-tag></div>
        </div>
        <div class="co-summary__price" data-co-price><span class="spinner" aria-hidden="true"></span></div>
      </div>
      <p class="co-secure" id="co-secure">${LOCK_ICON}<span>Pagamento seguro via Mercado Pago · PIX, cartão ou boleto</span></p>
      <div class="alert alert--warn co-alert" data-co-demo role="note" hidden>Modo demonstração — nenhum valor será cobrado.</div>
      <div class="alert alert--err co-alert" data-co-error role="alert" hidden></div>
      <form novalidate data-co-form>
        <div class="co-grid">
          ${FIELDS.map((f) => `
            <div class="field ${f.name === 'name' || f.name === 'email' ? 'co-full' : ''} ${f.name === 'company' ? 'co-full' : ''}">
              <label for="co-${f.name}">${f.label}${f.hint ? ` <span class="co-hint">(${f.hint})</span>` : ''}</label>
              <input id="co-${f.name}" name="${f.name}" type="${f.type}" autocomplete="${f.autocomplete}"
                maxlength="${f.maxlength}" ${f.required ? 'required aria-required="true"' : ''}
                ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} ${f.placeholder ? `placeholder="${f.placeholder}"` : ''}
                aria-describedby="co-${f.name}-err">
              <p class="field-error" id="co-${f.name}-err" aria-live="polite"></p>
            </div>`).join('')}
        </div>
        <label class="co-terms">
          <input type="checkbox" name="terms" id="co-terms" required aria-describedby="co-terms-err">
          <span>Li e concordo com os <a href="/termos" target="_blank" rel="noopener">Termos de Uso e Contratação</a> e com a <a href="/privacidade" target="_blank" rel="noopener">Política de Privacidade</a>. Entendo que o plano é pré-pago: este pagamento cobre 1 mês de uso, sem débito automático, e a renovação é feita com um novo pagamento.</span>
        </label>
        <p class="field-error" id="co-terms-err" aria-live="polite"></p>
        <div class="co-actions">
          <button type="submit" class="btn btn--primary btn--block" data-co-submit>Ir para o pagamento</button>
        </div>
        <p class="co-foot">Você será redirecionado ao ambiente do Mercado Pago para concluir.</p>
      </form>
    </div>`;
  document.body.appendChild(dialog);

  els = {
    form: dialog.querySelector('[data-co-form]'),
    name: dialog.querySelector('[data-co-name]'),
    tag: dialog.querySelector('[data-co-tag]'),
    price: dialog.querySelector('[data-co-price]'),
    demo: dialog.querySelector('[data-co-demo]'),
    error: dialog.querySelector('[data-co-error]'),
    submit: dialog.querySelector('[data-co-submit]'),
  };

  const inputs = els.form.elements;
  inputs.whatsapp.addEventListener('input', (e) => { e.target.value = maskWhatsapp(e.target.value); });
  inputs.document.addEventListener('input', (e) => { e.target.value = maskDocument(e.target.value); });
  for (const f of FIELDS) {
    // No blur só ACRESCENTA erro (nunca limpa): limpar mudaria o layout no meio de um clique em "Ir para o pagamento".
    inputs[f.name].addEventListener('blur', () => {
      if (!inputs[f.name].value) return;
      const msg = validate(collect())[f.name];
      if (msg) setFieldError(f.name, msg);
    });
    // Ao digitar, reavalia (e limpa erros, inclusive os vindos do servidor) quando o campo fica válido.
    inputs[f.name].addEventListener('input', () => {
      if (inputs[f.name].getAttribute('aria-invalid') === 'true') setFieldError(f.name, validate(collect())[f.name] || '');
    });
  }
  inputs.terms.addEventListener('change', () => { if (inputs.terms.checked) setFieldError('terms', ''); });

  dialog.querySelector('[data-co-close]').addEventListener('click', () => close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); }); // clique no fundo
  dialog.addEventListener('close', onClosed);
  els.form.addEventListener('submit', onSubmit);
  return dialog;
}

function collect() {
  const i = els.form.elements;
  return {
    name: cleanText(i.name.value),
    email: i.email.value.trim().toLowerCase(),
    whatsapp: onlyDigits(i.whatsapp.value),
    document: onlyDigits(i.document.value),
    company: cleanText(i.company.value),
  };
}

function setFieldError(name, msg) {
  const input = els.form.elements[name];
  const err = dialog.querySelector(`#co-${name}-err`);
  if (err) err.textContent = msg || '';
  if (input) {
    if (msg) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

function showErrors(fields) {
  let first = null;
  for (const name of [...FIELDS.map((f) => f.name), 'terms']) {
    const msg = fields[name] || '';
    setFieldError(name, msg);
    if (msg && !first) first = els.form.elements[name];
  }
  if (first) first.focus();
}

function setError(msg) {
  els.error.textContent = msg || '';
  els.error.hidden = !msg;
}

function setBusy(busy) {
  els.submit.disabled = busy;
  els.submit.setAttribute('aria-busy', busy ? 'true' : 'false');
  els.submit.textContent = busy ? 'Redirecionando…' : 'Ir para o pagamento';
}

async function renderSummary(productId, planId) {
  els.name.textContent = 'Carregando…';
  els.tag.textContent = '';
  els.price.innerHTML = '<span class="spinner" aria-hidden="true"></span><span class="sr-only">Carregando preço</span>';
  try {
    const cat = await loadCatalog();
    if (current.product !== productId) return; // outro produto foi aberto nesse meio-tempo
    const product = cat.products?.find((p) => p.id === productId);
    const plan = product?.plans?.find((p) => p.id === planId);
    if (!product || !plan) {
      els.name.textContent = 'Plano indisponível';
      els.price.textContent = '';
      setError('Este plano não está disponível no momento. Fale com a Aqta pelo formulário de contato do site.');
      els.submit.disabled = true;
      return;
    }
    els.name.textContent = `${product.name} · ${plan.name}`;
    els.tag.textContent = product.tagline || '';
    els.price.innerHTML = '';
    els.price.append(document.createTextNode(plan.price), el('small', {}, ` /${plan.interval}`));
    els.demo.hidden = !cat.demo;
  } catch {
    if (current.product !== productId) return;
    els.name.textContent = productId.charAt(0).toUpperCase() + productId.slice(1);
    els.price.textContent = '';
  }
}

function open(productId, planId, opener) {
  buildModal();
  current = { product: productId, plan: planId || 'basico', opener: opener || document.activeElement };
  setError('');
  setBusy(false);
  els.form.reset();
  for (const n of [...FIELDS.map((f) => f.name), 'terms']) setFieldError(n, '');

  const saved = readSaved();
  const i = els.form.elements;
  if (saved.name) i.name.value = saved.name;
  if (saved.email) i.email.value = saved.email;
  if (saved.whatsapp) i.whatsapp.value = maskWhatsapp(saved.whatsapp);
  if (saved.document) i.document.value = maskDocument(saved.document);
  if (saved.company) i.company.value = saved.company;

  renderSummary(current.product, current.plan);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  document.documentElement.style.overflow = 'hidden';
  const firstEmpty = FIELDS.map((f) => i[f.name]).find((inp) => !inp.value) || i.name;
  firstEmpty.focus();
}

function close() {
  if (!dialog) return;
  if (typeof dialog.close === 'function' && dialog.open) dialog.close();
  else { dialog.removeAttribute('open'); onClosed(); }
}

function onClosed() {
  document.documentElement.style.overflow = '';
  const opener = current.opener;
  if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
}

async function onSubmit(e) {
  e.preventDefault();
  if (els.submit.getAttribute('aria-busy') === 'true') return;
  setError('');
  const customer = collect();
  const fields = validate(customer);
  if (!els.form.elements.terms.checked) fields.terms = 'Confirme que concorda com as condições para continuar.';
  if (Object.keys(fields).length) { showErrors(fields); return; }
  showErrors({});
  save(customer);

  setBusy(true);
  try {
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ product: current.product, plan: current.plan, customer }),
    });
    let data = {};
    try { data = await res.json(); } catch { /* corpo vazio */ }
    if (res.ok && data.init_point) {
      window.location.href = data.init_point;
      return; // mantém o botão ocupado durante o redirecionamento
    }
    if (data.error === 'validation' && data.fields) {
      showErrors(data.fields);
      setError('Revise os campos destacados.');
    } else if (data.error === 'invalid_product') {
      setError('Este plano não está disponível no momento. Fale com a Aqta pelo formulário de contato do site.');
    } else {
      setError(data.message || 'Não foi possível iniciar o pagamento. Tente novamente em instantes.');
    }
  } catch {
    setError('Sem conexão com o servidor. Verifique sua internet e tente novamente.');
  }
  setBusy(false);
}

// ---------------------------------------------------------------- inicialização

document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-checkout]');
  if (!btn || btn.closest(`#${MODAL_ID}`)) return;
  e.preventDefault();
  open(btn.dataset.checkout, btn.dataset.plan || 'basico', btn);
});

// Pré-carrega o catálogo quando o navegador estiver ocioso (abre o modal mais rápido).
const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
idle(() => { loadCatalog().catch(() => {}); });

export { open as openCheckout, close as closeCheckout };
