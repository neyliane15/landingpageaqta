import { loadSupport, applySupportLinks } from './support.js';

// Aqta · landing page — menu mobile, header ao rolar, scroll reveal, link ativo,
// FAQ acessível, preços do catálogo e envio do formulário de sistema personalizado.

const header = document.querySelector('.lp-header');
const menuBtn = document.querySelector('.lp-menu-btn');
const nav = document.getElementById('lp-nav');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------ menu mobile */
function setMenu(open) {
  if (!header || !menuBtn) return;
  header.classList.toggle('is-open', open);
  menuBtn.setAttribute('aria-expanded', String(open));
  menuBtn.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
  document.documentElement.style.overflow = open ? 'hidden' : '';
}
if (menuBtn && nav) {
  menuBtn.addEventListener('click', () => setMenu(menuBtn.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) setMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && header.classList.contains('is-open')) {
      setMenu(false);
      menuBtn.focus();
    }
  });
  // clique fora fecha
  document.addEventListener('click', (e) => {
    if (header.classList.contains('is-open') && !header.contains(e.target)) setMenu(false);
  });
  // ao voltar para desktop, garante menu fechado
  window.matchMedia('(min-width: 961px)').addEventListener('change', (m) => m.matches && setMenu(false));
}

/* ------------------------------------------------------- header ao rolar */
if (header) {
  const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

/* ---------------------------------------------------------- scroll reveal */
const reveals = [...document.querySelectorAll('.reveal')];
if (!('IntersectionObserver' in window) || reduceMotion) {
  reveals.forEach((el) => el.classList.add('is-visible'));
} else {
  // escalonamento suave entre irmãos (cards em grade)
  reveals.forEach((el) => {
    const sibs = [...el.parentElement.children].filter((c) => c.classList.contains('reveal'));
    const i = sibs.indexOf(el);
    if (sibs.length > 1 && i > 0) el.style.setProperty('--reveal-delay', `${Math.min(i, 6) * 70}ms`);
  });
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          en.target.classList.add('is-visible');
          io.unobserve(en.target);
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  );
  reveals.forEach((el) => io.observe(el));
}

/* -------------------------------------------------- destaque do link ativo */
const links = [...document.querySelectorAll('.lp-nav__link[href^="#"]')];
const sections = links.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
if (sections.length && 'IntersectionObserver' in window) {
  const visible = new Map();
  const spy = new IntersectionObserver(
    (entries) => {
      entries.forEach((en) => visible.set(en.target.id, en.isIntersecting ? en.intersectionRatio : 0));
      let best = null;
      let bestRatio = 0;
      for (const s of sections) {
        const r = visible.get(s.id) || 0;
        if (r > bestRatio) { best = s.id; bestRatio = r; }
      }
      links.forEach((a) => {
        const on = best && a.getAttribute('href') === `#${best}`;
        a.classList.toggle('is-active', Boolean(on));
        if (on) a.setAttribute('aria-current', 'location');
        else a.removeAttribute('aria-current');
      });
    },
    { rootMargin: '-35% 0px -55% 0px', threshold: [0, 0.01, 0.25, 0.5, 1] },
  );
  sections.forEach((s) => spy.observe(s));
}

/* --------------------------------------------------------------------- FAQ */
document.querySelectorAll('[data-faq]').forEach((faq) => {
  const buttons = [...faq.querySelectorAll('.lp-faq__q')];
  const toggle = (btn, open) => {
    const panel = document.getElementById(btn.getAttribute('aria-controls'));
    btn.setAttribute('aria-expanded', String(open));
    if (!panel) return;
    panel.hidden = !open;
    if (open && !reduceMotion) {
      panel.classList.remove('is-anim');
      void panel.offsetWidth;
      panel.classList.add('is-anim');
    }
  };
  buttons.forEach((btn, i) => {
    btn.addEventListener('click', () => toggle(btn, btn.getAttribute('aria-expanded') !== 'true'));
    btn.addEventListener('keydown', (e) => {
      const go = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: buttons.length - 1 }[e.key];
      if (go === undefined) return;
      e.preventDefault();
      buttons[(go + buttons.length) % buttons.length].focus();
    });
  });
});

