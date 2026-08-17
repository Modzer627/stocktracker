// Dashboard: month picker, income vs spent, due bills, category meters.
import { $, esc, fmtMoney, monthKey, monthLabel, shiftMonth, fmtDate } from '../ui.js';
import * as nav from '../nav.js';
import { groupedWithSpend, getHousehold } from '../categories.js';
import { monthTotals } from '../txns.js';
import { dueList } from '../recurring.js';
import { openAddSheet, openMarkPaidSheet } from './sheets.js';
import { skipOccurrence } from '../recurring.js';

let month = monthKey();

const view = {
  async show() { await render(); },
  async refresh() { if (nav.currentScreen() === 'home') await render(); },
  hide() {},
};
export default view;

async function render() {
  const root = $('#screen-home');
  const thisMonth = monthKey();
  const [groups, spentTotal, household, { due, upcoming }] = await Promise.all([
    groupedWithSpend(month), monthTotals(month), getHousehold(), dueList({ horizon: 7 }),
  ]);
  const income = household.incomeCents || 0;
  const budgetTotal = groups.flatMap(g => g.cats).reduce((s, c) => s + (c.cat.budgetCents || 0), 0);
  const remaining = income - spentTotal;

  root.innerHTML = `
    <header class="hdr">
      <div class="logo-mark"></div>
      <h1>Budget <span class="sub">${income ? fmtMoney(income) + '/mo income' : 'household'}</span></h1>
      <div class="month-nav">
        <button class="icon-btn" data-m="-1" aria-label="Previous month">‹</button>
        <span class="month-label">${esc(monthLabel(month))}</span>
        <button class="icon-btn" data-m="1" aria-label="Next month">›</button>
      </div>
    </header>
    <div class="content">
      ${window.__updateReady ? `
      <div class="banner info">A new version is ready.
        <button class="btn btn-sm" data-role="update">Update</button></div>` : ''}
      <div class="sum-card">
        <div class="sum-remaining ${remaining < 0 ? 'neg' : ''}">${fmtMoney(remaining)}</div>
        <div class="sum-sub">left of income in ${esc(monthLabel(month))}</div>
        <div class="sum-split">
          <div><b>${fmtMoney(spentTotal)}</b> spent</div>
          <div><b>${fmtMoney(budgetTotal)}</b> budgeted</div>
          <div><b>${fmtMoney(income - budgetTotal)}</b> planned surplus</div>
        </div>
      </div>
      ${month === thisMonth && (due.length || upcoming.length) ? `
      <div class="section-title">Bills ${due.length ? `<span class="count-badge">${due.length}</span>` : ''}</div>
      <div class="due-strip">
        ${due.map((d, i) => `
        <div class="due-row ${d.overdue ? 'overdue' : ''}">
          <div class="due-main">${esc(d.def.name)}
            <span class="due-sub">${d.overdue ? 'was due' : 'due'} ${esc(fmtDate(d.dueDate))}</span></div>
          <span class="due-amt">${fmtMoney(d.def.amountCents)}</span>
          <button class="btn btn-sm" data-skip="${i}">Skip</button>
          <button class="btn btn-sm btn-primary" data-pay="${i}">Mark paid</button>
        </div>`).join('')}
        ${upcoming.slice(0, 3).map(u => `
        <div class="due-row" style="border-color:var(--border)">
          <div class="due-main">${esc(u.def.name)}
            <span class="due-sub">auto-posts ${esc(fmtDate(u.dueDate))}</span></div>
          <span class="due-amt">${fmtMoney(u.def.amountCents)}</span>
        </div>`).join('')}
      </div>` : ''}
      <div class="section-title">Categories</div>
      ${groups.length ? groups.map(g => `
        <div class="section-title" style="margin-top:12px">${esc(g.group)}</div>
        ${g.cats.map(({ cat, spent }) => {
          const over = cat.budgetCents > 0 && spent > cat.budgetCents;
          const pct = cat.budgetCents > 0 ? Math.min(100, (spent / cat.budgetCents) * 100) : (spent > 0 ? 100 : 0);
          return `
          <div class="cat-row ${over ? 'over' : ''}" data-cat="${esc(cat.id)}">
            <div class="cat-ico">${esc(cat.icon || '🧾')}</div>
            <div class="cat-main">
              <div class="cat-name">${esc(cat.name)}</div>
              <div class="cat-nums">${fmtMoney(spent)} of ${fmtMoney(cat.budgetCents)}</div>
              <div class="meter"><div class="${over ? 'over' : ''}" style="width:${Math.max(2, pct)}%"></div></div>
            </div>
            <div class="cat-right">${fmtMoney((cat.budgetCents || 0) - spent)}</div>
          </div>`;
        }).join('')}`).join('') : `
        <div class="empty"><span class="big">🗂️</span>No categories yet — add them in Settings.</div>`}
    </div>
    <nav class="actionbar">
      <button class="btn" data-nav="txns"><span class="ico">🧾</span>Activity</button>
      <button class="btn" data-nav="recurring"><span class="ico">🔁</span>Bills</button>
      <button class="btn btn-primary" data-role="add"><span class="ico">＋</span>Add</button>
      <button class="btn" data-nav="goals"><span class="ico">🎯</span>Goals</button>
      <button class="btn" data-nav="settings"><span class="ico">⚙️</span>Settings</button>
    </nav>`;

  root.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => {
    month = shiftMonth(month, Number(b.dataset.m));
    render();
  }));
  root.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => nav.show(b.dataset.nav)));
  $('[data-role="add"]', root).addEventListener('click', () => openAddSheet({ onDone: render }));
  const upd = $('[data-role="update"]', root);
  if (upd) upd.addEventListener('click', () => window.__applyUpdate && window.__applyUpdate());
  root.querySelectorAll('[data-pay]').forEach(b => b.addEventListener('click', () => {
    const d = due[Number(b.dataset.pay)];
    openMarkPaidSheet(d.def, d.dueDate, { onDone: render });
  }));
  root.querySelectorAll('[data-skip]').forEach(b => b.addEventListener('click', async () => {
    const d = due[Number(b.dataset.skip)];
    await skipOccurrence(d.def, d.dueDate);
    render();
  }));
  root.querySelectorAll('[data-cat]').forEach(r => r.addEventListener('click', () =>
    nav.show('txns', { categoryId: r.dataset.cat, month })));
}

export function currentMonth() { return month; }
