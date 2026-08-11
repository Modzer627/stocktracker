// Insights: analytics over the movement history. Techs see their own van;
// managers can switch to the whole team.
import { dbAll } from '../db.js';
import { allItems } from '../items.js';
import { managerConfigured, fetchTeam, cachedTeam } from '../sync.js';
import { usageByJob, usageRates, topUsed, weeklyUsage, stockValue, mergeTeamTxns, aggregateTeamItems, usageByTech, reorderSuggestions, teamReorderSuggestions } from '../analytics.js';
import { barChart, meter, wireCharts } from '../charts.js';
import { exportJobCostingXlsx, exportReorderXlsx } from '../export.js';
import { esc, fmtQty, fmtDateTime, toast } from '../ui.js';
import * as nav from '../nav.js';

const section = () => document.getElementById('screen-insights');

let scope = 'me';        // 'me' | 'team'
let jobDays = 90;        // usage-by-job window
let isManager = false;
let teamData = null;

const DAY = 24 * 3600 * 1000;

async function getData() {
  if (scope === 'team' && teamData) {
    const items = teamData.team.flatMap(t => (t.snapshot.items || []).map(i => ({ ...i, tech: t.techName })));
    return { items, txns: mergeTeamTxns(teamData.team), team: teamData.team };
  }
  return { items: await allItems(), txns: await dbAll('txns'), team: null };
}

function statTiles(items, txns) {
  const val = stockValue(items);
  const outs30 = txns.filter(t => t.type === 'out' && t.ts >= Date.now() - 30 * DAY);
  const moved = Math.round(outs30.reduce((s, t) => s + -t.delta, 0) * 100) / 100;
  const lows = items.filter(i => i.qty <= i.minQty).length;
  return `
    <div class="tiles">
      <div class="tile"><div class="tile-v">${items.length}</div><div class="tile-l">items tracked</div></div>
      <div class="tile"><div class="tile-v${lows ? ' bad' : ''}">${lows}</div><div class="tile-l">low right now</div></div>
      <div class="tile"><div class="tile-v">${fmtQty(moved)}</div><div class="tile-l">used last 30 days</div></div>
      ${val.costed > 0
        ? `<div class="tile"><div class="tile-v">$${val.total.toFixed(0)}</div><div class="tile-l">stock value${val.uncosted ? ` (${val.uncosted} uncosted)` : ''}</div></div>`
        : `<div class="tile"><div class="tile-v">—</div><div class="tile-l">stock value · add costs to items</div></div>`}
    </div>`;
}

function runningOut(items, txns) {
  const rows = usageRates(items, txns, { days: 90 }).slice(0, 8);
  if (!rows.length) return '<div class="chart-empty">No usage history yet — forecasts appear once items get used.</div>';
  return rows.map(r => `
    <div class="rev-row">
      <div class="rev-main">
        <div>${esc(r.item.name)}${r.item.tech ? ` <span class="txn-sub">· ${esc(r.item.tech)}</span>` : ''}</div>
        <div class="txn-sub">${fmtQty(r.item.qty)} ${esc(r.item.unit)} left · ~${fmtQty(r.perDay)}/day</div>
      </div>
      <div class="rev-diff ${r.daysLeft <= 14 ? 'neg' : r.daysLeft <= 30 ? '' : 'zero'}">${r.daysLeft > 365 ? '1 yr+' : r.daysLeft + ' d'}</div>
    </div>`).join('');
}

function topUsedRows(txns) {
  const rows = topUsed(txns, { days: 30, limit: 8 });
  if (!rows.length) return '<div class="chart-empty">Nothing used in the last 30 days.</div>';
  const max = rows[0].qty;
  return rows.map(r => `
    <div class="rev-row">
      <div class="rev-main">
        <div>${esc(r.itemName)}</div>
        ${meter(r.qty, max)}
      </div>
      <div class="rev-nums">${fmtQty(r.qty)} ${esc(r.unit)}</div>
    </div>`).join('');
}

function techComparison(team) {
  const rows = usageByTech(team, { days: 30 });
  if (!rows.length || rows.every(r => r.total === 0)) return '';
  const max = Math.max(...rows.map(r => r.total)) || 1;
  return `
    <div class="section-title">Usage by tech (30 days)</div>
    ${rows.map(r => `
      <div class="rev-row">
        <div class="rev-main"><div>${esc(r.techName)}</div>${meter(r.total, max)}</div>
        <div class="rev-nums">${fmtQty(r.total)}<div class="txn-sub">${r.moves} uses</div></div>
      </div>`).join('')}`;
}

