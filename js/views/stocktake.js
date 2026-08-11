// Stocktake screens: the counting checklist and the review/confirm screen.
import { allItems, searchFilter } from '../items.js';
import { getSession, startSession, saveSession, clearSession, setCount, progress, buildReview, commit } from '../stocktake.js';
import { exportVarianceXlsx } from '../export.js';
import { esc, fmtQty, toast, confirmDialog, sheet } from '../ui.js';
import * as nav from '../nav.js';

const stSection = () => document.getElementById('screen-stocktake');
const revSection = () => document.getElementById('screen-review');

let session = null;
let query = '';

/* ---------------- counting screen ---------------- */

function stRow(item) {
  const counted = item.id in session.counts;
  const val = counted ? fmtQty(session.counts[item.id]) : '';
  return `
    <div class="st-row${counted ? ' counted' : ''}" data-id="${item.id}">
      <div class="st-main">
        <div class="item-name">${esc(item.name)}</div>
        <div class="st-expected">Expected ${fmtQty(item.qty)} ${esc(item.unit)}${item.location ? ' · ' + esc(item.location) : ''}</div>
      </div>
      <button class="st-ok" data-match title="Matches expected">✓</button>
      <input type="text" inputmode="decimal" placeholder="—" value="${val}" data-count>
    </div>`;
}

async function renderCount() {
  const sec = stSection();
  const items = await allItems();
  const filtered = searchFilter(items, query);
  const p = progress(session, items);

  sec.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-back aria-label="Back">←</button>
      <h1>Stocktake<span class="sub">${p.counted} of ${p.total} counted — nothing changes until you confirm</span></h1>
      <button class="icon-btn" data-menu aria-label="More">⋯</button>
    </header>
    <div class="content">
      <div class="progressbar"><div style="width:${p.total ? (p.counted / p.total * 100) : 0}%"></div></div>
      <div class="searchbar" style="margin-top:10px"><input type="search" placeholder="Search items…" value="${esc(query)}" data-search></div>
      ${filtered.length ? filtered.map(stRow).join('') : '<div class="empty">Nothing matches.</div>'}
    </div>
    <div class="actionbar">
      <button class="btn btn-primary" data-scan><span class="ico">▣</span>Scan &amp; count</button>
      <button class="btn" data-review><span class="ico">✓</span>Review (${p.counted})</button>
    </div>`;

  sec.querySelector('[data-back]').addEventListener('click', () => nav.back());
  sec.querySelector('[data-scan]').addEventListener('click', () => nav.show('scan', { mode: 'count' }));
  sec.querySelector('[data-review]').addEventListener('click', () => nav.show('review'));
  sec.querySelector('[data-menu]').addEventListener('click', openMenu);

  const searchEl = sec.querySelector('[data-search]');
  searchEl.addEventListener('input', async () => {
    query = searchEl.value;
    const caret = searchEl.selectionStart;
    await renderCount();
    const el = stSection().querySelector('[data-search]');
    el.focus({ preventScroll: true });
    try { el.setSelectionRange(caret, caret); } catch { /* ok */ }
  });

  sec.querySelector('.content').addEventListener('change', async (e) => {
    const row = e.target.closest('.st-row');
    if (!row || !e.target.matches('[data-count]')) return;
    const raw = e.target.value.trim().replace(',', '.');
    setCount(session, row.dataset.id, raw === '' ? null : parseFloat(raw));
    await saveSession(session);
    refreshHeader();
    row.classList.toggle('counted', row.dataset.id in session.counts);
    if (raw !== '' && !Number.isNaN(parseFloat(raw))) e.target.value = fmtQty(parseFloat(raw));
  });
  sec.querySelector('.content').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-match]');
    if (!btn) return;
    const row = btn.closest('.st-row');
    const items2 = await allItems();
    const item = items2.find(i => i.id === row.dataset.id);
    if (!item) return;
    setCount(session, item.id, item.qty);
    await saveSession(session);
    row.querySelector('[data-count]').value = fmtQty(item.qty);
    row.classList.add('counted');
    refreshHeader();
  });
}

async function refreshHeader() {
  const items = await allItems();
  const p = progress(session, items);
  const sub = stSection().querySelector('.hdr .sub');
  if (sub) sub.textContent = `${p.counted} of ${p.total} counted — nothing changes until you confirm`;
  const bar = stSection().querySelector('.progressbar div');
  if (bar) bar.style.width = `${p.total ? (p.counted / p.total * 100) : 0}%`;
  const rev = stSection().querySelector('[data-review]');
  if (rev) rev.innerHTML = `<span class="ico">✓</span>Review (${p.counted})`;
}

function openMenu() {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <button class="btn btn-block" data-pause style="margin-bottom:10px">Pause — continue later</button>
    <button class="btn btn-block" data-discard style="color:var(--danger)">Discard this stocktake</button>`;
  const s = sheet({ title: 'Stocktake', content: wrap });
  wrap.querySelector('[data-pause]').addEventListener('click', () => { s.close(); toast('Stocktake saved — resume from the home screen'); nav.resetTo('home'); });
  wrap.querySelector('[data-discard]').addEventListener('click', async () => {
    s.close();
    const yes = await confirmDialog('Throw away this count? Stock levels stay exactly as they are.', { danger: true, okLabel: 'Discard' });
    if (!yes) return;
    await clearSession();
    session = null;
    toast('Stocktake discarded');
    nav.resetTo('home');
  });
}

