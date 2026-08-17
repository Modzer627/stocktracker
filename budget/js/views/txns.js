// Activity: transactions for a month, filterable by category, tap to edit.
import { $, esc, fmtMoney, monthKey, monthLabel, shiftMonth, fmtDate } from '../ui.js';
import * as nav from '../nav.js';
import { txnsForMonth } from '../txns.js';
import { allCategories } from '../categories.js';
import { hydrateThumbs } from '../receipts.js';
import { openExpenseSheet, openAddSheet } from './sheets.js';

let month = monthKey();
let filterCat = null;

const view = {
  async show(params = {}) {
    if (params.month) month = params.month;
    if ('categoryId' in params) filterCat = params.categoryId || null;
    await render();
  },
  async refresh() { if (nav.currentScreen() === 'txns') await render(); },
  hide() {},
};
export default view;

async function render() {
  const root = $('#screen-txns');
  const [cats, txns] = await Promise.all([allCategories({ includeArchived: true }), txnsForMonth(month)]);
  const catMap = new Map(cats.map(c => [c.id, c]));
  const rows = filterCat ? txns.filter(t => t.categoryId === filterCat) : txns;
  const total = rows.reduce((s, t) => s + t.amountCents, 0);

  const byDay = [];
  for (const t of rows) {
    let day = byDay[byDay.length - 1];
    if (!day || day.date !== t.date) { day = { date: t.date, txns: [] }; byDay.push(day); }
    day.txns.push(t);
  }

  const usedCatIds = [...new Set(txns.map(t => t.categoryId))];
  root.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-role="back" aria-label="Back">←</button>
      <h1>Activity <span class="sub">${fmtMoney(total)} · ${rows.length} item${rows.length === 1 ? '' : 's'}</span></h1>
      <div class="month-nav">
        <button class="icon-btn" data-m="-1" aria-label="Previous month">‹</button>
        <span class="month-label">${esc(monthLabel(month))}</span>
        <button class="icon-btn" data-m="1" aria-label="Next month">›</button>
      </div>
    </header>
    <div class="content">
      <div class="chips" style="margin-bottom:6px">
        <button class="chip ${!filterCat ? 'on' : ''}" data-f="">All</button>
        ${usedCatIds.map(id => {
          const c = catMap.get(id);
          return `<button class="chip ${filterCat === id ? 'on' : ''}" data-f="${esc(id)}">${esc(c ? `${c.icon || ''} ${c.name}` : 'Uncategorized')}</button>`;
        }).join('')}
      </div>
      ${byDay.length ? byDay.map(day => `
        <div class="day-head">${esc(fmtDate(day.date))}</div>
        ${day.txns.map(t => {
          const c = catMap.get(t.categoryId);
          return `
          <div class="txn-row" data-id="${esc(t.id)}" style="cursor:pointer">
            ${t.photo
              ? `<div class="thumb" data-photo-key="${esc(t.photo)}">🧾</div>`
              : `<div class="thumb">${esc(c?.icon || '💵')}</div>`}
            <div class="txn-main">${esc(t.merchant || c?.name || 'Expense')}
              ${t.splitGroup ? '<span class="split-tag">SPLIT</span>' : ''}
              <div class="txn-sub">${esc(c?.name || 'Uncategorized')}${t.enteredBy && t.enteredBy !== 'auto' ? ` · ${esc(t.enteredBy)}` : ''}${t.source === 'recurring' ? ' · auto' : ''}${t.note ? ` · ${esc(t.note)}` : ''}</div>
            </div>
            <span class="txn-amt">${fmtMoney(t.amountCents)}</span>
          </div>`;
        }).join('')}`).join('') : `
        <div class="empty"><span class="big">🧾</span>No spending recorded${filterCat ? ' in this category' : ''} for ${esc(monthLabel(month))}.</div>`}
    </div>
    <nav class="actionbar">
      <button class="btn btn-primary" data-role="add"><span class="ico">＋</span>Add expense</button>
    </nav>`;

  hydrateThumbs(root);
  $('[data-role="back"]', root).addEventListener('click', () => nav.back());
  root.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => {
    month = shiftMonth(month, Number(b.dataset.m));
    render();
  }));
  root.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => {
    filterCat = b.dataset.f || null;
    render();
  }));
  $('[data-role="add"]', root).addEventListener('click', () => openAddSheet({ onDone: render }));
  root.querySelectorAll('[data-id]').forEach(r => r.addEventListener('click', async () => {
    const { getTxn } = await import('../txns.js');
    const t = await getTxn(r.dataset.id);
    if (t) openExpenseSheet({ txn: t, onDone: render });
  }));
}
