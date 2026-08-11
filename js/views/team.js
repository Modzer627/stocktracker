// Manager Team view: every tech's van, live-ish. Read-only.
import { fetchTeam, cachedTeam, removeTech } from '../sync.js';
import { aggregateTeamItems } from '../analytics.js';
import { exportTeamXlsx } from '../export.js';
import { esc, fmtQty, toast, confirmDialog } from '../ui.js';
import * as nav from '../nav.js';

const section = () => document.getElementById('screen-team');

let data = null;      // { team, cached, at }
let tab = 'vans';     // 'vans' | 'all'
let openTechId = null;
let query = '';

function ago(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

const isStale = (iso) => Date.now() - new Date(iso).getTime() > 24 * 3600 * 1000;

function techCard(t) {
  const items = t.snapshot.items || [];
  const low = items.filter(i => i.qty <= i.minQty).length;
  const value = items.reduce((s, i) => s + (typeof i.cost === 'number' && i.cost > 0 && i.qty > 0 ? i.qty * i.cost : 0), 0);
  const stale = isStale(t.updatedAt);
  return `
    <div class="item-row${low ? ' low' : ''}" data-tech="${esc(t.techId)}">
      <div class="item-main">
        <div class="item-name">${esc(t.techName)}</div>
        <div class="item-sub">${stale ? '<span class="low-tag">⚠ ' : ''}synced ${ago(new Date(t.updatedAt).getTime())}${stale ? '</span>' : ''}${value > 0 ? ` · $${value.toFixed(2)}` : ''}</div>
      </div>
      <div class="item-qty"><div class="q">${items.length}</div><div class="u">items</div></div>
      <div class="item-qty"><div class="q${low ? ' neg' : ''}">${low}</div><div class="u">low</div></div>
    </div>`;
}

function techDetail(t) {
  const items = [...(t.snapshot.items || [])].sort((a, b) => a.name.localeCompare(b.name));
  const filtered = query
    ? items.filter(i => (i.name + ' ' + (i.barcode || '') + ' ' + (i.location || '')).toLowerCase().includes(query.toLowerCase()))
    : items;
  const lows = filtered.filter(i => i.qty <= i.minQty);
  const row = (i) => `
    <div class="item-row${i.qty <= i.minQty ? ' low' : ''}">
      <div class="item-main">
        <div class="item-name">${esc(i.name)}</div>
        <div class="item-sub">${[i.qty <= i.minQty ? '<span class="low-tag">LOW</span>' : '', esc(i.location || ''), i.minQty > 0 ? `min ${fmtQty(i.minQty)}` : ''].filter(Boolean).join(' · ') || '&nbsp;'}</div>
      </div>
      <div class="item-qty"><div class="q${i.qty < 0 ? ' neg' : ''}">${fmtQty(i.qty)}</div><div class="u">${esc(i.unit)}</div></div>
    </div>`;
  return `
    <div class="banner info">Viewing <b>&nbsp;${esc(t.techName)}&nbsp;</b> · read-only · synced ${ago(new Date(t.updatedAt).getTime())}
      <button class="btn btn-sm" data-remove-tech>Remove</button>
    </div>
    <div class="searchbar"><input type="search" placeholder="Search this van…" value="${esc(query)}" data-tsearch></div>
    ${lows.length ? `<div class="section-title">Low stock <span class="count-badge">${lows.length}</span></div>${lows.map(row).join('')}` : ''}
    <div class="section-title">All items (${filtered.length})</div>
    ${filtered.map(row).join('') || '<div class="empty">Nothing matches.</div>'}`;
}

function allStock() {
  const rows = aggregateTeamItems(data.team);
  const filtered = query
    ? rows.filter(r => (r.name + ' ' + r.barcode).toLowerCase().includes(query.toLowerCase()))
    : rows;
  const anyValue = filtered.some(r => r.value > 0);
  return `
    <div class="searchbar"><input type="search" placeholder="Search team stock…" value="${esc(query)}" data-tsearch></div>
    ${filtered.map(r => `
      <div class="item-row${r.anyLow ? ' low' : ''}">
        <div class="item-main">
          <div class="item-name">${esc(r.name)}</div>
          <div class="item-sub">${r.perTech.map(p => `${esc(p.techName)}: ${p.low ? '<span class="low-tag">' : ''}${fmtQty(p.qty)}${p.low ? '</span>' : ''}`).join(' · ')}</div>
        </div>
        <div class="item-qty">
          <div class="q">${fmtQty(r.total)}</div>
          <div class="u">${esc(r.unit)}${anyValue && r.value > 0 ? ` · $${r.value.toFixed(0)}` : ''}</div>
        </div>
      </div>`).join('') || '<div class="empty">No synced stock yet — techs appear here after their first sync.</div>'}`;
}

async function render() {
  const sec = section();
  if (!data) {
    sec.innerHTML = `
      <header class="hdr">
        <button class="icon-btn" data-back aria-label="Back">←</button>
        <h1>Team</h1>
      </header>
      <div class="content"><div class="empty">Loading team…</div></div>`;
    sec.querySelector('[data-back]').addEventListener('click', () => nav.back());
    return;
  }

  const tech = openTechId ? data.team.find(t => t.techId === openTechId) : null;
  const updatedLine = data.cached
    ? `showing last download (${ago(data.at)}) — no connection`
    : `updated ${ago(data.at)}`;

  sec.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-back aria-label="Back">←</button>
      <h1>${tech ? esc(tech.techName) : 'Team'}<span class="sub">${data.team.length} tech${data.team.length === 1 ? '' : 's'} · ${updatedLine}</span></h1>
      <button class="icon-btn" data-refresh aria-label="Refresh">↻</button>
    </header>
    ${tech ? '' : `
      <div class="content" style="flex:0 0 auto;padding-bottom:0">
        <div class="seg seg-page">
          <button data-tab="vans" class="${tab === 'vans' ? 'on' : ''}">Vans</button>
          <button data-tab="all" class="${tab === 'all' ? 'on' : ''}">All stock</button>
        </div>
      </div>`}
    <div class="content" data-body>
      ${data.cached ? '<div class="banner">⚠ Could not reach the sync server — this is the last known state.</div>' : ''}
      ${tech ? techDetail(tech) : (tab === 'vans'
        ? (data.team.map(techCard).join('') || '<div class="empty">No techs have synced yet.<br>Each tech enters the team code + their name in Settings → Team sync.</div>')
        : allStock())}
    </div>
    <div class="actionbar">
      <button class="btn" data-export-team><span class="ico">⇪</span>Team Excel</button>
      <button class="btn btn-primary" data-insights><span class="ico">📈</span>Team insights</button>
    </div>`;

  sec.querySelector('[data-back]').addEventListener('click', () => {
    if (openTechId) { openTechId = null; query = ''; render(); } else nav.back();
  });
  sec.querySelector('[data-refresh]').addEventListener('click', () => load(true));
  sec.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; query = ''; render(); }));
  sec.querySelector('[data-export-team]').addEventListener('click', async () => {
    const r = await exportTeamXlsx(data.team);
    if (r === 'shared' || r === 'downloaded') toast('Team Excel exported');
  });
  sec.querySelector('[data-insights]').addEventListener('click', () => nav.show('insights', { scope: 'team' }));

  sec.querySelector('[data-body]').addEventListener('click', (e) => {
    const card = e.target.closest('[data-tech]');
    if (card) { openTechId = card.dataset.tech; query = ''; render(); }
  });
  sec.querySelector('[data-remove-tech]')?.addEventListener('click', async () => {
    const yes = await confirmDialog(`Remove ${tech.techName} from the team view? Their phone keeps its data and reappears on its next sync.`, { danger: true, okLabel: 'Remove' });
    if (!yes) return;
    try {
      await removeTech(tech.techId);
      openTechId = null;
      toast('Removed from team view');
      load(true);
    } catch (err) { toast(err.message, { error: true }); }
  });
  const s = sec.querySelector('[data-tsearch]');
  if (s) s.addEventListener('input', () => {
    query = s.value;
    const body = sec.querySelector('[data-body]');
    const caret = s.selectionStart;
    body.innerHTML = tech ? techDetail(tech) : allStock();
    const ns = sec.querySelector('[data-tsearch]');
    ns.focus({ preventScroll: true });
    try { ns.setSelectionRange(caret, caret); } catch { /* ok */ }
  });
}

async function load(force = false) {
  if (!force) {
    const c = await cachedTeam();
    if (c) { data = c; render(); }
  }
  try {
    data = await fetchTeam();
  } catch (e) {
    if (!data) { toast(e.message, { error: true }); nav.back(); return; }
    data = { ...data, cached: true };
    toast(e.message, { error: true });
  }
  render();
}

export default {
  async show() {
    tab = 'vans';
    openTechId = null;
    query = '';
    data = null;
    render();
    await load();
  },
};
