// All Parts: the team's shared parts catalog, served from the Worker's D1
// database. Every part the team stocks is listed — including ones this phone
// doesn't have. Techs can pull a part into their van (stock tracking only);
// managers can edit or retire catalog entries.
import { fetchCatalog, cachedCatalog, removeCatalogItem, publishItems, addPartToVan } from '../catalog.js';
import { allItems } from '../items.js';
import { openItemForm } from './sheets.js';
import { appRole } from '../requests.js';
import { esc, fmtQty, toast, confirmDialog, sheet } from '../ui.js';
import * as nav from '../nav.js';

const section = () => document.getElementById('screen-catalog');

let data = null;     // { items, cached, at }
let local = [];      // items on this phone
let role = 'solo';
let query = '';

function localMatch(part) {
  if (part.barcode) {
    const hit = local.find(i => (i.barcode || '') === part.barcode);
    if (hit) return hit;
  }
  return local.find(i =>
    i.name.trim().toLowerCase() === part.name.trim().toLowerCase() &&
    (i.unit || 'pcs') === (part.unit || 'pcs'));
}

function partRow(part) {
  const mine = localMatch(part);
  const subBits = [
    part.category ? esc(part.category) : '',
    part.barcode ? esc(part.barcode) : '',
    part.minQty > 0 ? `min ${fmtQty(part.minQty)}` : '',
    typeof part.cost === 'number' && part.cost > 0 ? `$${part.cost.toFixed(2)}/${esc(part.unit)}` : '',
  ].filter(Boolean);
  return `
    <div class="item-row" data-part="${esc(part.id)}">
      ${part.photo ? `<div class="thumb" data-photo-key="${esc(part.photo)}"></div>` : ''}
      <div class="item-main">
        <div class="item-name">${esc(part.name)}</div>
        <div class="item-sub">${subBits.join(' · ') || '&nbsp;'}</div>
      </div>
      ${mine
        ? `<div class="item-qty"><div class="q">${fmtQty(mine.qty)}</div><div class="u">${esc(mine.unit)} in van</div></div>`
        : `<button class="btn btn-sm" data-addvan>+ My van</button>`}
    </div>`;
}

