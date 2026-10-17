// Manager dashboard: weekly roll-up by tech and by part, the log, requests, setup.
import { api, apiBase } from './api.js';
import { esc, fmtQty, fmtDateTime, fmtIsoDate, ago, uuid, store, toast, sheet, confirmDialog, loadScript, initials } from './util.js';
import { weekKey, shiftWeek, weekRange, weekLabel, aggregate, destLabel, techRows, partRows, logRows, toCsv, toTsv } from './report.js';

const app = document.getElementById('app');
const XLSX_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
const QR_URL = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';

const state = {
  pin: null,
  weekKey: weekKey(),
  tab: 'tech',            // tech | part | log | requests | setup
  subs: [], agg: aggregate([]), week: { reviewedAt: null },
  requests: [], techs: [], parts: [], config: null,
  loading: false, error: null,
  expanded: new Set(),    // tech cards showing their submissions
  partQuery: '', showRetired: false,
  loadedTabs: new Set(),
};

const photoUrls = new Map();

/* ---------------- loading ---------------- */

const manager = (path, opts = {}) => api(path, { ...opts, key: state.pin });

async function loadWeek() {
  const { start, end } = weekRange(state.weekKey);
  state.loading = true; state.error = null; render();
  try {
    const [subs, week] = await Promise.all([
      manager(`/v1/submissions?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`),
      manager(`/v1/weeks/${state.weekKey}`),
    ]);
    state.subs = subs.submissions;
    state.agg = aggregate(state.subs);
    state.week = week.week;
    if (!state.loadedTabs.has('techs')) await loadTechs();
  } catch (e) {
    if (e.status === 401) { signOut(); return; }
    state.error = e.message;
  }
  state.loading = false;
  render();
}
async function loadTechs() { const r = await manager('/v1/techs'); state.techs = r.techs; state.loadedTabs.add('techs'); }
async function loadParts() { const r = await manager('/v1/parts'); state.parts = r.parts; state.loadedTabs.add('parts'); }
async function loadRequests() { const r = await manager('/v1/requests'); state.requests = r.requests; state.loadedTabs.add('requests'); }
async function loadConfig() { state.config = await manager('/v1/manager/config'); }

async function openTab(tab) {
  state.tab = tab;
  try {
    if (tab === 'requests') await loadRequests();
    if (tab === 'setup') { await Promise.all([loadTechs(), loadParts(), state.config ? null : loadConfig()]); }
  } catch (e) { toast(e.message, { error: true }); }
  render();
}

function signOut() {
  store.del('managerPin'); state.pin = null; renderLogin();
}

/* ---------------- login ---------------- */

function renderLogin(msg = '') {
  app.innerHTML = `
    <header class="hdr"><div class="logo">P</div><div><h1>Parts Checkout</h1><span class="sub">Manager dashboard</span></div></header>
    <section class="card" style="max-width:420px;margin:24px auto">
      <h3>Sign in</h3>
      ${msg ? `<div class="banner danger mt">${esc(msg)}</div>` : ''}
      <form data-login>
        <div class="field mt"><label>Manager PIN</label><input type="password" data-pin autocomplete="current-password" autofocus></div>
        <button type="submit" class="btn btn-primary btn-xl">Sign in</button>
      </form>
    </section>`;
  app.querySelector('[data-login]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = app.querySelector('[data-pin]').value.trim();
    if (!pin) return;
    try {
      await api('/v1/manager/ping', { key: pin });
      state.pin = pin; store.set('managerPin', pin);
      loadWeek();
    } catch (err) {
      renderLogin(err.status === 401 ? 'That PIN was not accepted.' : err.message);
    }
  });
}

/* ---------------- pieces ---------------- */

const isLate = (s) => !!state.week.reviewedAt && s.createdAt > state.week.reviewedAt;
const linesText = (s) => s.lines.map(l => `${fmtQty(l.qty)} × ${l.part || l.partText}`).join('\n');

function badge(type) { return `<span class="badge ${type}">${type}</span>`; }

function photoThumb(s) {
  return s.photoKey ? `<img class="thumb" alt="photo" data-photo="${esc(s.photoKey)}" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">` : '';
}
async function hydratePhotos(root) {
  for (const img of root.querySelectorAll('[data-photo]')) {
    const key = img.dataset.photo;
    try {
      if (!photoUrls.has(key)) {
        const res = await manager(`/v1/photo/${key}`, { raw: true });
        if (!res.ok) continue;
        photoUrls.set(key, URL.createObjectURL(await res.blob()));
      }
      img.src = photoUrls.get(key);
    } catch { /* leave placeholder */ }
  }
}

