// Scan screen. Modes: in / out / lookup, plus 'count' when opened from a stocktake.
import { applyStockChange, metaGet, metaSet } from '../db.js';
import { getByBarcode, getItem } from '../items.js';
import { Scanner, scanImage } from '../scanner.js';
import { getSession, saveSession, tally, setCount } from '../stocktake.js';
import { esc, fmtQty, toast, beep, buzz } from '../ui.js';
import * as nav from '../nav.js';
import { openUseSheet, openItemForm, openQtySheet } from './sheets.js';

const section = () => document.getElementById('screen-scan');
const ui = () => document.getElementById('scan-ui');
const video = () => document.getElementById('scan-video');

let scanner = null;
let mode = 'in';
let countMode = false;
let session = null;
let lastItem = null;
let wakeLock = null;
let visHandler = null;

const MODE_LABELS = { in: 'Stock In', out: 'Stock Out', lookup: 'Lookup' };

function render() {
  ui().innerHTML = `
    <div class="scan-top">
      <button class="icon-btn" data-close aria-label="Close">✕</button>
      ${countMode ? `
        <div class="seg" style="pointer-events:none"><button class="on">Counting stock</button></div>
        <button class="btn btn-sm btn-primary" data-review>Review</button>
      ` : `
        <div class="seg">
          ${Object.entries(MODE_LABELS).map(([m, label]) =>
            `<button data-mode="${m}" class="${m === mode ? 'on' : ''}">${label}</button>`).join('')}
        </div>
      `}
    </div>
    <div class="reticle"></div>
    <div class="scan-bottom">
      <div class="scan-chip" data-chip></div>
      <div class="scan-controls">
        <button class="icon-btn" data-flip aria-label="Flip camera">🔄</button>
        <button class="icon-btn" data-torch aria-label="Torch" hidden>🔦</button>
        <label class="icon-btn" aria-label="Scan from photo">🖼<input type="file" accept="image/*" data-photo hidden></label>
      </div>
      <div class="scan-msg" data-msg>Point the camera at a barcode</div>
    </div>`;
  wire();
}

function wire() {
  const root = ui();
  root.querySelector('[data-close]').addEventListener('click', () => nav.back());
  root.querySelector('[data-review]')?.addEventListener('click', () => nav.show('review'));
  root.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', async () => {
    mode = b.dataset.mode;
    lastItem = null;
    setChip('');
    await metaSet('lastScanMode', mode);
    root.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x.dataset.mode === mode));
  }));
  root.querySelector('[data-flip]').addEventListener('click', async () => {
    try {
      const facing = await scanner.flip();
      await metaSet('cameraFacing', facing);
      updateTorchButton();
    } catch (e) {
      showCameraError(e);
    }
  });
  root.querySelector('[data-torch]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const on = !btn.classList.contains('on');
    if (await scanner.setTorch(on)) btn.classList.toggle('on', on);
  });
  root.querySelector('[data-photo]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setMsg('Reading photo…');
    try {
      const codes = await scanImage(file);
      if (!codes.length) { toast('No barcode found in that photo', { error: true }); setMsg('Point the camera at a barcode'); return; }
      await handleCode(codes[0].rawValue);
    } catch {
      toast('Could not read that photo', { error: true });
    }
    setMsg('Point the camera at a barcode');
  });
  root.querySelector('[data-chip]').addEventListener('click', onChipTap);
}

function setChip(html) {
  const chip = ui().querySelector('[data-chip]');
  if (!chip) return;
  chip.innerHTML = html;
  chip.classList.toggle('show', !!html);
}
function setMsg(text) {
  const m = ui().querySelector('[data-msg]');
  if (m) m.textContent = text;
}
function flashReticle() {
  const r = ui().querySelector('.reticle');
  if (!r) return;
  r.classList.add('hit');
  setTimeout(() => r.classList.remove('hit'), 220);
}

function feedback(ok = true) {
  beep(ok);
  buzz(ok ? 40 : 120);
  flashReticle();
}

function updateTorchButton() {
  const btn = ui().querySelector('[data-torch]');
  if (btn) { btn.hidden = !scanner.hasTorch(); btn.classList.remove('on'); }
}