/* ---------------- review screen ---------------- */

async function renderReview() {
  const sec = revSection();
  const items = await allItems();
  const review = buildReview(items, session);

  const rows = review.counted.map(r => `
    <div class="rev-row">
      <div class="rev-main">
        <div>${esc(r.item.name)}</div>
        <div class="txn-sub">${fmtQty(r.expected)} → ${fmtQty(r.counted)} ${esc(r.item.unit)}</div>
      </div>
      <div class="rev-diff ${r.diff > 0 ? 'pos' : r.diff < 0 ? 'neg' : 'zero'}">${r.diff > 0 ? '+' : ''}${r.diff === 0 ? 'ok' : fmtQty(r.diff)}</div>
    </div>`).join('');

  sec.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-back aria-label="Back">←</button>
      <h1>Review stocktake<span class="sub">${review.counted.length} counted · ${review.variances} difference${review.variances === 1 ? '' : 's'} · ${review.uncounted.length} not counted</span></h1>
    </header>
    <div class="content">
      ${review.counted.length ? `
        <div class="section-title">Counted</div>
        ${rows}
      ` : '<div class="empty">Nothing counted yet — go back and scan or type counts.</div>'}
      ${review.uncounted.length ? `
        <div class="section-title" style="margin-top:18px">Not counted (${review.uncounted.length})</div>
        <div class="banner info" style="align-items:flex-start">
          <label style="display:flex;gap:10px;align-items:center;width:100%">
            <input type="checkbox" data-zero style="width:22px;height:22px;flex:0 0 auto">
            <span>Set all uncounted items to <b>zero</b>. Leave off to keep their current numbers.</span>
          </label>
        </div>
        ${review.uncounted.map(i => `
          <div class="rev-row">
            <div class="rev-main"><div>${esc(i.name)}</div></div>
            <div class="rev-nums txn-sub">stays ${fmtQty(i.qty)} ${esc(i.unit)}</div>
          </div>`).join('')}
      ` : ''}
    </div>
    <div class="actionbar">
      <button class="btn" data-export-var><span class="ico">⇪</span>Export</button>
      <button class="btn btn-primary" data-confirm ${review.counted.length ? '' : 'disabled'}><span class="ico">✓</span>Confirm &amp; update stock</button>
    </div>`;

  sec.querySelector('[data-back]').addEventListener('click', () => nav.back());
  sec.querySelector('[data-export-var]').addEventListener('click', async () => {
    const r = await exportVarianceXlsx(review);
    if (r === 'shared' || r === 'downloaded') toast('Stocktake report exported');
  });
  const zeroBox = () => !!sec.querySelector('[data-zero]')?.checked;
  sec.querySelector('[data-zero]')?.addEventListener('change', (e) => {
    sec.querySelectorAll('.rev-nums').forEach((n, idx) => {
      const item = review.uncounted[idx];
      n.textContent = e.target.checked ? `→ 0 ${item.unit}` : `stays ${fmtQty(item.qty)} ${item.unit}`;
    });
  });
  sec.querySelector('[data-confirm]').addEventListener('click', async () => {
    const zero = zeroBox();
    const changes = review.variances + (zero ? review.uncounted.filter(i => i.qty !== 0).length : 0);
    const yes = await confirmDialog(
      changes === 0
        ? 'Everything matches — confirm to finish the stocktake with no changes?'
        : `Apply ${changes} stock correction${changes === 1 ? '' : 's'} now? This updates your inventory in one go.`,
      { okLabel: 'Update stock' }
    );
    if (!yes) return;
    const result = await commit(review, { zeroUncounted: zero });
    session = null;
    toast(`Stocktake done — ${result.adjusted} adjusted${result.zeroed ? `, ${result.zeroed} zeroed` : ''}, ${result.unchanged} matched`, { duration: 4200 });
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <p style="margin-bottom:14px;font-size:15px">Save the variance report for your records?</p>
      <div class="sheet-actions">
        <button class="btn" data-skip>Skip</button>
        <button class="btn btn-primary" data-exp>Export report</button>
      </div>`;
    const s = sheet({ title: 'Stocktake complete', content: wrap, onClose: () => nav.resetTo('home') });
    wrap.querySelector('[data-skip]').addEventListener('click', () => s.close());
    wrap.querySelector('[data-exp]').addEventListener('click', async () => {
      await exportVarianceXlsx(review);
      s.close();
    });
  });
}

/* ---------------- exported views ---------------- */

export const stocktakeView = {
  async show() {
    session = await getSession();
    if (!session) {
      session = await startSession();
      toast('Stocktake started — count items by scanning or typing');
    }
    query = '';
    return renderCount();
  },
};

export const reviewView = {
  async show() {
    session = session || await getSession();
    if (!session) { nav.resetTo('home'); return; }
    return renderReview();
  },
};
