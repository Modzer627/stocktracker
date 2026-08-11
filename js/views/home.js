// Home: search, low-stock section pinned on top, full item list, action bar.
import { applyStockChange } from '../db.js';
import { allItems, isLow, searchFilter } from '../items.js';
import { getSession, progress } from '../stocktake.js';
import { backupBannerNeeded } from '../backup.js';
import { exportInventoryXlsx } from '../export.js';
import { exportBackup } from '../backup.js';
import { $, esc, fmtQty, toast, sheet } from '../ui.js';
import * as nav from '../nav.js';
import { managerConfigured } from '../sync.js';
import { openUseSheet, openItemForm } from './sheets.js';

const section = () => document.getElementById('screen-home');
let query = '';

function rowHTML(item) {
  const low = isLow(item);
  const subBits = [];
  if (low) subBits.push('<span class="low-tag">LOW</span>');
  if (item.location) subBits.push(esc(item.location));
  if (item.category) subBits.push(esc(item.category));
  if (item.minQty > 0) subBits.push(`min ${fmtQty(item.minQty)}`);
  return `
    <div class="item-row${low ? ' low' : ''}" data-id="${item.id}">
      <div class="item-main">
        <div class="item-name">${esc(item.name)}</div>
        <div class="item-sub">${subBits.join(' · ') || '&nbsp;'}</div>
      </div>
      <div class="item-qty">
        <div class="q${item.qty < 0 ? ' neg' : ''}">${fmtQty(item.qty)}</div>
        <div class="u">${esc(item.unit)}</div>
      </div>
      <div class="stepper">
        <button data-plus aria-label="Add one">+</button>
        <button data-minus aria-label="Use">−</button>
      </div>
    </div>`;
}

async function bannersHTML() {
  const out = [];
  if (window.__updateReady) {
    out.push(`<div class="banner info">A new version is ready.<button class="btn btn-sm btn-primary" data-update>Update</button></div>`);
  }
  const session = await getSession();
  if (session) {
    const items = await allItems();
    const p = progress(session, items);
    out.push(`<div class="banner info">Stocktake in progress — ${p.counted}/${p.total} counted.<button class="btn btn-sm btn-primary" data-resume-st>Resume</button></div>`);
  }
  const items2 = await allItems();
  if (await backupBannerNeeded(items2.length)) {
    out.push(`<div class="banner">No recent backup — your data lives only on this phone.<button class="btn btn-sm" data-backup>Back up</button></div>`);
  }
  return out.join('');
}

async function render() {
  const sec = section();
  const items = await allItems();
  const filtered = searchFilter(items, query);
  const lowItems = filtered.filter(isLow);
  const banners = await bannersHTML();

  const showTeam = await managerConfigured();
  sec.innerHTML = `
    <header class="hdr">
      <h1>Stock Tracker</h1>
      <button class="icon-btn" data-insights aria-label="Insights">📈</button>
      ${showTeam ? '<button class="icon-btn" data-team aria-label="Team">👥</button>' : ''}
      <button class="icon-btn" data-settings aria-label="Settings">⚙︎</button>
    </header>
    <div class="content">
      ${banners}
      <div class="searchbar"><input type="search" placeholder="Search name, barcode, category…" value="${esc(query)}" data-search></div>
      ${items.length === 0 ? `
        <div class="empty"><span class="big">📦</span>No items yet.<br>Scan a barcode or add your first item below.</div>
      ` : `
        ${lowItems.length ? `
          <div class="section-title">Low stock <span class="count-badge">${lowItems.length}</span></div>
          ${lowItems.map(rowHTML).join('')}
        ` : ''}
        <div class="section-title">All items (${filtered.length})</div>
        ${filtered.length ? filtered.map(rowHTML).join('') : `<div class="empty">Nothing matches “${esc(query)}”.</div>`}
      `}
    </div>
    <div class="actionbar">
      <button class="btn btn-primary" data-scan><span class="ico">▣</span>Scan</button>
      <button class="btn" data-add><span class="ico">＋</span>Add</button>
      <button class="btn" data-stocktake><span class="ico">✓</span>Stocktake</button>
      <button class="btn" data-export><span class="ico">⇪</span>Export</button>
    </div>`;

  wire(sec, items);
}

