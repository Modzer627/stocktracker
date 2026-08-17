// Subscriptions & bills: manage definitions, see what's due and upcoming.
import { $, esc, fmtMoney, fmtDate } from '../ui.js';
import * as nav from '../nav.js';
import { allRecurring, dueList, freqLabel, monthlySetAside } from '../recurring.js';
import { allCategories } from '../categories.js';
import { openRecurringSheet, openMarkPaidSheet } from './sheets.js';
import { skipOccurrence } from '../recurring.js';

const view = {
  async show() { await render(); },
  async refresh() { if (nav.currentScreen() === 'recurring') await render(); },
  hide() {},
};
export default view;

async function render() {
  const root = $('#screen-recurring');
  const [defs, cats, { due }] = await Promise.all([allRecurring(), allCategories({ includeArchived: true }), dueList({ horizon: 7 })]);
  const catMap = new Map(cats.map(c => [c.id, c]));
  const active = defs.filter(d => d.active);
  const paused = defs.filter(d => !d.active);
  const monthlyTotal = active.reduce((s, d) => s + monthlySetAside(d), 0);

  const defRow = (d) => {
    const c = catMap.get(d.categoryId);
    const setAside = monthlySetAside(d);
    const showSetAside = d.freq.interval > 1 || d.freq.unit !== 'month';
    return `
    <div class="cat-row" data-def="${esc(d.id)}" style="cursor:pointer;${d.active ? '' : 'opacity:.5'}">
      <div class="cat-ico">${esc(c?.icon || '🔁')}</div>
      <div class="cat-main">
        <div class="cat-name">${esc(d.name)}</div>
        <div class="cat-nums">${fmtMoney(d.amountCents)} ${esc(freqLabel(d))}
          · ${d.mode === 'autopost' ? 'auto-posts' : 'reminds'}
          ${showSetAside ? ` · sets aside ${fmtMoney(setAside)}/mo` : ''}</div>
      </div>
      <div class="cat-right" style="font-size:12.5px;font-weight:600;color:var(--text-dim)">
        ${d.active && d.nextDue ? 'next ' + esc(fmtDate(d.nextDue)) : 'paused'}</div>
    </div>`;
  };

  root.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-role="back" aria-label="Back">←</button>
      <h1>Bills &amp; subscriptions <span class="sub">≈ ${fmtMoney(monthlyTotal)}/mo committed</span></h1>
    </header>
    <div class="content">
      ${due.length ? `
      <div class="section-title">Needs attention <span class="count-badge">${due.length}</span></div>
      ${due.map((d, i) => `
      <div class="due-row ${d.overdue ? 'overdue' : ''}">
        <div class="due-main">${esc(d.def.name)}
          <span class="due-sub">${d.overdue ? 'was due' : 'due'} ${esc(fmtDate(d.dueDate))}</span></div>
        <span class="due-amt">${fmtMoney(d.def.amountCents)}</span>
        <button class="btn btn-sm" data-skip="${i}">Skip</button>
        <button class="btn btn-sm btn-primary" data-pay="${i}">Mark paid</button>
      </div>`).join('')}` : ''}
      <div class="section-title">Active</div>
      ${active.length ? active.map(defRow).join('') : '<div class="empty"><span class="big">🔁</span>No recurring bills yet.</div>'}
      ${paused.length ? `<div class="section-title">Paused</div>${paused.map(defRow).join('')}` : ''}
    </div>
    <nav class="actionbar">
      <button class="btn btn-primary" data-role="add"><span class="ico">＋</span>New subscription / bill</button>
    </nav>`;

  $('[data-role="back"]', root).addEventListener('click', () => nav.back());
  $('[data-role="add"]', root).addEventListener('click', () => openRecurringSheet({ onDone: render }));
  root.querySelectorAll('[data-def]').forEach(r => r.addEventListener('click', () => {
    const d = defs.find(x => x.id === r.dataset.def);
    if (d) openRecurringSheet({ def: d, onDone: render });
  }));
  root.querySelectorAll('[data-pay]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const d = due[Number(b.dataset.pay)];
    openMarkPaidSheet(d.def, d.dueDate, { onDone: render });
  }));
  root.querySelectorAll('[data-skip]').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const d = due[Number(b.dataset.skip)];
    await skipOccurrence(d.def, d.dueDate);
    render();
  }));
}