function kpis() {
  const t = state.agg.totals;
  const late = state.subs.filter(isLate).length;
  return `
    <div class="kpis">
      <div class="kpi"><div class="v">${t.submissions}</div><div class="l">Submissions</div></div>
      <div class="kpi"><div class="v">${t.techs}</div><div class="l">Techs active</div></div>
      <div class="kpi"><div class="v">${fmtQty(t.taken)}</div><div class="l">Parts taken</div></div>
      <div class="kpi"><div class="v">${fmtQty(t.returned)}</div><div class="l">Returned</div></div>
      ${late ? `<div class="kpi"><div class="v" style="color:var(--danger)">${late}</div><div class="l">Since reviewed</div></div>` : ''}
    </div>`;
}

function byTechBody() {
  if (!state.subs.some(s => s.type !== 'request')) return `${kpis()}<div class="empty">Nothing signed out this week yet.</div>`;
  const activeIds = new Set(state.agg.byTech.map(t => t.techId));
  const idle = state.techs.filter(t => t.active && !activeIds.has(t.id)).map(t => t.name);
  return `${kpis()}
    ${state.agg.byTech.map(t => `
      <section class="card pad0 tech-card">
        <div class="head" data-toggle="${esc(t.techId)}">
          <div class="avatar">${esc(initials(t.techName))}</div>
          <div class="grow"><h3>${esc(t.techName)}</h3>
            <div class="stats">${t.count} submission${t.count === 1 ? '' : 's'} · ${fmtQty(t.taken)} taken${t.returned ? ` · ${fmtQty(t.returned)} returned` : ''}${t.submissions.some(isLate) ? ' · <span class="badge late">new since reviewed</span>' : ''}</div>
          </div>
          <span class="dim">${state.expanded.has(t.techId) ? '▴' : '▾'}</span>
        </div>
        <div class="body">
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Part</th><th class="num">Taken</th><th class="num">Returned</th><th class="num">Net</th><th>For</th></tr></thead>
            <tbody>
              ${t.parts.map(p => `<tr><td class="part">${esc(p.part)}</td><td class="num">${p.taken ? fmtQty(p.taken) : ''}</td><td class="num">${p.returned ? fmtQty(p.returned) : ''}</td><td class="num"><b>${fmtQty(p.net)}</b></td><td class="small dim">${p.dests.map(d => esc(d.label) + (p.dests.length > 1 ? ` (${fmtQty(d.qty)})` : '')).join(' · ')}</td></tr>`).join('')}
              <tr class="total"><td>Total</td><td class="num">${fmtQty(t.taken)}</td><td class="num">${fmtQty(t.returned)}</td><td class="num">${fmtQty(t.net)}</td><td></td></tr>
            </tbody>
          </table></div>
          ${state.expanded.has(t.techId) ? `<div class="section-title">Submissions</div>${t.submissions.map(submissionRow).join('')}` : ''}
        </div>
      </section>`).join('')}
    ${idle.length ? `<p class="small dim">No activity this week: ${esc(idle.join(', '))}</p>` : ''}`;
}

function byPartBody() {
  if (!state.agg.byPart.length) return `${kpis()}<div class="empty">Nothing signed out this week yet.</div>`;
  return `${kpis()}
    <section class="card pad0"><div class="table-wrap"><table class="table">
      <thead><tr><th>Part</th><th class="num">Taken</th><th class="num">Returned</th><th class="num">Net</th><th>Who</th></tr></thead>
      <tbody>
        ${state.agg.byPart.map(p => `<tr><td class="part">${esc(p.part)}</td><td class="num">${p.taken ? fmtQty(p.taken) : ''}</td><td class="num">${p.returned ? fmtQty(p.returned) : ''}</td><td class="num"><b>${fmtQty(p.net)}</b></td><td class="small dim">${p.techs.map(t => `${esc(t.techName)} ${fmtQty(t.net)}`).join(' · ')}</td></tr>`).join('')}
        <tr class="total"><td>Total</td><td class="num">${fmtQty(state.agg.totals.taken)}</td><td class="num">${fmtQty(state.agg.totals.returned)}</td><td class="num">${fmtQty(state.agg.totals.net)}</td><td></td></tr>
      </tbody>
    </table></div></section>`;
}

function submissionRow(s) {
  return `
    <div class="list-row" data-sub="${esc(s.id)}">
      <div class="main">
        <div class="title">${badge(s.type)} ${esc(s.techName)} <span class="small dim">· ${esc(fmtDateTime(s.createdAt))}</span>${isLate(s) ? ' <span class="badge late">new</span>' : ''}${s.type === 'request' && s.status ? ` <span class="badge status-${esc(s.status)}">${esc(s.status)}</span>` : ''}</div>
        <div class="lines-text">${esc(linesText(s))}</div>
        <div class="sub">${esc(destLabel(s))}${s.neededBy ? ` · needed by ${esc(fmtIsoDate(s.neededBy))}` : ''}${s.note ? ` · “${esc(s.note)}”` : ''}${s.updatedAt !== s.createdAt ? ` · edited ${esc(ago(s.updatedAt))}` : ''}</div>
      </div>
      ${photoThumb(s)}
      <div class="row"><button type="button" class="btn btn-sm" data-edit="${esc(s.id)}">Edit</button><button type="button" class="btn btn-sm btn-danger" data-delete="${esc(s.id)}">Delete</button></div>
    </div>`;
}

