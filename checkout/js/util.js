// Small shared helpers: escaping, formatting, storage, toasts, sheets.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const fmtQty = (n) => {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  let h = d.getHours(); const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}
export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${DAYS[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()} ${fmtTime(d)}`;
}
export function fmtDay(d) {
  d = new Date(d);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
export function fmtDayFull(d) {
  d = new Date(d);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
/** "YYYY-MM-DD" (local) → "Thu, Apr 9". */
export function fmtIsoDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${DAYS[dt.getDay()]}, ${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
}
export function ago(iso) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Same matching key the server uses for part numbers. */
export function normalizePart(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, ' ').replace(/^[\s.,;:-]+|[\s.,;:-]+$/g, '').trim();
}

export const initials = (name) => String(name || '?').split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

/* localStorage with JSON and failure tolerance (private mode, quota) */
const PREFIX = 'partsCheckout:';
export const store = {
  get(key, def = null) {
    try { const v = localStorage.getItem(PREFIX + key); return v === null ? def : JSON.parse(v); } catch { return def; }
  },
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* ignore */ }
  },
  del(key) { try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ } },
};

export function toast(msg, { error = false, duration = 2600 } = {}) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

/** Bottom sheet / modal. `content` is an element or HTML string. Returns { el, close }. */
export function sheet({ title, content, onClose } = {}) {
  const root = document.getElementById('sheet-root') || document.body;
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const box = document.createElement('div');
  box.className = 'sheet';
  box.setAttribute('role', 'dialog');
  if (title) { const h = document.createElement('h3'); h.innerHTML = title; box.appendChild(h); }
  if (typeof content === 'string') { const d = document.createElement('div'); d.innerHTML = content; box.appendChild(d); }
  else if (content) box.appendChild(content);
  backdrop.appendChild(box);
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  root.appendChild(backdrop);
  return { el: box, close };
}

export function confirmDialog(message, { okLabel = 'OK', danger = false } = {}) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.innerHTML = `<p style="margin:0 0 4px;font-size:16px">${esc(message)}</p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okLabel)}</button>
      </div>`;
    const s = sheet({ content: wrap, onClose: () => resolve(false) });
    wrap.querySelector('[data-cancel]').addEventListener('click', () => s.close());
    wrap.querySelector('[data-ok]').addEventListener('click', () => { resolve(true); s.el.parentElement.remove(); });
  });
}

/** Load an external script once (used for the on-demand Excel and QR libraries). */
const loaded = new Map();
export function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { loaded.delete(src); reject(new Error(`Could not load ${src}`)); };
      document.head.appendChild(s);
    }));
  }
  return loaded.get(src);
}

/** Resize a photo to a JPEG blob small enough to store (≤ ~250 KB typically). */
export async function compressPhoto(file, { maxSide = 1280, quality = 0.8 } = {}) {
  let bmp;
  if (window.createImageBitmap) {
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { bmp = await createImageBitmap(file); }
  } else {
    bmp = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img); img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
  }
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
}
