// Goals: the spreadsheet's 1-Year Plan (debt payoff → savings) as a live
// tracker. Plan is computed from editable assumptions in the shared row;
// actuals come from real transactions in the debt & savings categories.
import { $, esc, fmtMoney, parseMoney, monthKey, monthLabel, shiftMonth, toast } from '../ui.js';
import * as nav from '../nav.js';
import { getHousehold, saveHousehold } from '../categories.js';
import { meter } from '../charts.js';
import { dbAll } from '../db.js';
import { alive } from '../store.js';

const DEBT_CAT = 'cat-debt';
const SAVINGS_CAT = 'cat-savings';

const view = {
  async show() { await render(); },
  async refresh() { if (nav.currentScreen() === 'goals') await render(); },
  hide() {},
};
export default view;

/** Month-by-month plan: pay debt first, then savings + monthly interest. */
function planMonths(plan) {
  const out = [];
  let debt = plan.startingDebtCents;
  let savings = 0;
  let m = plan.startMonth;
  for (let i = 0; i < 12; i++) {
    const payment = Math.min(debt, plan.monthlyAvailableCents);
    const toSavings = plan.monthlyAvailableCents - payment;
    const interest = Math.round(savings * plan.apy / 12);
    debt -= payment;
    savings += toSavings + interest;
    out.push({ month: m, debtEnd: debt, savings, payment, toSavings, interest });
    m = shiftMonth(m, 1);
  }
  return out;
}

async function actuals(startMonth) {
  const txns = alive(await dbAll('txns')).filter(t => t.month >= startMonth);
  const debtPaid = txns.filter(t => t.categoryId === DEBT_CAT).reduce((s, t) => s + t.amountCents, 0);
  const saved = txns.filter(t => t.categoryId === SAVINGS_CAT).reduce((s, t) => s + t.amountCents, 0);
  return { debtPaid, saved };
}