function jobsSection(txns) {
  const jobs = usageByJob(txns, { sinceTs: Date.now() - jobDays * DAY });
  const body = jobs.length ? jobs.map((j, idx) => `
    <details class="job-card"${idx === 0 ? ' open' : ''}>
      <summary>
        <span class="job-name">${esc(j.job)}</span>
        <span class="txn-sub">${j.lines.length} item${j.lines.length === 1 ? '' : 's'} · last ${fmtDateTime(j.lastTs)}</span>
      </summary>
      ${j.lines.map(l => `
        <div class="rev-row">
          <div class="rev-main"><div>${esc(l.itemName)}${l.tech ? ` <span class="txn-sub">· ${esc(l.tech)}</span>` : ''}</div></div>
          <div class="rev-nums">${fmtQty(l.qty)} ${esc(l.unit)}</div>
        </div>`).join('')}
    </details>`).join('')
    : '<div class="chart-empty">No job usage in this period.</div>';
  return `
    <div class="section-title" style="display:flex;align-items:center">Usage by job
      <span style="flex:1"></span>
      <span class="seg seg-mini">
        ${[30, 90, 180].map(d => `<button data-jobdays="${d}" class="${jobDays === d ? 'on' : ''}">${d}d</button>`).join('')}
      </span>
    </div>
    ${body}
    <button class="btn btn-block" data-export-jobs style="margin-top:10px">⇪ Export job costing (Excel)</button>`;
}

async function render() {
  const sec = section();
  const { items, txns, team } = await getData();
  const weekly = weeklyUsage(txns, { weeks: 12 });

  sec.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-back aria-label="Back">←</button>
      <h1>Insights<span class="sub">${scope === 'team' ? `whole team (${team.length} tech${team.length === 1 ? '' : 's'})` : 'your van'}</span></h1>
      ${isManager ? `
        <div class="seg seg-mini">
          <button data-scope="me" class="${scope === 'me' ? 'on' : ''}">My van</button>
          <button data-scope="team" class="${scope === 'team' ? 'on' : ''}">Team</button>
        </div>` : ''}
    </header>
    <div class="content">
      ${statTiles(items, txns)}
      <div class="section-title">Running out soon <span class="txn-sub" style="text-transform:none;letter-spacing:0">(by usage rate, not just min-stock)</span></div>
      ${runningOut(items, txns)}
      <button class="btn btn-block" data-reorder style="margin-top:8px">🛒 Reorder report (Excel)</button>
      <div class="section-title">Weekly usage (12 weeks)</div>
      ${barChart(weekly)}
      <div class="section-title">Most used (30 days)</div>
      ${topUsedRows(txns)}
      ${scope === 'team' && team ? techComparison(team) : ''}
      ${jobsSection(txns)}
    </div>`;

  wireCharts(sec);
  sec.querySelector('[data-back]').addEventListener('click', () => nav.back());
  sec.querySelectorAll('[data-scope]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.scope === scope) return;
    scope = b.dataset.scope;
    if (scope === 'team' && !teamData) await loadTeam();
    render();
  }));
  sec.querySelectorAll('[data-jobdays]').forEach(b => b.addEventListener('click', () => { jobDays = Number(b.dataset.jobdays); render(); }));
  sec.querySelector('[data-reorder]').addEventListener('click', async () => {
    const rows = scope === 'team' && team ? teamReorderSuggestions(team) : reorderSuggestions(items, txns);
    if (!rows.length) { toast('Nothing needs reordering right now 🎉'); return; }
    const r = await exportReorderXlsx(rows, { team: scope === 'team', scopeLabel: scope === 'team' ? 'team' : 'van' });
    if (r === 'shared' || r === 'downloaded') toast(`Reorder report exported — ${rows.length} item${rows.length === 1 ? '' : 's'}`);
  });
  sec.querySelector('[data-export-jobs]').addEventListener('click', async () => {
    const jobs = usageByJob(txns, { sinceTs: Date.now() - jobDays * DAY });
    const itemCosts = new Map();
    for (const i of items) if (typeof i.cost === 'number' && i.cost > 0) itemCosts.set(`${i.name}|${i.unit}`, i.cost);
    const r = await exportJobCostingXlsx(jobs, { scopeLabel: scope === 'team' ? 'team' : 'van', days: jobDays, itemCosts });
    if (r === 'shared' || r === 'downloaded') toast('Job costing exported');
  });
}

async function loadTeam() {
  try {
    teamData = await fetchTeam();
  } catch (e) {
    teamData = await cachedTeam();
    if (!teamData) { toast(e.message, { error: true }); scope = 'me'; }
    else toast('Showing last downloaded team data', { error: true });
  }
}

export default {
  async show(params = {}) {
    isManager = await managerConfigured();
    scope = params.scope === 'team' && isManager ? 'team' : 'me';
    teamData = null;
    if (scope === 'team') await loadTeam();
    if (scope === 'team' && !teamData) scope = 'me';
    return render();
  },
};
