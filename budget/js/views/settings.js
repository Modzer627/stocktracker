// Settings: identity, household sync, income, categories, notifications,
// bank import, exports, data tools.
import { $, esc, toast, sheet, confirmDialog, fmtMoney, parseMoney, monthKey } from '../ui.js';
import * as nav from '../nav.js';
import { metaGet, metaSet } from '../db.js';
import { allCategories, getHousehold, saveHousehold } from '../categories.js';
import { syncStatus, syncNow, joinHousehold, leaveHousehold, workerUrl, DEFAULT_WORKER_URL } from '../sync.js';
import { openCategorySheet } from './sheets.js';

const view = {
  async show() { await render(); },
  async refresh() { if (nav.currentScreen() === 'settings') await render(); },
  hide() { window.removeEventListener('sync:status', onStatus); },
};
export default view;

function onStatus() { view.refresh(); }

async function render() {
  const root = $('#screen-settings');
  const [personName, household, status, cats, code, wurl] = await Promise.all([
    metaGet('personName', ''), getHousehold(), syncStatus(),
    allCategories({ includeArchived: true }), metaGet('householdCode', ''), workerUrl(),
  ]);

  const syncLine = !status.configured
    ? 'Not connected — local only'
    : status.lastSyncError
      ? `⚠️ ${status.lastSyncError}`
      : status.lastSyncAt
        ? `Synced ${new Date(status.lastSyncAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
        : 'Connected — first sync pending';

  root.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-role="back" aria-label="Back">←</button>
      <h1>Settings</h1>
    </header>
    <div class="content">
      <div class="section-title">You</div>
      <div class="set-group" style="padding:13px 15px">
        <div class="field" style="margin-bottom:0"><label>Your name (shows on expenses you add)</label>
          <input data-role="name" type="text" placeholder="e.g. Alex" value="${esc(personName)}"></div>
      </div>

      <div class="section-title">Household</div>
      <div class="set-group" style="padding:13px 15px">
        <div class="field"><label>Household code</label>
          <input data-role="code" type="text" autocapitalize="off" autocorrect="off" placeholder="shared secret you both enter" value="${esc(code)}"></div>
        <div class="set-row" style="padding:8px 0;border:none">
          <div class="grow">${esc(syncLine)}</div>
          ${status.configured ? '<button class="btn btn-sm" data-role="sync-now">Sync now</button>' : ''}
        </div>
        <button class="btn btn-primary btn-block" data-role="save-household">${code ? 'Update & sync' : 'Connect household'}</button>
        ${code ? '<button class="btn btn-ghost btn-block" data-role="leave" style="margin-top:8px">Disconnect this device</button>' : ''}
        <p style="font-size:12.5px;color:var(--text-dim);margin-top:10px;line-height:1.5">
          <b>Inviting your partner:</b> send them this app's link and the household code.
          They install it, enter their name and the same code — everything you both
          add syncs automatically, including receipt photos.</p>
      </div>

      <div class="section-title">Income</div>
      <div class="set-group" style="padding:13px 15px">
        <div class="field"><label>Combined monthly income</label>
          <input data-role="income" type="text" inputmode="decimal" value="${((household.incomeCents || 0) / 100).toFixed(2)}"></div>
        <button class="btn btn-block" data-role="save-income">Save income</button>
      </div>

      <div class="section-title">Notifications</div>
      <div class="set-group" style="padding:13px 15px">
        <p style="font-size:12.5px;color:var(--text-dim);margin-bottom:10px;line-height:1.5">
          Bill-due reminders and a ping when your partner adds spending. Needs the
          household connected${/iP(hone|ad)/.test(navigator.userAgent) ? ' and the app installed to your home screen' : ''}.</p>
        <button class="btn btn-block" data-role="push-on">Enable notifications</button>
        <button class="btn btn-ghost btn-block" data-role="push-test" style="margin-top:8px">Send a test</button>
      </div>

      <div class="section-title">Categories</div>
      <div class="set-group">
        ${cats.map(c => `
        <div class="set-row" data-cat="${esc(c.id)}" style="cursor:pointer;${c.archived ? 'opacity:.5' : ''}">
          <span>${esc(c.icon || '🧾')}</span>
          <div class="grow">${esc(c.name)}<span class="hint">${esc(c.group)}${c.archived ? ' · archived' : ''}</span></div>
          <span style="font-variant-numeric:tabular-nums">${fmtMoney(c.budgetCents)}/mo</span>
        </div>`).join('')}
        <div class="set-row"><button class="btn btn-sm btn-block" data-role="add-cat">＋ Add category</button></div>
      </div>

      <div class="section-title">Data</div>
      <div class="set-group">
        <div class="set-row"><div class="grow">Import bank statement<span class="hint">CSV or Excel from your bank</span></div>
          <button class="btn btn-sm" data-role="import">Import…</button></div>
        <div class="set-row"><div class="grow">Monthly report<span class="hint">Excel workbook like your original budget sheet</span></div>
          <button class="btn btn-sm" data-role="export-xlsx">Export</button></div>
        <div class="set-row"><div class="grow">Backup<span class="hint">All data as JSON</span></div>
          <button class="btn btn-sm" data-role="export-json">Export</button></div>
        <div class="set-row"><div class="grow">Receipt reading (OCR)<span class="hint">Download the ~7 MB reader for offline use</span></div>
          <button class="btn btn-sm" data-role="ocr-warm">Download</button></div>
        <div class="set-row"><div class="grow">Reset this device<span class="hint">Wipes local data, restores the starter budget</span></div>
          <button class="btn btn-sm btn-danger" data-role="reset">Reset</button></div>
      </div>

      <details style="margin:14px 2px">
        <summary style="font-size:12.5px;color:var(--text-dim);cursor:pointer">Advanced</summary>
        <div class="field" style="margin-top:10px"><label>Sync server URL</label>
          <input data-role="wurl" type="url" value="${esc(wurl)}" placeholder="${esc(DEFAULT_WORKER_URL)}">
          <button class="btn btn-sm" data-role="save-wurl" style="margin-top:8px">Save URL</button></div>
      </details>
    </div>`;

  window.addEventListener('sync:status', onStatus);
  const el = (r) => $(`[data-role="${r}"]`, root);
  el('back').addEventListener('click', () => nav.back());

  el('name').addEventListener('change', async () => {
    await metaSet('personName', el('name').value.trim().slice(0, 40));
    toast('Name saved');
  });

  el('save-household').addEventListener('click', async () => {
    const newCode = el('code').value.trim();
    await metaSet('personName', el('name').value.trim().slice(0, 40));
    if (!newCode) { toast('Enter the household code', { error: true }); return; }
    toast('Connecting…');
    const res = await joinHousehold(newCode);
    if (res.ok) toast('Connected — synced ✓');
    else toast(res.reason || 'Could not sync', { error: true });
    render();
  });
  const leave = el('leave');
  if (leave) leave.addEventListener('click', async () => {
    if (!(await confirmDialog('Disconnect from the household? Data stays on this device and on your partner\'s.', { okLabel: 'Disconnect' }))) return;
    await leaveHousehold();
    render();
  });
  const syncBtn = el('sync-now');
  if (syncBtn) syncBtn.addEventListener('click', async () => {
    toast('Syncing…');
    const res = await syncNow();
    if (res.ok) toast('Synced ✓');
    else toast(res.reason || 'Sync failed', { error: true });
    render();
  });

  el('save-income').addEventListener('click', async () => {
    const cents = parseMoney(el('income').value);
    if (cents == null || cents < 0) { toast('Enter a valid amount', { error: true }); return; }
    await saveHousehold({ incomeCents: cents });
    toast('Income saved');
  });

  el('push-on').addEventListener('click', async () => {
    try {
      const { enableNotifications } = await import('../push.js');
      await enableNotifications();
      toast('Notifications on ✓');
    } catch (e) {
      toast(e.message || 'Could not enable notifications', { error: true, duration: 6000 });
    }
  });
  el('push-test').addEventListener('click', async () => {
    try {
      const { sendTestNotification } = await import('../push.js');
      await sendTestNotification();
      toast('Test sent — check your notifications');
    } catch (e) {
      toast(e.message || 'Test failed', { error: true });
    }
  });

  el('add-cat').addEventListener('click', () => openCategorySheet({ onDone: render }));
  root.querySelectorAll('[data-cat]').forEach(r => r.addEventListener('click', () => {
    const c = cats.find(x => x.id === r.dataset.cat);
    if (c) openCategorySheet({ cat: c, onDone: render });
  }));

  el('import').addEventListener('click', () => openBankImport());
  el('export-xlsx').addEventListener('click', async () => {
    const { exportMonthlyXlsx } = await import('../export.js');
    exportMonthlyXlsx(monthKey());
  });
  el('export-json').addEventListener('click', async () => {
    const { exportBackup } = await import('../export.js');
    exportBackup();
  });
  el('ocr-warm').addEventListener('click', async () => {
    toast('Downloading OCR files…');
    try {
      const { warmUp } = await import('../ocr.js');
      await warmUp();
      toast('Receipt reading is ready — works offline now ✓');
    } catch {
      toast('Could not download the OCR files', { error: true });
    }
  });
  el('reset').addEventListener('click', async () => {
    if (!(await confirmDialog('Wipe ALL data on this device and restore the starter budget? Synced data on the server is untouched.', { danger: true, okLabel: 'Wipe & reseed' }))) return;
    const { resetAll } = await import('../seed.js');
    await resetAll();
    toast('Reset done');
    nav.resetTo('home');
  });

  el('save-wurl').addEventListener('click', async () => {
    await metaSet('workerUrl', el('wurl').value.trim() || DEFAULT_WORKER_URL);
    toast('Server URL saved');
  });
}

