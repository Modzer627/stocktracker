// Shared bottom-sheet flows: use-on-job, quantity entry, item create/edit form.
import { applyStockChange } from '../db.js';
import { createItem, updateItem, allItems, distinct } from '../items.js';
import { recentJobs, pushJob } from '../txns.js';
import { sheet, toast, esc, fmtQty } from '../ui.js';

function stepperHTML(initial = 1) {
  return `
    <div class="qty-stepper">
      <button type="button" data-step="-1">−</button>
      <input type="text" inputmode="decimal" value="${esc(fmtQty(initial))}" data-qty>
      <button type="button" data-step="1">+</button>
    </div>`;
}

function wireStepper(root, { min = 0.001 } = {}) {
  const input = root.querySelector('[data-qty]');
  root.querySelectorAll('[data-step]').forEach(b => {
    b.addEventListener('click', () => {
      const cur = parseFloat(input.value.replace(',', '.')) || 0;
      const next = Math.max(min, Math.round((cur + Number(b.dataset.step)) * 1000) / 1000);
      input.value = fmtQty(next);
    });
  });
  return () => Math.round((parseFloat(input.value.replace(',', '.')) || 0) * 1000) / 1000;
}

/** "Use item" — quantity + job. Writes the 'out' movement. */
export async function openUseSheet(item, { onDone = null } = {}) {
  const jobs = await recentJobs();
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    ${stepperHTML(1)}
    <div class="field">
      <label>Used for job</label>
      <input type="text" data-job placeholder="Job name / customer" autocomplete="off">
      <div class="chips">${jobs.map(j => `<button type="button" class="chip" data-jobchip>${esc(j)}</button>`).join('')}</div>
    </div>
    <div class="field">
      <label>Note (optional)</label>
      <input type="text" data-note autocomplete="off">
    </div>
    <div class="sheet-actions">
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button type="button" class="btn btn-primary" data-ok>Use stock</button>
    </div>`;
  const s = sheet({ title: `Use — <span class="sheet-item-name">${esc(item.name)} (${fmtQty(item.qty)} ${esc(item.unit)})</span>`, content: wrap, onClose: () => onDone && onDone(null) });
  const getQty = wireStepper(wrap);
  const jobInput = wrap.querySelector('[data-job]');
  wrap.querySelectorAll('[data-jobchip]').forEach(c => c.addEventListener('click', () => { jobInput.value = c.textContent; }));
  wrap.querySelector('[data-cancel]').addEventListener('click', () => s.close());
  wrap.querySelector('[data-ok]').addEventListener('click', async () => {
    const qty = getQty();
    if (!qty || qty <= 0) { toast('Enter a quantity', { error: true }); return; }
    const job = jobInput.value.trim();
    const note = wrap.querySelector('[data-note]').value.trim();
    try {
      const updated = await applyStockChange({ itemId: item.id, delta: -qty, type: 'out', job, note });
      await pushJob(job);
      const doneCb = onDone; onDone = null;
      s.close();
      toast(`Used ${fmtQty(qty)} ${updated.unit} — ${updated.name}${job ? ' · ' + job : ''} (now ${fmtQty(updated.qty)})`);
      if (updated.qty < 0) toast(`${updated.name} is negative — fix it with a stocktake`, { error: true, duration: 4000 });
      if (doneCb) doneCb(updated);
    } catch (e) {
      toast(e.message || 'Could not save', { error: true });
    }
  });
  setTimeout(() => jobInput.focus({ preventScroll: true }), 60);
}

/** Generic quantity sheet. onDone(qty) with qty > 0, or null when cancelled. */
export function openQtySheet({ title, okLabel = 'Save', initial = 1, onDone }) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    ${stepperHTML(initial)}
    <div class="sheet-actions">
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button type="button" class="btn btn-primary" data-ok>${esc(okLabel)}</button>
    </div>`;
  const s = sheet({ title, content: wrap, onClose: () => onDone && onDone(null) });
  const getQty = wireStepper(wrap);
  wrap.querySelector('[data-cancel]').addEventListener('click', () => s.close());
  wrap.querySelector('[data-ok]').addEventListener('click', () => {
    const qty = getQty();
    if (!qty || qty <= 0) { toast('Enter a quantity', { error: true }); return; }
    const doneCb = onDone; onDone = null;
    s.close();
    if (doneCb) doneCb(qty);
  });
}

const UNIT_SUGGESTIONS = ['pcs', 'box', 'pack', 'm', 'cm', 'L', 'mL', 'kg', 'g', 'roll', 'tube', 'bag', 'set'];