function logBody() {
  if (!state.subs.length) return '<div class="empty">No submissions this week.</div>';
  const days = new Map();
  for (const s of state.subs) {
    const d = new Date(s.createdAt); const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!days.has(k)) days.set(k, { label: d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }), subs: [] });
    days.get(k).subs.push(s);
  }
  return [...days.values()].map(d => `
    <div class="section-title">${esc(d.label)} <span class="dim">· ${d.subs.length}</span></div>
    <section class="card pad0"><div style="padding:0 16px">${d.subs.map(submissionRow).join('')}</div></section>`).join('');
}

function requestsBody() {
  const open = state.requests.filter(r => r.status !== 'closed');
  const closed = state.requests.filter(r => r.status === 'closed');
  const row = (r) => `
    <div class="list-row" data-sub="${esc(r.id)}">
      <div class="main">
        <div class="title">${esc(r.techName)} <span class="small dim">· ${esc(fmtDateTime(r.createdAt))}</span></div>
        <div class="lines-text">${esc(linesText(r))}</div>
        <div class="sub">${esc(destLabel(r))}${r.neededBy ? ` · <b>needed by ${esc(fmtIsoDate(r.neededBy))}</b>` : ''}${r.note ? ` · “${esc(r.note)}”` : ''}</div>
      </div>
      ${photoThumb(r)}
      <div class="row">
        <select data-status="${esc(r.id)}" style="min-height:36px;padding:4px 8px;width:auto">
          ${['open', 'ordered', 'received', 'closed'].map(s => `<option value="${s}" ${r.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <button type="button" class="btn btn-sm" data-edit="${esc(r.id)}">Edit</button>
      </div>
    </div>`;
  return `
    <div class="section-title">Open requests <span class="dim">· ${open.length}</span></div>
    <section class="card pad0"><div style="padding:0 16px">${open.map(row).join('') || '<div class="empty">No open requests.</div>'}</div></section>
    ${closed.length ? `<div class="section-title">Closed in the last 30 days</div><section class="card pad0"><div style="padding:0 16px">${closed.map(row).join('')}</div></section>` : ''}`;
}

function setupBody() {
  const active = state.techs.filter(t => t.active), inactive = state.techs.filter(t => !t.active);
  const q = state.partQuery.trim().toUpperCase();
  let parts = state.parts.filter(p => state.showRetired || p.active);
  if (q) parts = parts.filter(p => (p.number + ' ' + (p.description || '')).toUpperCase().includes(q));
  const shownParts = parts.slice(0, 150);
  return `
    <div class="section-title">Technicians <span class="dim">· ${active.length}</span></div>
    <section class="card">
      ${active.map(t => `
        <div class="list-row">
          <div class="main"><div class="title">${esc(t.name)}</div>${t.truck ? `<div class="sub">Truck ${esc(t.truck)}</div>` : ''}</div>
          <div class="row"><button type="button" class="btn btn-sm" data-tech-edit="${esc(t.id)}">Edit</button><button type="button" class="btn btn-sm btn-danger" data-tech-off="${esc(t.id)}">Remove</button></div>
        </div>`).join('') || '<div class="empty">No technicians yet — add names below. They become the pick list on the tech page.</div>'}
      <div class="field mt"><label>Add technicians — one per line, optionally “Name, truck”</label>
        <textarea data-tech-add rows="3" placeholder="Dan Boyle, 308&#10;Kyle Olmstead"></textarea></div>
      <button type="button" class="btn btn-primary" data-tech-add-btn>Add</button>
      ${inactive.length ? `<details class="mt"><summary class="dim small">Removed (${inactive.length})</summary>${inactive.map(t => `<div class="list-row"><div class="main dim">${esc(t.name)}</div><button type="button" class="btn btn-sm" data-tech-on="${esc(t.id)}">Restore</button></div>`).join('')}</details>` : ''}
    </section>

    <div class="section-title">Parts list <span class="dim">· ${state.parts.filter(p => p.active).length}</span></div>
    <section class="card">
      <p class="small dim" style="margin-top:0">Learned automatically from what techs type. Rename to fix a spelling, merge duplicates into one, or retire parts that should stop being suggested.</p>
      <div class="row"><input type="search" data-part-search placeholder="Search parts" value="${esc(state.partQuery)}" autocomplete="off"><label class="small nowrap"><input type="checkbox" data-show-retired ${state.showRetired ? 'checked' : ''}> show retired</label></div>
      <div class="table-wrap mt"><table class="table">
        <thead><tr><th>Part</th><th>Description</th><th class="num">Used</th><th></th></tr></thead>
        <tbody>${shownParts.map(p => `
          <tr ${p.active ? '' : 'style="opacity:.55"'}><td class="part">${esc(p.number)}</td><td class="small dim">${esc(p.description || '')}</td><td class="num">${p.uses}</td>
          <td class="right nowrap"><button type="button" class="btn btn-sm" data-part-edit="${esc(p.id)}">Rename</button> <button type="button" class="btn btn-sm" data-part-merge="${esc(p.id)}">Merge</button> ${p.active ? `<button type="button" class="btn btn-sm btn-danger" data-part-off="${esc(p.id)}">Retire</button>` : `<button type="button" class="btn btn-sm" data-part-on="${esc(p.id)}">Restore</button>`}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No parts yet — they appear after the first submission.</td></tr>'}
        </tbody></table></div>
      ${parts.length > shownParts.length ? `<p class="small dim">Showing ${shownParts.length} of ${parts.length} — search to narrow.</p>` : ''}
      <div class="mt"><button type="button" class="btn btn-sm" data-part-new>+ Add a part by hand</button></div>
    </section>

    <div class="section-title">Tech link &amp; QR code</div>
    <section class="card">
      <p class="small dim" style="margin-top:0">Print this and put it in the parts room. Scanning it opens the form with the team key built in, so techs never type anything.</p>
      <div class="field"><label>Link</label><input type="url" readonly value="${esc(techLink())}" data-tech-link onclick="this.select()"></div>
      <div data-qr class="qr-sheet" style="padding:8px"><p class="small dim">Generating QR code…</p></div>
      <div class="row"><button type="button" class="btn" data-print-qr>Print QR sheet</button><button type="button" class="btn" data-copy-link>Copy link</button></div>
    </section>

    <div class="section-title">Server</div>
    <section class="card">
      <div class="row between"><span class="small dim mono">${esc(apiBase())}</span><button type="button" class="btn btn-sm" data-signout>Sign out</button></div>
    </section>`;
}

function techLink() {
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  return `${base}?k=${encodeURIComponent(state.config?.teamKey || '')}`;
}

async function renderQr() {
  const box = app.querySelector('[data-qr]');
  if (!box || !state.config?.teamKey) return;
  try {
    await loadScript(QR_URL);
    const qr = window.qrcode(0, 'M');
    qr.addData(techLink());
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch {
    box.innerHTML = '<p class="small dim">QR code library could not be loaded — copy the link instead.</p>';
  }
}

function printQr() {
  const svg = app.querySelector('[data-qr] svg')?.outerHTML;
  if (!svg) { toast('QR code is not ready yet', { error: true }); return; }
  const w = window.open('', '_blank');
  if (!w) { toast('Pop-up blocked — allow pop-ups to print', { error: true }); return; }
  w.document.write(`<!DOCTYPE html><html><head><title>Parts Checkout</title><style>
    body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:40px 24px;color:#000}
    h1{font-size:40px;margin:0 0 6px}p{font-size:20px;margin:6px 0;color:#333}svg{width:min(80vw,420px);height:auto;margin:24px 0}
    .small{font-size:13px;color:#777;word-break:break-all}</style></head><body>
    <h1>Parts Checkout</h1><p>Scan to sign out, return or request parts</p>${svg}
    <p class="small">${esc(techLink())}</p>
    <script>window.onload=function(){setTimeout(function(){window.print()},200)}<\/script></body></html>`);
  w.document.close();
}

/* ---------------- main render ---------------- */

function render() {
  if (!state.pin) return;
  const reviewed = state.week.reviewedAt;
  const weekDependent = ['tech', 'part', 'log'].includes(state.tab);
  const openReq = state.requests.filter(r => r.status !== 'closed').length;
  app.innerHTML = `
    <header class="hdr">
      <div class="logo">P</div>
      <div><h1>Parts Checkout</h1><span class="sub">Manager dashboard</span></div>
      <div class="spacer"></div>
      <button type="button" class="icon-btn" data-refresh title="Refresh" aria-label="Refresh">↻</button>
    </header>
    <div class="tabs">
      <button type="button" data-tab="tech" class="${state.tab === 'tech' ? 'on' : ''}">By tech</button>
      <button type="button" data-tab="part" class="${state.tab === 'part' ? 'on' : ''}">By part</button>
      <button type="button" data-tab="log" class="${state.tab === 'log' ? 'on' : ''}">Log${state.subs.length ? `<span class="n">${state.subs.length}</span>` : ''}</button>
      <button type="button" data-tab="requests" class="${state.tab === 'requests' ? 'on' : ''}">Requests${openReq ? `<span class="n">${openReq}</span>` : ''}</button>
      <button type="button" data-tab="setup" class="${state.tab === 'setup' ? 'on' : ''}">Setup</button>
    </div>
    ${weekDependent ? `
      <div class="weeknav">
        <button type="button" class="icon-btn" data-week="-1" aria-label="Previous week">‹</button>
        <div class="label">${esc(weekLabel(state.weekKey))}</div>
        <button type="button" class="icon-btn" data-week="1" aria-label="Next week">›</button>
        ${state.weekKey !== weekKey() ? '<button type="button" class="btn btn-sm" data-thisweek>This week</button>' : ''}
        <div class="spacer"></div>
        <button type="button" class="btn btn-sm ${reviewed ? '' : 'btn-primary'}" data-reviewed title="${reviewed ? 'Reviewed ' + esc(fmtDateTime(reviewed)) + ' — click to undo' : 'Mark this week as added up'}">${reviewed ? '✓ Reviewed ' + esc(fmtDateTime(reviewed)) : 'Mark week reviewed'}</button>
        <div class="menu">
          <button type="button" class="btn btn-sm" data-export-menu>Export ▾</button>
          <div class="menu-items" hidden data-export-items>
            <button type="button" data-export="xlsx">Excel workbook (.xlsx)</button>
            <button type="button" data-export="csv">CSV — by tech</button>
            <button type="button" data-export="copy">Copy table — by tech</button>
          </div>
        </div>
      </div>` : ''}
    ${state.error ? `<div class="banner danger">${esc(state.error)}</div>` : ''}
    ${state.loading && weekDependent ? '<div class="empty">Loading…</div>' :
      state.tab === 'tech' ? byTechBody() :
      state.tab === 'part' ? byPartBody() :
      state.tab === 'log' ? logBody() :
      state.tab === 'requests' ? requestsBody() : setupBody()}`;
  hydratePhotos(app);
  if (state.tab === 'setup') renderQr();
}

/* ---------------- editing a submission (manager) ---------------- */

function openEditSheet(s) {
  const wrap = document.createElement('div');
  const lines = s.lines.map(l => ({ id: uuid(), qty: l.qty, text: l.part || l.partText }));
  let type = s.type, dest = s.dest;
  const draw = () => {
    wrap.innerHTML = `
      <div class="field"><label>Technician</label>
        <select data-f="techId">${state.techs.filter(t => t.active || t.id === s.techId).map(t => `<option value="${esc(t.id)}" ${t.id === s.techId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Type</label><div class="seg">${['take', 'return', 'request'].map(t => `<button type="button" data-type="${t}" class="${type === t ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      <div class="field"><label>Parts</label>
        <div data-lines>${lines.map(l => `
          <div class="line" data-line="${l.id}" style="grid-template-columns:90px 1fr 40px">
            <input type="text" inputmode="decimal" data-qty value="${fmtQty(l.qty)}" style="text-align:center">
            <input type="text" data-part value="${esc(l.text)}" autocapitalize="characters" autocomplete="off" spellcheck="false" class="mono">
            <button type="button" class="icon-btn plain" data-removeline>✕</button>
          </div>`).join('')}</div>
        <button type="button" class="btn btn-sm" data-addline>+ Add part</button></div>
      <div class="field"><label>For</label><div class="seg">${[['van', 'Van stock'], ['job', 'Job #'], ['other', 'Other']].map(([d, l]) => `<button type="button" data-dest="${d}" class="${dest === d ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      ${dest !== 'van' ? `<div class="field"><label>${dest === 'job' ? 'Job number' : 'Where'}</label><input type="text" data-f="job" value="${esc(s.job || '')}" autocapitalize="characters" class="mono"></div>` : ''}
      ${type === 'request' ? `<div class="field"><label>Needed by</label><input type="date" data-f="neededBy" value="${esc(s.neededBy || '')}"></div>` : ''}
      <div class="field"><label>Note</label><textarea data-f="note" rows="2">${esc(s.note || '')}</textarea></div>
      <div class="sheet-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-save>Save</button></div>`;
  };
  const readLines = () => {
    for (const el of wrap.querySelectorAll('[data-line]')) {
      const l = lines.find(x => x.id === el.dataset.line);
      if (l) { l.qty = el.querySelector('[data-qty]').value; l.text = el.querySelector('[data-part]').value; }
    }
  };
  draw();
  const sh = sheet({ title: 'Edit submission', content: wrap });
  wrap.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.type) { readLines(); type = b.dataset.type; const job = wrap.querySelector('[data-f="job"]')?.value; s = { ...s, job: job ?? s.job, note: wrap.querySelector('[data-f="note"]').value }; draw(); return; }
    if (b.dataset.dest) { readLines(); dest = b.dataset.dest; s = { ...s, note: wrap.querySelector('[data-f="note"]').value }; draw(); return; }
    if (b.hasAttribute('data-addline')) { readLines(); lines.push({ id: uuid(), qty: 1, text: '' }); draw(); wrap.querySelectorAll('[data-part]')[lines.length - 1]?.focus(); return; }
    if (b.hasAttribute('data-removeline')) { readLines(); const id = b.closest('[data-line]').dataset.line; const i = lines.findIndex(l => l.id === id); if (i >= 0) lines.splice(i, 1); draw(); return; }
    if (b.hasAttribute('data-cancel')) { sh.close(); return; }
    if (b.hasAttribute('data-save')) {
      readLines();
      const payload = {
        type, techId: wrap.querySelector('[data-f="techId"]').value, dest,
        job: dest === 'van' ? '' : (wrap.querySelector('[data-f="job"]')?.value || '').trim(),
        neededBy: type === 'request' ? (wrap.querySelector('[data-f="neededBy"]')?.value || null) : null,
        note: wrap.querySelector('[data-f="note"]').value.trim(), photoKey: s.photoKey || null,
        lines: lines.map(l => ({ partText: l.text.trim().toUpperCase().replace(/\s+/g, ' '), qty: Number(String(l.qty).replace(',', '.')) })).filter(l => l.partText),
      };
      try {
        await manager(`/v1/submissions/${s.id}`, { method: 'PUT', body: payload });
        sh.close(); toast('Saved');
        await Promise.all([loadWeek(), state.tab === 'requests' ? loadRequests() : null]);
        render();
      } catch (err) { toast(err.message, { error: true, duration: 4000 }); }
    }
  });
}

async function deleteSubmission(id) {
  const yes = await confirmDialog('Delete this submission?', { okLabel: 'Delete', danger: true });
  if (!yes) return;
  try {
    await manager(`/v1/submissions/${id}`, { method: 'DELETE' });
    toast('Deleted');
    await Promise.all([loadWeek(), state.tab === 'requests' ? loadRequests() : null]);
    render();
  } catch (e) { toast(e.message, { error: true }); }
}

/* ---------------- setup actions ---------------- */

async function saveTechs(techs) {
  const r = await manager('/v1/techs', { method: 'PUT', body: { techs } });
  state.techs = r.techs;
}
function openTechSheet(t) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="field"><label>Name</label><input type="text" data-f="name" value="${esc(t.name)}" autocapitalize="words"></div>
    <div class="field"><label>Truck / van number (optional)</label><input type="text" data-f="truck" value="${esc(t.truck || '')}"></div>
    <div class="sheet-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-save>Save</button></div>`;
  const sh = sheet({ title: 'Edit technician', content: wrap });
  wrap.querySelector('[data-cancel]').addEventListener('click', () => sh.close());
  wrap.querySelector('[data-save]').addEventListener('click', async () => {
    const name = wrap.querySelector('[data-f="name"]').value.trim();
    if (!name) { toast('Name is required', { error: true }); return; }
    try { await saveTechs([{ id: t.id, name, truck: wrap.querySelector('[data-f="truck"]').value.trim(), active: t.active }]); sh.close(); render(); }
    catch (e) { toast(e.message, { error: true }); }
  });
}

async function savePart(p) {
  const r = await manager('/v1/parts', { method: 'PUT', body: { parts: [p] } });
  state.parts = r.parts;
}
function openPartSheet(p) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="field"><label>Part number</label><input type="text" data-f="number" value="${esc(p.number || '')}" autocapitalize="characters" class="mono" autocomplete="off" spellcheck="false"></div>
    <div class="field"><label>Description (optional — shown in the pick list)</label><input type="text" data-f="description" value="${esc(p.description || '')}" placeholder="e.g. Wireless door contact, white"></div>
    <div class="sheet-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-save>Save</button></div>`;
  const sh = sheet({ title: p.id ? 'Rename part' : 'Add part', content: wrap });
  wrap.querySelector('[data-cancel]').addEventListener('click', () => sh.close());
  wrap.querySelector('[data-save]').addEventListener('click', async () => {
    const number = wrap.querySelector('[data-f="number"]').value.trim().toUpperCase();
    if (!number) { toast('Part number is required', { error: true }); return; }
    try {
      await savePart({ id: p.id, number, description: wrap.querySelector('[data-f="description"]').value.trim(), active: p.active !== false });
      sh.close(); render();
    } catch (e) { toast(e.message, { error: true, duration: 4500 }); }
  });
}
function openMergeSheet(from) {
  const others = state.parts.filter(p => p.id !== from.id && p.active).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <p class="small dim" style="margin-top:0">Every submission that used <b class="mono">${esc(from.number)}</b> will count under the part you choose, and future entries of “${esc(from.number)}” map to it automatically.</p>
    <div class="field"><label>Merge into</label>
      <input type="search" data-q placeholder="Type to filter" autocomplete="off">
      <select data-into size="8" style="margin-top:8px;height:auto">${others.map(p => `<option value="${esc(p.id)}">${esc(p.number)}${p.description ? ' — ' + esc(p.description) : ''}</option>`).join('')}</select></div>
    <div class="sheet-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-save>Merge</button></div>`;
  const sh = sheet({ title: 'Merge part', content: wrap });
  const sel = wrap.querySelector('[data-into]');
  wrap.querySelector('[data-q]').addEventListener('input', (e) => {
    const q = e.target.value.toUpperCase();
    sel.innerHTML = others.filter(p => (p.number + ' ' + (p.description || '')).toUpperCase().includes(q)).map(p => `<option value="${esc(p.id)}">${esc(p.number)}${p.description ? ' — ' + esc(p.description) : ''}</option>`).join('');
  });
  wrap.querySelector('[data-cancel]').addEventListener('click', () => sh.close());
  wrap.querySelector('[data-save]').addEventListener('click', async () => {
    const intoId = sel.value;
    if (!intoId) { toast('Choose a part to merge into', { error: true }); return; }
    const into = others.find(p => p.id === intoId);
    const yes = await confirmDialog(`Merge "${from.number}" into "${into.number}"? This cannot be undone.`, { okLabel: 'Merge' });
    if (!yes) return;
    try {
      await manager('/v1/parts/merge', { method: 'POST', body: { fromId: from.id, intoId } });
      sh.close(); toast('Merged');
      await Promise.all([loadParts(), loadWeek()]);
      render();
    } catch (e) { toast(e.message, { error: true }); }
  });
}

/* ---------------- export ---------------- */

function download(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function doExport(kind) {
  const agg = state.agg;
  const name = `parts-week-${state.weekKey}`;
  if (kind === 'copy') {
    try { await navigator.clipboard.writeText(toTsv(techRows(agg))); toast('Copied — paste into Excel'); }
    catch { toast('Could not copy', { error: true }); }
    return;
  }
  if (kind === 'csv') { download(`${name}-by-tech.csv`, toCsv(techRows(agg))); return; }
  try {
    await loadScript(XLSX_URL);
    const X = window.XLSX;
    const wb = X.utils.book_new();
    const add = (rows, title, empty) => X.utils.book_append_sheet(wb, X.utils.json_to_sheet(rows.length ? rows : [empty]), title);
    add(techRows(agg), 'By tech', { Tech: '', Part: '(nothing this week)', Taken: '', Returned: '', Net: '', For: '' });
    add(partRows(agg), 'By part', { Part: '(nothing this week)', Taken: '', Returned: '', Net: '', Techs: '' });
    add(logRows(state.subs), 'Log', { When: '', Tech: '', Type: '', Part: '(nothing this week)', Qty: '', For: '', 'Needed by': '', Note: '' });
    if (!state.loadedTabs.has('requests')) { try { await loadRequests(); } catch { /* skip */ } }
    add(logRows(state.requests.filter(r => r.status !== 'closed')).map(({ Type, ...r }) => r), 'Open requests', { When: '', Tech: '', Part: '(none)', Qty: '', For: '', 'Needed by': '', Note: '' });
    X.writeFile(wb, `${name}.xlsx`);
  } catch (e) {
    toast('Excel library unavailable — downloading CSV instead', { error: true, duration: 4000 });
    download(`${name}-by-tech.csv`, toCsv(techRows(agg)));
  }
}

/* ---------------- events ---------------- */

app.addEventListener('click', async (e) => {
  const b = e.target.closest('button, [data-toggle]');
  const menu = app.querySelector('[data-export-items]');
  if (menu && !e.target.closest('.menu')) menu.hidden = true;
  if (!b) return;
  const d = b.dataset;
  if (d.tab) { openTab(d.tab); return; }
  if (b.hasAttribute('data-refresh')) { state.loadedTabs.clear(); await openTab(state.tab); loadWeek(); return; }
  if (d.week) { state.weekKey = shiftWeek(state.weekKey, Number(d.week)); loadWeek(); return; }
  if (b.hasAttribute('data-thisweek')) { state.weekKey = weekKey(); loadWeek(); return; }
  if (b.hasAttribute('data-reviewed')) {
    const reviewed = !state.week.reviewedAt;
    if (!reviewed && !(await confirmDialog('Clear the reviewed mark for this week?', { okLabel: 'Clear' }))) return;
    try { const r = await manager(`/v1/weeks/${state.weekKey}`, { method: 'PUT', body: { reviewed } }); state.week = r.week; toast(reviewed ? 'Week marked reviewed' : 'Reviewed mark cleared'); render(); }
    catch (err) { toast(err.message, { error: true }); }
    return;
  }
  if (b.hasAttribute('data-export-menu')) { menu.hidden = !menu.hidden; return; }
  if (d.export) { menu.hidden = true; doExport(d.export); return; }
  if (d.toggle) { state.expanded.has(d.toggle) ? state.expanded.delete(d.toggle) : state.expanded.add(d.toggle); render(); return; }
  if (d.edit) { const s = state.subs.find(x => x.id === d.edit) || state.requests.find(x => x.id === d.edit); if (s) openEditSheet(s); return; }
  if (d.delete) { deleteSubmission(d.delete); return; }
  if (b.classList.contains('thumb')) return;

  /* setup */
  if (b.hasAttribute('data-tech-add-btn')) {
    const ta = app.querySelector('[data-tech-add]');
    const techs = ta.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [name, truck] = l.split(',').map(x => x.trim()); return { name, truck: truck || '' }; });
    if (!techs.length) return;
    try { await saveTechs(techs); toast(`Added ${techs.length}`); render(); } catch (err) { toast(err.message, { error: true }); }
    return;
  }
  if (d.techEdit) { const t = state.techs.find(x => x.id === d.techEdit); if (t) openTechSheet(t); return; }
  if (d.techOff) {
    const t = state.techs.find(x => x.id === d.techOff);
    if (t && await confirmDialog(`Remove ${t.name} from the pick list? Their past submissions are kept.`, { okLabel: 'Remove', danger: true })) {
      try { await manager(`/v1/techs/${t.id}`, { method: 'DELETE' }); await loadTechs(); render(); } catch (err) { toast(err.message, { error: true }); }
    }
    return;
  }
  if (d.techOn) { const t = state.techs.find(x => x.id === d.techOn); if (t) { try { await saveTechs([{ ...t, active: true }]); render(); } catch (err) { toast(err.message, { error: true }); } } return; }
  if (b.hasAttribute('data-part-new')) { openPartSheet({ active: true }); return; }
  if (d.partEdit) { const p = state.parts.find(x => x.id === d.partEdit); if (p) openPartSheet(p); return; }
  if (d.partMerge) { const p = state.parts.find(x => x.id === d.partMerge); if (p) openMergeSheet(p); return; }
  if (d.partOff) { try { await manager(`/v1/parts/${d.partOff}`, { method: 'DELETE' }); await loadParts(); render(); } catch (err) { toast(err.message, { error: true }); } return; }
  if (d.partOn) { const p = state.parts.find(x => x.id === d.partOn); if (p) { try { await savePart({ ...p, active: true }); render(); } catch (err) { toast(err.message, { error: true }); } } return; }
  if (b.hasAttribute('data-print-qr')) { printQr(); return; }
  if (b.hasAttribute('data-copy-link')) { try { await navigator.clipboard.writeText(techLink()); toast('Link copied'); } catch { toast('Could not copy', { error: true }); } return; }
  if (b.hasAttribute('data-signout')) { signOut(); return; }
});

app.addEventListener('click', (e) => {
  const img = e.target.closest('img.thumb');
  if (!img || !img.src.startsWith('blob:')) return;
  sheet({ content: `<img class="photo-view" src="${img.src}" alt="photo">` });
});

app.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.status) {
    try { await manager(`/v1/submissions/${el.dataset.status}/status`, { method: 'POST', body: { status: el.value } }); await loadRequests(); render(); toast('Status updated'); }
    catch (err) { toast(err.message, { error: true }); }
    return;
  }
  if (el.hasAttribute('data-show-retired')) { state.showRetired = el.checked; render(); }
});
app.addEventListener('input', (e) => {
  if (e.target.hasAttribute('data-part-search')) {
    state.partQuery = e.target.value;
    const caret = e.target.selectionStart;
    render();
    const n = app.querySelector('[data-part-search]');
    if (n) { n.focus({ preventScroll: true }); try { n.setSelectionRange(caret, caret); } catch { /* ok */ } }
  }
});

/* ---------------- boot ---------------- */

(function boot() {
  apiBase(); // remembers ?api= on the device
  if (new URLSearchParams(location.search).has('api')) history.replaceState(null, '', location.pathname);
  state.pin = store.get('managerPin');
  if (!state.pin) { renderLogin(); return; }
  loadWeek();
})();