async function render() {
  const root = $('#screen-goals');
  const household = await getHousehold();
  const plan = household.plan || {
    startingDebtCents: 0, monthlyAvailableCents: 0, apy: 0.04,
    goalCents: 2000000, stretchCents: 3000000, startMonth: monthKey(),
  };
  const months = planMonths(plan);
  const { debtPaid, saved } = await actuals(plan.startMonth);
  const debtLeft = Math.max(0, plan.startingDebtCents - debtPaid);
  const now = monthKey();
  const idx = months.findIndex(m => m.month >= now);
  const cur = idx === -1 ? months[months.length - 1] : months[Math.max(0, idx)];
  const end = months[months.length - 1];
  const debtFreeMonth = months.find(m => m.debtEnd <= 0)?.month;

  const planDebtLeftNow = idx <= 0 ? plan.startingDebtCents : months[idx - 1].debtEnd;
  const planSavedNow = idx <= 0 ? 0 : months[idx - 1].savings;
  const debtBadge = debtLeft <= planDebtLeftNow
    ? '<span class="badge ok">on track</span>' : '<span class="badge warn">behind plan</span>';
  const saveBadge = saved >= planSavedNow
    ? '<span class="badge ok">on track</span>' : '<span class="badge warn">behind plan</span>';

  root.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-role="back" aria-label="Back">←</button>
      <h1>1-Year Plan <span class="sub">${esc(monthLabel(plan.startMonth))} → ${esc(monthLabel(end.month))}</span></h1>
    </header>
    <div class="content">
      <div class="goal-card">
        <div class="goal-head"><h3>💳 Debt-free</h3>${debtBadge}</div>
        ${meter(debtPaid, plan.startingDebtCents || 1)}
        <div class="goal-nums">${fmtMoney(debtPaid)} of ${fmtMoney(plan.startingDebtCents)} paid — ${fmtMoney(debtLeft)} to go.
          Plan clears the debt ${debtFreeMonth ? 'in ' + esc(monthLabel(debtFreeMonth)) : 'after this year'}.</div>
      </div>
      <div class="goal-card">
        <div class="goal-head"><h3>🏦 Savings goal</h3>${saveBadge}</div>
        ${meter(saved, plan.goalCents || 1)}
        <div class="goal-nums">${fmtMoney(saved)} saved of the ${fmtMoney(plan.goalCents)} goal
          (stretch ${fmtMoney(plan.stretchCents)}). Plan pace by now: ${fmtMoney(planSavedNow)}.</div>
      </div>
      <div class="tiles">
        <div class="tile"><div class="tile-v">${fmtMoney(end.savings)}</div><div class="tile-l">projected savings by ${esc(monthLabel(end.month))} (plan pace, ${(plan.apy * 100).toFixed(1)}% APY)</div></div>
        <div class="tile"><div class="tile-v ${end.savings >= plan.goalCents ? '' : 'bad'}">${end.savings >= plan.goalCents ? 'ON TRACK' : 'SHORT'}</div><div class="tile-l">vs the ${fmtMoney(plan.goalCents)} goal${end.savings < plan.goalCents ? ' — short by ' + fmtMoney(plan.goalCents - end.savings) : ''}</div></div>
      </div>
      <div class="section-title">Plan month by month</div>
      ${months.map(m => `
        <div class="txn-row">
          <div class="txn-main">${esc(monthLabel(m.month))}
            <div class="txn-sub">${m.payment > 0 ? `pays ${fmtMoney(m.payment)} debt` : `saves ${fmtMoney(m.toSavings)}${m.interest ? ` + ${fmtMoney(m.interest)} interest` : ''}`}</div></div>
          <span class="txn-amt">${m.debtEnd > 0 ? '−' + fmtMoney(m.debtEnd).slice(1) + ' debt' : fmtMoney(m.savings)}</span>
        </div>`).join('')}
      <div class="section-title">Assumptions</div>
      <div class="set-group" style="padding:14px 15px">
        <div class="field-row">
          <div class="field"><label>Starting debt</label>
            <input data-p="startingDebtCents" type="text" inputmode="decimal" value="${(plan.startingDebtCents / 100).toFixed(2)}"></div>
          <div class="field"><label>Monthly available</label>
            <input data-p="monthlyAvailableCents" type="text" inputmode="decimal" value="${(plan.monthlyAvailableCents / 100).toFixed(2)}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Goal</label>
            <input data-p="goalCents" type="text" inputmode="decimal" value="${(plan.goalCents / 100).toFixed(2)}"></div>
          <div class="field"><label>Stretch goal</label>
            <input data-p="stretchCents" type="text" inputmode="decimal" value="${(plan.stretchCents / 100).toFixed(2)}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>HYSA APY %</label>
            <input data-p="apy" type="text" inputmode="decimal" value="${(plan.apy * 100).toFixed(1)}"></div>
          <div class="field"><label>Start month</label>
            <input data-p="startMonth" type="month" value="${esc(plan.startMonth)}"></div>
        </div>
        <button class="btn btn-primary btn-block" data-role="save-plan">Save assumptions</button>
      </div>
    </div>`;

  $('[data-role="back"]', root).addEventListener('click', () => nav.back());
  $('[data-role="save-plan"]', root).addEventListener('click', async () => {
    const get = (p) => $(`[data-p="${p}"]`, root).value;
    const next = {
      startingDebtCents: parseMoney(get('startingDebtCents')) ?? plan.startingDebtCents,
      monthlyAvailableCents: parseMoney(get('monthlyAvailableCents')) ?? plan.monthlyAvailableCents,
      goalCents: parseMoney(get('goalCents')) ?? plan.goalCents,
      stretchCents: parseMoney(get('stretchCents')) ?? plan.stretchCents,
      apy: Math.max(0, parseFloat(get('apy')) || 0) / 100,
      startMonth: get('startMonth') || plan.startMonth,
    };
    await saveHousehold({ plan: next });
    toast('Plan updated');
    render();
  });
}
