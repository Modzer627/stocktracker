// Small DOM/UI toolkit: templates, toasts, bottom sheets, feedback sounds.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function fmtQty(n) {
  const v = Math.round((Number(n) || 0) * 1000) / 1000;
  return String(parseFloat(v.toFixed(3)));
}

export function fmtDateTime(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function isoDate(ts = Date.now()) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

/* ---------- audio / haptic feedback ---------- */
let audioCtx = null;
let soundEnabled = true;
export function setSoundEnabled(on) { soundEnabled = !!on; }

export function unlockAudio() {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* audio is best-effort */ }
}

export function beep(ok = true) {
  if (!soundEnabled || !audioCtx || audioCtx.state !== 'running') return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = ok ? 880 : 220;
    osc.type = 'square';
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.13);
  } catch { /* best-effort */ }
}

export function buzz(ms = 40) {
  try { navigator.vibrate && navigator.vibrate(ms); } catch { /* iOS has no vibrate */ }
}