/**
 * Item form as a sheet. Modes: create (default), edit (pass `item`), or
 * mode:'request' — same fields, but submits an approval request to the manager
 * instead of creating the item locally.
 * opts: { item, prefill {barcode, ...}, mode, onSaved(itemOrNull), onRequested(id) }
 */
export async function openItemForm({ item = null, prefill = {}, mode = 'create', onSaved = null, onRequested = null } = {}) {
  const editing = !!item;
  const requesting = mode === 'request' && !editing;
  const v = (f, d = '') => esc(editing ? (item[f] ?? d) : (prefill[f] ?? d));
  const items = await allItems();
  const cats = distinct(items, 'category');
  const locs = distinct(items, 'location');
  const units = [...new Set([...UNIT_SUGGESTIONS, ...distinct(items, 'unit')])];

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="field">
      <label>Name *</label>
      <input type="text" data-f="name" value="${v('name')}" autocomplete="off">
    </div>
    <div class="field">
      <label>Barcode</label>
      <input type="text" data-f="barcode" value="${v('barcode')}" inputmode="numeric" autocomplete="off" placeholder="Scan or type — optional">
    </div>
    <div class="field-row">
      <div class="field">
        <label>${editing ? 'Quantity (use Adjust to change)' : requesting ? 'Starting quantity (requested)' : 'Starting quantity'}</label>
        <input type="text" data-f="qty" value="${editing ? esc(fmtQty(item.qty)) : esc(fmtQty(prefill.qty ?? 0))}" inputmode="decimal" ${editing ? 'disabled' : ''}>
      </div>
      <div class="field">
        <label>Min stock (alert at)</label>
        <input type="text" data-f="minQty" value="${editing ? esc(fmtQty(item.minQty)) : esc(fmtQty(prefill.minQty ?? 0))}" inputmode="decimal">
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Unit</label>
        <input type="text" data-f="unit" value="${v('unit', 'pcs')}" list="dl-units" autocomplete="off">
        <datalist id="dl-units">${units.map(u => `<option value="${esc(u)}">`).join('')}</datalist>
      </div>
      <div class="field">
        <label>Category</label>
        <input type="text" data-f="category" value="${v('category')}" list="dl-cats" autocomplete="off">
        <datalist id="dl-cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Location</label>
        <input type="text" data-f="location" value="${v('location')}" list="dl-locs" autocomplete="off" placeholder="Shelf, van, bin…">
        <datalist id="dl-locs">${locs.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
      </div>
      <div class="field">
        <label>Cost per unit ($)</label>
        <input type="text" data-f="cost" value="${v('cost')}" inputmode="decimal" autocomplete="off" placeholder="optional">
      </div>
    </div>
    <div class="field">
      <label>Notes</label>
      <textarea data-f="notes">${v('notes')}</textarea>
    </div>
    ${requesting ? `<p style="color:var(--text-dim);font-size:13px;line-height:1.5;margin:-4px 0 12px">New items need manager approval — this sends the details to your manager. You'll get a notification when it's decided.</p>` : ''}
    <div class="sheet-actions">
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button type="button" class="btn btn-primary" data-ok>${editing ? 'Save changes' : requesting ? 'Send request' : 'Add item'}</button>
    </div>`;

  const s = sheet({ title: editing ? 'Edit item' : requesting ? 'Request new item' : 'New item', content: wrap, onClose: () => onSaved && onSaved(null) });
  const read = () => {
    const out = {};
    wrap.querySelectorAll('[data-f]').forEach(i => { out[i.dataset.f] = i.value; });
    return out;
  };
  wrap.querySelector('[data-cancel]').addEventListener('click', () => s.close());
  wrap.querySelector('[data-ok]').addEventListener('click', async () => {
    const data = read();
    if (!data.name.trim()) { toast('Name is required', { error: true }); return; }
    try {
      if (requesting) {
        const { submitRequest } = await import('../requests.js');
        const id = await submitRequest({ ...data, qty: Number(String(data.qty).replace(',', '.')) || 0 });
        const reqCb = onRequested; onRequested = null; onSaved = null;
        s.close();
        toast(`Request sent — your manager will review "${data.name.trim()}"`, { duration: 4200 });
        if (reqCb) reqCb(id);
        return;
      }
      let saved;
      if (editing) {
        delete data.qty; // qty only changes through movements
        saved = await updateItem(item.id, data);
      } else {
        saved = await createItem(data);
      }
      const doneCb = onSaved; onSaved = null;
      s.close();
      toast(editing ? 'Saved' : `Added ${saved.name}`);
      if (doneCb) doneCb(saved);
    } catch (e) {
      toast(e.message || 'Could not save', { error: true });
    }
  });
  if (!editing && !prefill.name) {
    setTimeout(() => wrap.querySelector('[data-f="name"]').focus({ preventScroll: true }), 60);
  }
}
