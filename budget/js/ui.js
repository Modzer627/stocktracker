// Small DOM/UI toolkit: templates, toasts, bottom sheets, money formatting.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------- money (integer cents everywhere) ---------- */

export function fmtMoney(cents, { sign = false } = {}) {
  const n = Number(cents) || 0;
  const abs = Math.abs(n) / 100;
  const s = abs.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  if (sign && n > 0) return '+' + s;
  return (n < 0 ? '−' : '') + s;
}

/** "12.34", "$1,234.56", "1234" → integer cents; null when unparseable. */
export function parseMoney(str) {
  const cleaned = String(str ?? '').replace(/[$,\s]/g, '');
  if (!cleaned || !/^-?\d*\.?\d*$/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}

/* ---------- dates ---------- */

export function isoDate(ts = Date.now()) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 'YYYY-MM' month key of a 'YYYY-MM-DD' date string (or today). */
export function monthKey(date = isoDate()) {
  return String(date).slice(0, 7);
}

export function monthLabel(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/** Shift a 'YYYY-MM' key by n months. */
export function shiftMonth(ym, n) {
  const [y, m] = String(ym).split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}

export function fmtDate(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/* ---------- toast ---------- */
let toastTimer = null;
export function toast(msg, { error = false, action = null, actionLabel = 'OK', duration = 2600 } = {}) {
  const root = $('#toast-root');
  root.innerHTML = '';
  const t = document.createElement('div');
  t.className = 'toast' + (error ? ' err' : '');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn btn-sm';
    b.textContent = actionLabel;
    b.addEventListener('click', () => { root.innerHTML = ''; action(); });
    t.appendChild(b);
    duration = Math.max(duration, 5000);
  }
  root.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (t.parentNode) t.remove(); }, duration);
}

/* ---------- bottom sheet ---------- */
export function sheet({ title = '', content, onClose = null }) {
  const root = $('#sheet-root');
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  const panel = document.createElement('div');
  panel.className = 'sheet';
  panel.innerHTML = `<div class="sheet-grip"></div>` + (title ? `<h2>${title}</h2>` : '');
  if (typeof content === 'string') panel.insertAdjacentHTML('beforeend', content);
  else if (content) panel.appendChild(content);
  overlay.appendChild(panel);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  root.appendChild(overlay);
  return { close, panel };
}

export function confirmDialog(msg, { danger = false, okLabel = 'Confirm', title = '' } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'confirm-box';
    wrap.innerHTML = `<p>${esc(msg)}</p>`;
    const actions = document.createElement('div');
    actions.className = 'sheet-actions';
    const no = document.createElement('button');
    no.className = 'btn';
    no.textContent = 'Cancel';
    const yes = document.createElement('button');
    yes.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    yes.textContent = okLabel;
    actions.append(no, yes);
    wrap.appendChild(actions);
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    const s = sheet({ title, content: wrap, onClose: () => done(false) });
    no.addEventListener('click', () => s.close());
    yes.addEventListener('click', () => { done(true); s.close(); });
  });
}