async function handleCode(code) {
  const item = await getByBarcode(code);

  if (countMode) {
    if (!item) {
      feedback(false);
      toast(`Unknown barcode ${code}`, {
        actionLabel: 'Add item',
        action: () => withPausedScanner(done => openItemForm({
          prefill: { barcode: code, qty: 0 },
          onSaved: async (created) => {
            if (created) {
              const n = tally(session, created.id, 1);
              await saveSession(session);
              setChip(`<b>${esc(created.name)}</b>&nbsp;— counted ${fmtQty(n)}`);
            }
            done();
          },
        })),
      });
      return;
    }
    feedback(true);
    const n = tally(session, item.id, 1);
    await saveSession(session);
    lastItem = item;
    setChip(`<b>${esc(item.name)}</b>&nbsp;— counted ${fmtQty(n)} <span style="opacity:.7">(tap to set exact)</span>`);
    return;
  }

  if (mode === 'lookup') {
    if (!item) { feedback(false); setChip(`No item with barcode <b>${esc(code)}</b>`); return; }
    feedback(true);
    lastItem = item;
    setChip(`<b>${esc(item.name)}</b>&nbsp;· ${fmtQty(item.qty)} ${esc(item.unit)}${item.minQty ? ` · min ${fmtQty(item.minQty)}` : ''}${item.location ? ` · ${esc(item.location)}` : ''}`);
    return;
  }

  if (mode === 'in') {
    if (!item) {
      feedback(false);
      withPausedScanner(done => openItemForm({
        prefill: { barcode: code, qty: 1 },
        onSaved: (created) => {
          if (created) setChip(`<b>${esc(created.name)}</b>&nbsp;added · ${fmtQty(created.qty)} ${esc(created.unit)}`);
          done();
        },
      }));
      return;
    }
    feedback(true);
    const updated = await applyStockChange({ itemId: item.id, delta: 1, type: 'in' });
    lastItem = updated;
    setChip(`<b>${esc(updated.name)}</b>&nbsp;+1 → ${fmtQty(updated.qty)} ${esc(updated.unit)} <span style="opacity:.7">(tap for more)</span>`);
    return;
  }

  if (mode === 'out') {
    if (!item) {
      feedback(false);
      toast(`Barcode ${code} is not in your inventory`, {
        actionLabel: 'Add item',
        action: () => withPausedScanner(done => openItemForm({ prefill: { barcode: code, qty: 0 }, onSaved: () => done() })),
      });
      return;
    }
    feedback(true);
    lastItem = item;
    withPausedScanner(done => openUseSheet(item, {
      onDone: (updated) => {
        if (updated) setChip(`<b>${esc(updated.name)}</b>&nbsp;→ ${fmtQty(updated.qty)} ${esc(updated.unit)}`);
        done();
      },
    }));
  }
}

function onChipTap() {
  if (!lastItem) return;
  if (countMode) {
    const current = session.counts[lastItem.id] ?? 0;
    withPausedScanner(done => openQtySheet({
      title: `Set count — <span class="sheet-item-name">${esc(lastItem.name)}</span>`,
      okLabel: 'Set count',
      initial: current,
      onDone: async (qty) => {
        if (qty !== null) {
          setCount(session, lastItem.id, qty);
          await saveSession(session);
          setChip(`<b>${esc(lastItem.name)}</b>&nbsp;— counted ${fmtQty(qty)}`);
        }
        done();
      },
    }));
  } else if (mode === 'in') {
    withPausedScanner(done => openQtySheet({
      title: `Add more — <span class="sheet-item-name">${esc(lastItem.name)}</span>`,
      okLabel: 'Add stock',
      initial: 1,
      onDone: async (qty) => {
        if (qty !== null) {
          const updated = await applyStockChange({ itemId: lastItem.id, delta: qty, type: 'in' });
          lastItem = updated;
          setChip(`<b>${esc(updated.name)}</b>&nbsp;+${fmtQty(qty)} → ${fmtQty(updated.qty)} ${esc(updated.unit)}`);
        }
        done();
      },
    }));
  } else if (mode === 'lookup' && lastItem) {
    nav.show('item', { id: lastItem.id });
  }
}

/** Pause code handling while a sheet is up, resume (with warmup) after. */
function withPausedScanner(fn) {
  scanner.pause();
  let resumed = false;
  const done = () => { if (!resumed) { resumed = true; scanner.resume(); } };
  fn(done);
}

async function acquireWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { wakeLock = null; }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* already released */ }
  wakeLock = null;
}

function showCameraError(e) {
  const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
  ui().querySelector('.reticle')?.insertAdjacentHTML('afterend', '');
  setChip('');
  setMsg('');
  const msgEl = ui().querySelector('[data-msg]');
  if (msgEl) {
    msgEl.innerHTML = denied
      ? 'Camera access was blocked. Allow the camera for this app in your phone settings, or use the photo button.'
      : `Camera unavailable (${esc(e && e.name || 'error')}). You can still scan from a photo, or add items manually.`;
  }
  toast(denied ? 'Camera permission needed' : 'Could not start the camera', { error: true });
}

export default {
  async show(params = {}) {
    countMode = params.mode === 'count';
    session = countMode ? await getSession() : null;
    if (countMode && !session) { toast('No stocktake in progress', { error: true }); nav.back(); return; }
    mode = countMode ? 'in' : await metaGet('lastScanMode', 'in');
    if (!MODE_LABELS[mode]) mode = 'in';
    lastItem = null;
    render();

    scanner = scanner || new Scanner(video());
    scanner.onCode = (value) => { handleCode(value); };
    scanner.onError = () => { /* per-frame decode hiccups are normal */ };

    const facing = await metaGet('cameraFacing', 'environment');
    try {
      await scanner.start(facing);
      updateTorchButton();
    } catch (e) {
      showCameraError(e);
    }
    acquireWakeLock();

    visHandler = async () => {
      if (document.hidden) {
        scanner.stop();
        releaseWakeLock();
      } else if (nav.currentScreen() === 'scan') {
        try { await scanner.start(await metaGet('cameraFacing', 'environment')); updateTorchButton(); } catch (e) { showCameraError(e); }
        acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', visHandler);
  },

  async hide() {
    if (visHandler) { document.removeEventListener('visibilitychange', visHandler); visHandler = null; }
    if (scanner) scanner.stop();
    releaseWakeLock();
    if (countMode && session) await saveSession(session);
  },
};