function wire(sec, items) {
  const searchEl = sec.querySelector('[data-search]');
  searchEl.addEventListener('input', () => {
    query = searchEl.value;
    refreshLists();
  });

  sec.querySelector('[data-settings]').addEventListener('click', () => nav.show('settings'));
  sec.querySelector('[data-insights]').addEventListener('click', () => nav.show('insights'));
  sec.querySelector('[data-team]')?.addEventListener('click', () => nav.show('team'));
  sec.querySelector('[data-scan]').addEventListener('click', () => nav.show('scan'));
  sec.querySelector('[data-add]').addEventListener('click', () => openItemForm({ onSaved: (it) => { if (it) render(); } }));
  sec.querySelector('[data-stocktake]').addEventListener('click', () => nav.show('stocktake'));
  sec.querySelector('[data-export]').addEventListener('click', openExportSheet);

  sec.querySelector('[data-update]')?.addEventListener('click', () => window.__applyUpdate && window.__applyUpdate());
  sec.querySelector('[data-resume-st]')?.addEventListener('click', () => nav.show('stocktake'));
  sec.querySelector('[data-backup]')?.addEventListener('click', async () => {
    const r = await exportBackup();
    if (r === 'shared' || r === 'downloaded') { toast('Backup saved'); render(); }
  });

  sec.querySelector('.content').addEventListener('click', async (e) => {
    const row = e.target.closest('.item-row');
    if (!row) return;
    const item = (await allItems()).find(i => i.id === row.dataset.id);
    if (!item) return;
    if (e.target.closest('[data-plus]')) {
      const updated = await applyStockChange({ itemId: item.id, delta: 1, type: 'in' });
      toast(`+1 ${updated.name} (now ${fmtQty(updated.qty)})`, { duration: 1400 });
      refreshLists();
    } else if (e.target.closest('[data-minus]')) {
      openUseSheet(item, { onDone: (u) => { if (u) refreshLists(); } });
    } else {
      nav.show('item', { id: item.id });
    }
  });
}

/** Re-render only the list area, keeping the search box focused (mobile keyboards). */
async function refreshLists() {
  const sec = section();
  const searchEl = sec.querySelector('[data-search]');
  const hadFocus = document.activeElement === searchEl;
  const caret = searchEl ? searchEl.selectionStart : 0;
  await render();
  if (hadFocus) {
    const el = section().querySelector('[data-search]');
    el.focus({ preventScroll: true });
    try { el.setSelectionRange(caret, caret); } catch { /* search inputs may refuse */ }
  }
}

function openExportSheet() {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <button class="btn btn-block btn-primary" data-xlsx style="margin-bottom:10px">📊 Excel spreadsheet (.xlsx)</button>
    <button class="btn btn-block" data-json>💾 Backup file (.json)</button>
    <p style="color:var(--text-dim);font-size:13px;margin-top:12px;line-height:1.5">
      Excel: Inventory + Usage Log sheets, for the office.<br>
      Backup: complete copy of your data — restore it in Settings or import it on your other phone.
    </p>`;
  const s = sheet({ title: 'Export', content: wrap });
  wrap.querySelector('[data-xlsx]').addEventListener('click', async () => {
    s.close();
    const r = await exportInventoryXlsx();
    if (r === 'downloaded') toast('Excel file downloaded');
    else if (r === 'shared') toast('Excel file shared');
  });
  wrap.querySelector('[data-json]').addEventListener('click', async () => {
    s.close();
    const r = await exportBackup();
    if (r === 'shared' || r === 'downloaded') { toast('Backup saved'); render(); }
  });
}

export default {
  show: () => render(),
  refresh: () => render(),
};
