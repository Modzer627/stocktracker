// Item detail: stock actions, details, movement history, delete.
import { applyStockChange } from '../db.js';
import { getItem, deleteItem, isLow } from '../items.js';
import { itemHistory } from '../txns.js';
import { esc, fmtQty, fmtDateTime, toast, confirmDialog, sheet } from '../ui.js';
import * as nav from '../nav.js';
import { openUseSheet, openItemForm, openQtySheet } from './sheets.js';

const section = () => document.getElementById('screen-item');
let currentId = null;

const TYPE_ICON = { in: '+', out: '−', adjust: '≡' };

function txnRow(t) {
  const pos = t.delta > 0;
  const bits = [];
  if (t.job) bits.push(`Job: ${esc(t.job)}`);
  if (t.note) bits.push(esc(t.note));
  return `
    <div class="txn-row">
      <div class="txn-ico ${t.type}">${TYPE_ICON[t.type] || '·'}</div>
      <div class="txn-main">
        <div>${t.type === 'in' ? 'Stock in' : t.type === 'out' ? 'Used' : 'Adjusted'}</div>
        <div class="txn-sub">${fmtDateTime(t.ts)}${bits.length ? ' · ' + bits.join(' · ') : ''}</div>
      </div>
      <div class="txn-delta ${pos ? 'pos' : 'neg'}">${pos ? '+' : ''}${fmtQty(t.delta)}</div>
    </div>`;
}

async function render() {
  const sec = section();
  const item = await getItem(currentId);
  if (!item) { nav.back(); return; }
  const history = await itemHistory(item.id, 60);
  const low = isLow(item);

  const detailBits = [
    item.barcode ? `<b>Barcode:</b> ${esc(item.barcode)}` : '',
    item.category ? `<b>Category:</b> ${esc(item.category)}` : '',
    item.location ? `<b>Location:</b> ${esc(item.location)}` : '',
    `<b>Min stock:</b> ${fmtQty(item.minQty)} ${esc(item.unit)}`,
    item.notes ? `<b>Notes:</b> ${esc(item.notes)}` : '',
  ].filter(Boolean);

  sec.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-back aria-label="Back">←</button>
      <h1>${esc(item.name)}<span class="sub">${item.category ? esc(item.category) : 'Item'}</span></h1>
      <button class="icon-btn" data-edit aria-label="Edit">✎</button>
    </header>
    <div class="content">
      <div class="item-row${low ? ' low' : ''}" style="margin-bottom:14px">
        <div class="item-main">
          <div class="item-name">In stock${low ? ' · <span class="low-tag">LOW</span>' : ''}</div>
          <div class="item-sub">Alert when ≤ ${fmtQty(item.minQty)}</div>
        </div>
        <div class="item-qty"><div class="q${item.qty < 0 ? ' neg' : ''}" style="font-size:26px">${fmtQty(item.qty)}</div><div class="u">${esc(item.unit)}</div></div>
      </div>

      <div class="sheet-actions" style="margin:0 0 16px">
        <button class="btn" data-in>+ Add stock</button>
        <button class="btn" data-use>− Use</button>
        <button class="btn" data-adjust>Set qty</button>
      </div>

      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:12px 14px;font-size:14px;line-height:1.8;margin-bottom:16px">
        ${detailBits.join('<br>')}
      </div>

      <div class="section-title">History</div>
      ${history.length ? history.map(txnRow).join('') : '<div class="empty">No movements yet.</div>'}

      <button class="btn btn-block" data-delete style="margin-top:22px;color:var(--danger)">Delete item</button>
    </div>`;

  sec.querySelector('[data-back]').addEventListener('click', () => nav.back());
  sec.querySelector('[data-edit]').addEventListener('click', () =>
    openItemForm({ item, onSaved: (u) => { if (u) render(); } }));
  sec.querySelector('[data-in]').addEventListener('click', () =>
    openQtySheet({
      title: `Add stock — <span class="sheet-item-name">${esc(item.name)}</span>`,
      okLabel: 'Add',
      initial: 1,
      onDone: async (qty) => {
        if (qty === null) return;
        const u = await applyStockChange({ itemId: item.id, delta: qty, type: 'in' });
        toast(`+${fmtQty(qty)} → now ${fmtQty(u.qty)} ${u.unit}`);
        render();
      },
    }));
  sec.querySelector('[data-use]').addEventListener('click', () =>
    openUseSheet(item, { onDone: (u) => { if (u) render(); } }));
  sec.querySelector('[data-adjust]').addEventListener('click', () => openAdjustSheet(item));
  sec.querySelector('[data-delete]').addEventListener('click', async () => {
    const yes = await confirmDialog(`Delete "${item.name}"? Its history stays in the usage log, but the item and its count are removed.`, { danger: true, okLabel: 'Delete' });
    if (!yes) return;
    await deleteItem(item.id);
    toast(`Deleted ${item.name}`);
    nav.back();
  });
}

const ADJUST_REASONS = ['Correction', 'Damaged', 'Lost', 'Found', 'Returned'];

function openAdjustSheet(item) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="field">
      <label>New quantity (currently ${fmtQty(item.qty)} ${esc(item.unit)})</label>
      <div class="qty-stepper">
        <button type="button" data-step="-1">−</button>
        <input type="text" inputmode="decimal" value="${esc(fmtQty(item.qty))}" data-qty>
        <button type="button" data-step="1">+</button>
      </div>
    </div>
    <div class="field">
      <label>Reason</label>
      <input type="text" data-reason autocomplete="off" placeholder="Why the change?">
      <div class="chips">${ADJUST_REASONS.map(r => `<button type="button" class="chip" data-chip-r>${r}</button>`).join('')}</div>
    </div>
    <div class="sheet-actions">
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button type="button" class="btn btn-primary" data-ok>Set quantity</button>
    </div>`;
  const s = sheet({ title: `Set quantity — <span class="sheet-item-name">${esc(item.name)}</span>`, content: wrap });
  const input = wrap.querySelector('[data-qty]');
  wrap.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
    const cur = parseFloat(input.value.replace(',', '.')) || 0;
    input.value = fmtQty(Math.max(0, cur + Number(b.dataset.step)));
  }));
  const reason = wrap.querySelector('[data-reason]');
  wrap.querySelectorAll('[data-chip-r]').forEach(c => c.addEventListener('click', () => { reason.value = c.textContent; }));
  wrap.querySelector('[data-cancel]').addEventListener('click', () => s.close());
  wrap.querySelector('[data-ok]').addEventListener('click', async () => {
    const newQty = parseFloat(input.value.replace(',', '.'));
    if (Number.isNaN(newQty)) { toast('Enter a quantity', { error: true }); return; }
    const delta = Math.round((newQty - item.qty) * 1000) / 1000;
    s.close();
    if (delta === 0) return;
    const u = await applyStockChange({ itemId: item.id, delta, type: 'adjust', note: reason.value.trim() || 'Manual adjustment' });
    toast(`Quantity set to ${fmtQty(u.qty)} ${u.unit}`);
    render();
  });
}

export default {
  show(params) {
    currentId = params.id;
    return render();
  },
};
