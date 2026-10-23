// Checkout simulado (modo demo). Lê ?ref=, busca o resumo verificado no servidor e simula o resultado.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ref = new URLSearchParams(location.search).get('ref') || '';

function show(id) {
  for (const s of ['cd-loading', 'cd-error', 'cd-checkout']) $('#' + s).hidden = s !== id;
}

function showError(msg) {
  if (msg) $('#cd-error-msg').textContent = msg;
  show('cd-error');
}

function fill(field, value) {
  for (const el of $$(`[data-f="${field}"]`)) el.textContent = value;
}

// PRNG determinístico a partir de uma string (QR fake estável para o mesmo pedido).
function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1000) / 1000; };
}

function fakeQrSvg(seed) {
  const n = 29;
  const rnd = seeded(seed);
  const finder = (x, y) => {
    for (const [fx, fy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      const dx = x - fx, dy = y - fy;
      if (dx >= -1 && dx <= 7 && dy >= -1 && dy <= 7) {
        if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return 0; // margem branca
        const edge = dx === 0 || dy === 0 || dx === 6 || dy === 6;
        const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        return edge || core ? 1 : 0;
      }
    }
    return -1;
  };
  let rects = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const f = finder(x, y);
      let on = f === -1 ? rnd() > 0.52 : f === 1;
      if (f === -1 && (x === 6 || y === 6)) on = (x + y) % 2 === 0; // linhas de sincronismo
      if (on) rects += `<rect x="${x}" y="${y}" width="1.02" height="1.02"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" aria-hidden="true"><g fill="#05070b">${rects}</g></svg>`;
}

function fakePixCode(order) {
  const amount = (order.amountCents / 100).toFixed(2);
  const id = order.externalReference.split(':').pop().replace(/-/g, '').slice(0, 25).toUpperCase();
  return `00020126580014BR.GOV.BCB.PIX0136demo-aqta-nao-pague-este-codigo5204000053039865405${amount}`
    + `5802BR5913AQTA DEMO6014RIO DE JANEIRO62290525${id}6304DEMO`;
}

// O formulário de cartão é só ilustrativo: nunca é enviado (antes era onsubmit="return false", inline — bloqueado pela CSP).
document.getElementById('cd-card-form')?.addEventListener('submit', (e) => e.preventDefault());

function setupTabs() {
  const tabs = $$('.cd-tab');
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $('#' + t.getAttribute('aria-controls')).hidden = !on;
    }
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      select(next); next.focus();
    });
  });
}

function setupCopy() {
  const btn = $('#cd-copy-btn');
  btn.addEventListener('click', async () => {
    const input = $('#cd-pix-code');
    try { await navigator.clipboard.writeText(input.value); }
    catch { input.select(); document.execCommand?.('copy'); }
    btn.textContent = 'Copiado!';
    setTimeout(() => { btn.textContent = 'Copiar'; }, 1800);
  });
}

function setupActions() {
  const buttons = $$('[data-outcome]');
  const errBox = $('#cd-pay-error');
  for (const btn of buttons) {
    btn.addEventListener('click', async () => {
      errBox.hidden = true;
      buttons.forEach((b) => { b.disabled = true; });
      btn.setAttribute('aria-busy', 'true');
      try {
        const r = await fetch('/api/demo-pay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref, outcome: btn.dataset.outcome }),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && typeof data.redirect === 'string' && data.redirect.startsWith('/obrigado?')) {
          location.assign(data.redirect);
          return;
        }
        if (data.error === 'invalid_ref') return showError('Este link de pagamento expirou. Inicie a compra novamente.');
        throw new Error(data.error || `HTTP ${r.status}`);
      } catch {
        errBox.textContent = 'Não foi possível simular o pagamento agora. Tente novamente em instantes.';
        errBox.hidden = false;
      } finally {
        btn.removeAttribute('aria-busy');
        buttons.forEach((b) => { b.disabled = false; });
      }
    });
  }
}

async function init() {
  if (!ref) return showError('Nenhum pedido informado. Escolha um plano para iniciar a compra.');
  let r;
  try {
    r = await fetch('/api/demo-pay?ref=' + encodeURIComponent(ref), { headers: { Accept: 'application/json' } });
  } catch {
    return showError('Não foi possível carregar o pedido. Verifique sua conexão e tente novamente.');
  }
  if (r.status === 404) return showError('O checkout de demonstração não está disponível neste ambiente.');
  if (!r.ok) return showError();
  const order = await r.json();

  fill('productName', order.productName);
  fill('planName', order.planName);
  fill('billing', `Pré-pago · 1 ${order.interval} de uso (sem renovação automática)`);
  fill('customerName', order.customer?.name || '—');
  fill('customerEmail', order.customer?.email || '—');
  fill('customerCompany', order.customer?.company || '—');
  $('#cd-company-row').hidden = !order.customer?.company;
  fill('amount', order.amount);
  fill('interval', `/${order.interval}`);
  fill('installment', `1x de ${order.amount} sem juros`);
  fill('ref', order.externalReference.split(':').pop().slice(0, 8).toUpperCase());
  fill('expires', new Date(order.expiresAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
  document.title = `Pagamento ${order.productName} (demonstração) — Aqta`;

  $('#cd-qr').innerHTML = fakeQrSvg(order.externalReference);
  $('#cd-pix-code').value = fakePixCode(order);

  setupTabs();
  setupCopy();
  setupActions();
  show('cd-checkout');
}

init();