/* ------------------------------------------------- preços vindos do servidor */
(async () => {
  try {
    const res = await fetch('/api/catalog', { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const data = await res.json();
    for (const p of data.products || []) {
      const plan = (p.plans || []).find((x) => x.id === 'basico') || (p.plans || [])[0];
      if (!plan || !plan.price) continue;
      const label = String(plan.price).replace(/,00$/, '');
      document.querySelectorAll(`[data-price="${p.id}"]`).forEach((el) => { el.textContent = label; });
    }
  } catch { /* mantém os valores escritos no HTML */ }
})();

/* ------------------------------------- WhatsApp da Aqta (rodapé, FAQ, sob medida) */
loadSupport().then(() => applySupportLinks(document));

/* ----------------------------------------------------------- ano no rodapé */
document.querySelectorAll('[data-year]').forEach((el) => { el.textContent = String(new Date().getFullYear()); });

/* ------------------------------------------- formulário de sistema sob medida */
const form = document.getElementById('lead-form');
if (form) {
  const status = document.getElementById('lead-status');
  const submit = form.querySelector('button[type="submit"]');
  const submitLabel = submit ? submit.textContent : '';
  const FIELDS = ['name', 'email', 'whatsapp', 'company', 'message'];

  const setError = (name, msg) => {
    const input = form.elements[name];
    const err = document.getElementById(`lead-${name}-error`);
    if (!input) return;
    input.closest('.field')?.classList.toggle('has-error', Boolean(msg));
    if (msg) {
      input.setAttribute('aria-invalid', 'true');
      if (err) {
        err.textContent = msg;
        input.setAttribute('aria-describedby', err.id);
      }
    } else {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
      if (err) err.textContent = '';
    }
  };

  const validate = (v) => {
    const e = {};
    if (v.name.trim().length < 3) e.name = 'Informe seu nome (mínimo 3 letras).';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email.trim())) e.email = 'Informe um e-mail válido.';
    const digits = v.whatsapp.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13) e.whatsapp = 'Informe o WhatsApp com DDD.';
    if (v.message.trim().length < 10) e.message = 'Conte um pouco do que você precisa (mínimo 10 caracteres).';
    return e;
  };

  // O conteúdo vai num <div> próprio: .alert é flex e, sem o wrapper, texto e botão viravam colunas (BUG-4).
  const showStatus = (kind, html) => {
    status.innerHTML = `<div class="alert alert--${kind}"><div>${html}</div></div>`;
  };
  const safeWa = (u) => (u && /^https:\/\/(wa\.me|api\.whatsapp\.com)\//.test(u) ? u : '');

  // máscara leve de telefone
  const wa = form.elements.whatsapp;
  wa?.addEventListener('input', () => {
    let d = wa.value.replace(/\D/g, '');
    if (d.startsWith('55') && d.length > 11) d = d.slice(2);
    d = d.slice(0, 11);
    let out = d;
    if (d.length > 2) out = `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length > 6) out = `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
    wa.value = out;
  });

  FIELDS.forEach((n) => form.elements[n]?.addEventListener('input', () => setError(n, '')));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const values = Object.fromEntries(FIELDS.map((n) => [n, form.elements[n]?.value || '']));
    values.website = form.elements.website?.value || '';

    const errors = validate(values);
    FIELDS.forEach((n) => setError(n, errors[n]));
    const first = FIELDS.find((n) => errors[n]);
    if (first) {
      status.innerHTML = '';
      form.elements[first].focus();
      return;
    }

    submit.setAttribute('aria-busy', 'true');
    submit.disabled = true;
    submit.textContent = 'Enviando…';
    showStatus('warn', 'Enviando seu pedido…');

    try {
      const res = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(values),
      });
      let data = {};
      try { data = await res.json(); } catch { /* resposta sem JSON */ }

      if (res.ok && data.ok) {
        form.reset();
        const waLink = safeWa(data.whatsappUrl);
        showStatus(
          'ok',
          `<strong>Pedido enviado!</strong> A equipe Aqta vai responder em até 1 dia útil.` +
            (waLink
              ? `<br>Quer adiantar a conversa? <a class="btn btn--primary btn--sm" href="${waLink.replace(/"/g, '&quot;')}" target="_blank" rel="noopener">Continuar no WhatsApp</a>`
              : ''),
        );
        status.querySelector('a')?.focus();
        return;
      }

      if (res.status === 400 && data.fields) {
        Object.entries(data.fields).forEach(([n, msg]) => setError(n, String(msg)));
        showStatus('err', 'Confira os campos destacados e tente novamente.');
        const f = FIELDS.find((n) => data.fields[n]);
        if (f) form.elements[f].focus();
        return;
      }
      if (res.status === 429) {
        const waLink = safeWa(data.whatsappUrl);
        showStatus('err', 'Muitos envios seguidos. Aguarde um minuto e tente de novo.' +
          (waLink ? `<br><a class="btn btn--ghost btn--sm" href="${waLink.replace(/"/g, '&quot;')}" target="_blank" rel="noopener">Falar agora no WhatsApp</a>` : ''));
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch {
      showStatus('err', 'Não foi possível enviar agora. Verifique sua conexão e tente novamente em instantes.');
    } finally {
      submit.removeAttribute('aria-busy');
      submit.disabled = false;
      submit.textContent = submitLabel;
    }
  });
}