/* ---------- bank import flow ---------- */

async function openBankImport() {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  picker.addEventListener('change', async () => {
    const file = picker.files && picker.files[0];
    if (!file) return;
    let rows;
    try {
      const { parseBankFile, annotateRows } = await import('../importer.js');
      const parsed = await parseBankFile(file);
      rows = await annotateRows(parsed.rows);
      if (!rows.length) { toast('No expenses found in that file', { error: true }); return; }
    } catch (e) {
      toast(e.message || 'Could not read that file', { error: true, duration: 6000 });
      return;
    }
    showImportPreview(rows);
  });
  picker.click();
}

async function showImportPreview(rows) {
  const cats = await allCategories();
  const options = (sel) => cats.map(c =>
    `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${esc(c.icon || '')} ${esc(c.name)}</option>`).join('');
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <p style="font-size:12.5px;color:var(--text-dim);margin:-6px 0 10px">
      ${rows.length} expense${rows.length === 1 ? '' : 's'} found. Pick categories, untick
      anything you don't want. Rows matching an existing expense are unticked already.</p>
    <div style="max-height:46vh;overflow-y:auto">
      ${rows.map((r, i) => `
      <div class="imp-row ${r.duplicate ? 'skip' : ''}" data-i="${i}">
        <input type="checkbox" ${r.duplicate ? '' : 'checked'}>
        <div class="imp-main">${esc(r.merchant)}<div class="imp-date">${esc(r.date)}${r.duplicate ? ' · looks already imported' : ''}</div></div>
        <span class="imp-amt">${fmtMoney(r.amountCents)}</span>
        <select>${options(r.categoryId || cats[0].id)}</select>
      </div>`).join('')}
    </div>
    <div class="sheet-actions">
      <button class="btn" data-role="cancel">Cancel</button>
      <button class="btn btn-primary" data-role="go">Import checked</button>
    </div>`;
  const s = sheet({ title: 'Bank import', content: wrap });
  $('[data-role="cancel"]', wrap).addEventListener('click', () => s.close());
  wrap.querySelectorAll('.imp-row input[type="checkbox"]').forEach(cb =>
    cb.addEventListener('change', () => cb.closest('.imp-row').classList.toggle('skip', !cb.checked)));
  $('[data-role="go"]', wrap).addEventListener('click', async () => {
    const chosen = [];
    wrap.querySelectorAll('.imp-row').forEach(rowEl => {
      if (!rowEl.querySelector('input[type="checkbox"]').checked) return;
      const r = rows[Number(rowEl.dataset.i)];
      chosen.push({ ...r, categoryId: rowEl.querySelector('select').value });
    });
    if (!chosen.length) { toast('Nothing checked', { error: true }); return; }
    const { runImport } = await import('../importer.js');
    const { added } = await runImport(chosen);
    s.close();
    toast(`Imported ${added} expense${added === 1 ? '' : 's'}`);
  });
}