async function render() {
  const sec = section();
  if (!data) {
    sec.innerHTML = `
      <header class="hdr">
        <button class="icon-btn" data-back aria-label="Back">←</button>
        <h1>All Parts</h1>
      </header>
      <div class="content"><div class="empty">Loading the parts catalog…</div></div>`;
    sec.querySelector('[data-back]').addEventListener('click', () => nav.back());
    return;
  }

  const items = data.items || [];
  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter(p => (p.name + ' ' + (p.barcode || '') + ' ' + (p.category || '')).toLowerCase().includes(q))
    : items;
  const notInVan = filtered.filter(p => !localMatch(p)).length;

  sec.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-back aria-label="Back">←</button>
      <h1>All Parts<span class="sub">${items.length} part${items.length === 1 ? '' : 's'} in the team database${notInVan ? ` · ${notInVan} not in your van` : ''}</span></h1>
      <button class="icon-btn" data-refresh aria-label="Refresh">↻</button>
    </header>
    <div class="content" data-body>
      ${data.cached ? '<div class="banner">⚠ Could not reach the server — showing the last downloaded catalog.</div>' : ''}
      ${role === 'manager' ? '<div class="banner info">Tap a part to edit or retire it. Changes go to the shared database, not to anyone\'s counts.</div>' : ''}
      <div class="searchbar"><input type="search" placeholder="Search all parts…" value="${esc(query)}" data-search></div>
      ${filtered.length ? filtered.map(partRow).join('') : `<div class="empty">${items.length ? 'Nothing matches.' : 'The catalog is empty.<br>Manager items and approved requests appear here automatically.'}</div>`}
      ${role === 'tech' ? '<button class="btn btn-block" data-reqnew style="margin-top:14px">＋ Can\'t find it? Request a new part</button>' : ''}
    </div>`;

  sec.querySelector('[data-back]').addEventListener('click', () => nav.back());
  sec.querySelector('[data-refresh]').addEventListener('click', () => load(true));

  const searchEl = sec.querySelector('[data-search]');
  searchEl.addEventListener('input', async () => {
    query = searchEl.value;
    const caret = searchEl.selectionStart;
    await render();
    const el = section().querySelector('[data-search]');
    el.focus({ preventScroll: true });
    try { el.setSelectionRange(caret, caret); } catch { /* ok */ }
  });

  sec.querySelector('[data-body]').addEventListener('click', async (e) => {
    if (e.target.closest('[data-reqnew]')) {
      openItemForm({
        mode: 'request',
        prefill: { name: query.trim(), qty: 0 },
        onRequested: () => {},
      });
      return;
    }
    const row = e.target.closest('[data-part]');
    if (!row) return;
    const part = items.find(p => p.id === row.dataset.part);
    if (!part) return;

    if (e.target.closest('[data-addvan]')) {
      try {
        await addPartToVan(part);
        toast(`${part.name} added to your van — set the amount you have`);
        local = await allItems();
        render();
      } catch (err) {
        toast(err.message || 'Could not add', { error: true });
      }
      return;
    }
    if (role === 'manager') openEditSheet(part);
  });

  if (items.some(p => p.photo)) import('../photos.js').then(({ hydrateThumbs }) => hydrateThumbs(sec));
}

function openEditSheet(part) {
  const f = (label, key, val, attrs = '') => `
    <div class="field"><label>${label}</label><input type="text" data-cf="${key}" value="${esc(val ?? '')}" ${attrs} autocomplete="off"></div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    ${f('Name *', 'name', part.name)}
    ${f('Barcode', 'barcode', part.barcode, 'inputmode="numeric"')}
    <div class="field-row">
      ${f('Unit', 'unit', part.unit || 'pcs')}
      ${f('Category', 'category', part.category)}
    </div>
    <div class="field-row">
      ${f('Min stock', 'minQty', fmtQty(part.minQty || 0), 'inputmode="decimal"')}
      ${f('Cost per unit ($)', 'cost', part.cost ?? '', 'inputmode="decimal" placeholder="optional"')}
    </div>
    ${f('Notes', 'notes', part.notes)}
    <p style="color:var(--text-dim);font-size:13px;line-height:1.5;margin:-4px 0 12px">
      This edits the shared database entry. It does not change anyone's stock counts,
      and phones keep their local copy until they re-add the part.
    </p>
    <div class="sheet-actions">
      <button type="button" class="btn" data-retire style="color:var(--danger)">Remove from catalog</button>
      <button type="button" class="btn btn-primary" data-save>Save</button>
    </div>`;
  const s = sheet({ title: `Edit part — <span class="sheet-item-name">${esc(part.name)}</span>`, content: wrap });

  wrap.querySelector('[data-save]').addEventListener('click', async () => {
    const out = { id: part.id, photo: part.photo };
    wrap.querySelectorAll('[data-cf]').forEach(i => { out[i.dataset.cf] = i.value; });
    if (!out.name.trim()) { toast('Name is required', { error: true }); return; }
    out.minQty = parseFloat(String(out.minQty).replace(',', '.')) || 0;
    out.cost = parseFloat(String(out.cost).replace(',', '.')) || undefined;
    const r = await publishItems(out);
    s.close();
    toast(r.ok ? 'Catalog updated' : 'Saved — will upload when back online');
    load(true);
  });
  wrap.querySelector('[data-retire]').addEventListener('click', async () => {
    const yes = await confirmDialog(
      `Remove "${part.name}" from the team catalog? Phones that stock it keep their local item and counts — this only retires it from the shared parts list.`,
      { danger: true, okLabel: 'Remove' });
    if (!yes) return;
    try {
      await removeCatalogItem(part.id);
      s.close();
      toast('Removed from catalog');
      load(true);
    } catch (e) {
      toast(e.message, { error: true });
    }
  });
}

async function load(force = false) {
  local = await allItems();
  if (!force) {
    const c = await cachedCatalog();
    if (c) { data = c; render(); }
  }
  try {
    data = await fetchCatalog();
  } catch (e) {
    if (!data) { toast(e.message, { error: true }); nav.back(); return; }
    data = { ...data, cached: true };
  }
  render();
}

export default {
  async show() {
    role = await appRole();
    query = '';
    data = null;
    render();
    await load();
  },
};
