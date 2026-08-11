// Manager Team view: every tech's van, live-ish. Read-only.
import { fetchTeam, cachedTeam, removeTech } from '../sync.js';
import { allRequests, decideRequest } from '../requests.js';
import { aggregateTeamItems } from '../analytics.js';
import { exportTeamXlsx } from '../export.js';
import { esc, fmtQty, fmtDateTime, toast, confirmDialog, sheet } from '../ui.js';
import * as nav from '../nav.js';

const section = () => document.getElementById('screen-team');

let data = null;      // { team, cached, at }
let requests = [];    // manager request inbox
let tab = 'vans';     // 'vans' | 'all' | 'requests'
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
  const canTransfer = data.team.length > 1;
  const row = (i) => `
    <div class="item-row${i.qty <= i.minQty ? ' low' : ''}" data-titem="${esc(i.id)}">
      ${i.photo ? `<div class="thumb" data-photo-key="${esc(i.photo)}"></div>` : ''}
      <div class="item-main">
        <div class="item-name">${esc(i.name)}</div>
        <div class="item-sub">${[i.qty <= i.minQty ? '<span class="low-tag">LOW</span>' : '', esc(i.location || ''), i.minQty > 0 ? `min ${fmtQty(i.minQty)}` : ''].filter(Boolean).join(' · ') || '&nbsp;'}</div>
      </div>
      <div class="item-qty"><div class="q${i.qty < 0 ? ' neg' : ''}">${fmtQty(i.qty)}</div><div class="u">${esc(i.unit)}</div></div>
      ${canTransfer ? `<button class="icon-btn" data-transfer title="Transfer to another van">⇄</button>` : ''}
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

function pendingCount() {
  return requests.filter(r => r.status === 'pending').length;
}

const STATUS_LABEL = { approved: '✅ approved', applied: '✅ approved', rejected: '✖ rejected', closed: '✖ rejected' };

function requestsList() {
  const pending = requests.filter(r => r.status === 'pending');
  const decided = requests.filter(r => r.status !== 'pending');
  const detailLine = (p) => [
    p.barcode ? `barcode ${p.barcode}` : 'no barcode',
    p.qty ? `qty ${fmtQty(p.qty)}` : null,
    p.minQty ? `min ${fmtQty(p.minQty)}` : null,
    p.unit, p.category, p.location,
  ].filter(Boolean).join(' · ');
  return `
    ${pending.length ? pending.map(r => `
      <div class="item-row" data-req="${r.id}">
        <div class="item-main">
          <div class="item-name">${esc(r.payload.name)}</div>
          <div class="item-sub">${esc(r.techName)} · ${fmtDateTime(new Date(r.createdAt).getTime())}<br>${esc(detailLine(r.payload))}</div>
          ${r.payload.notes ? `<div class="item-sub">“${esc(r.payload.notes)}”</div>` : ''}
        </div>
        <button class="btn btn-sm btn-primary" data-review>Review</button>
      </div>`).join('') : '<div class="empty">No pending requests. Techs can request new items from their Add button or by scanning an unknown barcode.</div>'}
    ${decided.length ? `
      <div class="section-title" style="margin-top:18px">Recently decided</div>
      ${decided.slice(0, 20).map(r => `
        <div class="rev-row">
          <div class="rev-main"><div>${esc(r.payload.name)}</div><div class="txn-sub">${esc(r.techName)}${r.target === 'team' ? ' → whole team' : ''}${r.managerNote ? ' · ' + esc(r.managerNote) : ''}</div></div>
          <div class="rev-nums txn-sub">${STATUS_LABEL[r.status] || r.status}</div>
        </div>`).join('')}` : ''}`;
}

function openReviewSheet(r) {
  const p = r.payload;
  const f = (label, key, val, attrs = '') => `
    <div class="field"><label>${label}</label><input type="text" data-rf="${key}" value="${esc(val ?? '')}" ${attrs} autocomplete="off"></div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <p style="color:var(--text-dim);font-size:13.5px;margin-bottom:12px">Requested by <b>${esc(r.techName)}</b> · ${fmtDateTime(new Date(r.createdAt).getTime())}</p>
    ${f('Name *', 'name', p.name)}
    ${f('Barcode', 'barcode', p.barcode, 'inputmode="numeric"')}
    <div class="field-row">
      ${f('Starting qty', 'qty', fmtQty(p.qty || 0), 'inputmode="decimal"')}
      ${f('Min stock', 'minQty', fmtQty(p.minQty || 0), 'inputmode="decimal"')}
    </div>
    <div class="field-row">
      ${f('Unit', 'unit', p.unit || 'pcs')}
      ${f('Category', 'category', p.category)}
    </div>
    <div class="field-row">
      ${f('Location', 'location', p.location)}
      ${f('Cost per unit ($)', 'cost', p.cost ?? '', 'inputmode="decimal" placeholder="optional"')}
    </div>
    ${f('Note to tech (optional)', '_note', '', 'placeholder="e.g. use the 22mm ones we stock"')}
    <div class="field">
      <label>Add for</label>
      <div class="seg seg-page">
        <button type="button" data-target="tech" class="on">Just ${esc(r.techName)}</button>
        <button type="button" data-target="team">Whole team</button>
      </div>
    </div>
    <div class="sheet-actions">
      <button type="button" class="btn" data-rejectbtn style="color:var(--danger)">Reject</button>
      <button type="button" class="btn btn-primary" data-approvebtn>Approve</button>
    </div>`;
  const s = sheet({ title: 'Review request', content: wrap });
  let target = 'tech';
  wrap.querySelectorAll('[data-target]').forEach(b => b.addEventListener('click', () => {
    target = b.dataset.target;
    wrap.querySelectorAll('[data-target]').forEach(x => x.classList.toggle('on', x === b));
  }));
  const readPayload = () => {
    const out = {};
    wrap.querySelectorAll('[data-rf]').forEach(i => { if (i.dataset.rf !== '_note') out[i.dataset.rf] = i.value; });
    return out;
  };
  const decide = async (approve) => {
    const payload = readPayload();
    if (approve && !payload.name.trim()) { toast('Name is required', { error: true }); return; }
    const note = wrap.querySelector('[data-rf="_note"]').value.trim();
    try {
      await decideRequest(r.id, { approve, payload, target, note });
      s.close();
      toast(approve ? `Approved — ${target === 'team' ? 'whole team gets' : `${r.techName} gets`} "${payload.name.trim()}"` : 'Request rejected', { duration: 3600 });
      await loadRequests();
      render();
    } catch (e) {
      toast(e.message, { error: true });
      await loadRequests();
      render();
    }
  };
  wrap.querySelector('[data-approvebtn]').addEventListener('click', () => decide(true));
  wrap.querySelector('[data-rejectbtn]').addEventListener('click', () => decide(false));
}

async function loadRequests() {
  try { requests = await allRequests(); } catch { /* keep whatever we had */ }
}

function openTransferSheet(fromTech, item) {
  const others = data.team.filter(t => t.techId !== fromTech.techId);
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <p style="color:var(--text-dim);font-size:13.5px;margin-bottom:12px">
      From <b>${esc(fromTech.techName)}</b> — has ${fmtQty(item.qty)} ${esc(item.unit)}
    </p>
    <div class="qty-stepper">
      <button type="button" data-step="-1">−</button>
      <input type="text" inputmode="decimal" value="1" data-tqty>
      <button type="button" data-step="1">+</button>
    </div>
    <div class="field">
      <label>To</label>
      <select data-tdest>${others.map(t => `<option value="${esc(t.techId)}">${esc(t.techName)}</option>`).join('')}</select>
    </div>
    <div class="banner info" style="font-size:13px">Both phones apply the transfer next time they open the app (they'll get a notification now).</div>
    <div class="sheet-actions">
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button type="button" class="btn btn-primary" data-ok>Transfer</button>
    </div>`;
  const s = sheet({ title: `Transfer — <span class="sheet-item-name">${esc(item.name)}</span>`, content: wrap });
  const input = wrap.querySelector('[data-tqty]');
  wrap.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
    const cur = parseFloat(input.value.replace(',', '.')) || 0;
    input.value = fmtQty(Math.max(0.001, cur + Number(b.dataset.step)));
  }));
  wrap.querySelector('[data-cancel]').addEventListener('click', () => s.close());
  wrap.querySelector('[data-ok]').addEventListener('click', async () => {
    const qty = parseFloat(input.value.replace(',', '.'));
    if (!qty || qty <= 0) { toast('Enter a quantity', { error: true }); return; }
    const destId = wrap.querySelector('[data-tdest]').value;
    const dest = others.find(t => t.techId === destId);
    if (qty > item.qty) {
      const sure = await confirmDialog(`${fromTech.techName} only shows ${fmtQty(item.qty)} ${item.unit} — transfer ${fmtQty(qty)} anyway?`, { okLabel: 'Transfer anyway' });
      if (!sure) return;
    }
    try {
      const { createTransfer } = await import('../requests.js');
      await createTransfer({
        fromTechId: fromTech.techId, fromName: fromTech.techName,
        toTechId: dest.techId, toName: dest.techName,
        item, qty,
      });
      s.close();
      toast(`Transfer queued: ${fmtQty(qty)} ${item.unit} ${item.name} → ${dest.techName}`, { duration: 4500 });
    } catch (e) {
      toast(e.message, { error: true });
    }
  });
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
          <button data-tab="requests" class="${tab === 'requests' ? 'on' : ''}">Requests${pendingCount() ? ` (${pendingCount()})` : ''}</button>
        </div>
      </div>`}
    <div class="content" data-body>
      ${data.cached ? '<div class="banner">⚠ Could not reach the sync server — this is the last known state.</div>' : ''}
      ${tech ? techDetail(tech) : tab === 'requests' ? requestsList() : (tab === 'vans'
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
    const transferBtn = e.target.closest('[data-transfer]');
    if (transferBtn) {
      const itemId = transferBtn.closest('[data-titem]').dataset.titem;
      const fromTech = data.team.find(t => t.techId === openTechId);
      const item = fromTech?.snapshot.items.find(i => i.id === itemId);
      if (fromTech && item) openTransferSheet(fromTech, item);
      return;
    }
    const reviewBtn = e.target.closest('[data-review]');
    if (reviewBtn) {
      const id = reviewBtn.closest('[data-req]').dataset.req;
      const r = requests.find(x => x.id === id);
      if (r) openReviewSheet(r);
      return;
    }
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
    import('../photos.js').then(({ hydrateThumbs }) => hydrateThumbs(body));
    const ns = sec.querySelector('[data-tsearch]');
    ns.focus({ preventScroll: true });
    try { ns.setSelectionRange(caret, caret); } catch { /* ok */ }
  });
  import('../photos.js').then(({ hydrateThumbs }) => hydrateThumbs(sec));
}

async function load(force = false) {
  if (!force) {
    const c = await cachedTeam();
    if (c) { data = c; render(); }
  }
  const [teamResult] = await Promise.allSettled([fetchTeam(), loadRequests()]);
  if (teamResult.status === 'fulfilled') {
    data = teamResult.value;
  } else {
    if (!data) { toast(teamResult.reason.message, { error: true }); nav.back(); return; }
    data = { ...data, cached: true };
    toast(teamResult.reason.message, { error: true });
  }
  render();
}

export default {
  async show(params = {}) {
    tab = params.tab === 'requests' ? 'requests' : 'vans';
    openTechId = null;
    query = '';
    data = null;
    requests = [];
    render();
    await load();
  },
};
