// Settings: preferences, backup/restore, storage status, install help.
import { metaGet, metaSet, dbClear, dbAll } from '../db.js';
import { exportBackup, readBackupFile, restoreBackup, daysSinceBackup } from '../backup.js';
import { exportInventoryXlsx } from '../export.js';
import { syncStatus, pushNow, markDirty, managerConfigured, fetchTeam } from '../sync.js';
import { esc, toast, confirmDialog, setSoundEnabled, fmtDateTime } from '../ui.js';
import * as nav from '../nav.js';

const section = () => document.getElementById('screen-settings');

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

async function render() {
  const sec = section();
  const facing = await metaGet('cameraFacing', 'environment');
  const sound = await metaGet('soundOn', true);
  const backupDays = await daysSinceBackup();
  const counts = { items: (await dbAll('items')).length, txns: (await dbAll('txns')).length };

  let storageLine = 'Storage: unknown';
  try {
    const est = await navigator.storage.estimate();
    const mb = (n) => (n / 1048576).toFixed(1);
    const persisted = await navigator.storage.persisted?.();
    storageLine = `Using ${mb(est.usage || 0)} MB · ${persisted ? 'protected from cleanup' : 'not yet marked persistent'}`;
  } catch { /* older browsers */ }

  sec.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-back aria-label="Back">←</button>
      <h1>Settings</h1>
    </header>
    <div class="content">
      <div class="section-title">Scanning</div>
      <div class="set-group">
        <div class="set-row">
          <div class="grow">Default camera<span class="hint">You can always flip while scanning</span></div>
          <select data-camera>
            <option value="environment" ${facing === 'environment' ? 'selected' : ''}>Rear</option>
            <option value="user" ${facing === 'user' ? 'selected' : ''}>Front</option>
          </select>
        </div>
        <div class="set-row">
          <div class="grow">Beep on scan</div>
          <label class="switch"><input type="checkbox" data-sound ${sound ? 'checked' : ''}><span></span></label>
        </div>
      </div>

      <div class="section-title">Team sync</div>
      <div class="set-group">
        <div class="set-row">
          <div class="grow">Your name<span class="hint">How managers see this van</span></div>
          <input type="text" data-techname value="${esc(await metaGet('techName', ''))}" placeholder="e.g. Mike" style="width:130px;min-height:40px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font-size:15px;padding:6px 10px">
        </div>
        <div class="set-row">
          <div class="grow">Team code<span class="hint">From your manager — turns on syncing</span></div>
          <input type="password" data-teamcode value="${esc(await metaGet('teamCode', ''))}" placeholder="not set" autocomplete="off" style="width:130px;min-height:40px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font-size:15px;padding:6px 10px">
        </div>
        <div class="set-row">
          <div class="grow"><span data-syncline>…</span><span class="hint">Pushes automatically after changes</span></div>
          <button class="btn btn-sm" data-syncnow>Sync now</button>
        </div>
      </div>

      <div class="section-title">Manager</div>
      <div class="set-group">
        <div class="set-row">
          <div class="grow">Manager code<span class="hint">Unlocks the Team view of all vans</span></div>
          <input type="password" data-managercode value="${esc(await metaGet('managerCode', ''))}" placeholder="not set" autocomplete="off" style="width:130px;min-height:40px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font-size:15px;padding:6px 10px">
        </div>
      </div>

      <div class="section-title">Notifications</div>
      <div class="set-group">
        <div class="set-row">
          <div class="grow"><span data-pushline>Checking…</span><span class="hint">Managers: new requests · Techs: request decisions</span></div>
          <button class="btn btn-sm btn-primary" data-pushenable hidden>Turn on</button>
          <button class="btn btn-sm" data-pushtest hidden>Test</button>
        </div>
      </div>

      <div class="section-title">Your data</div>
      <div class="set-group">
        <div class="set-row">
          <div class="grow">Excel export<span class="hint">Inventory + usage log (.xlsx)</span></div>
          <button class="btn btn-sm" data-xlsx>Export</button>
        </div>
        <div class="set-row">
          <div class="grow">Backup<span class="hint">${backupDays === null ? 'Never backed up' : backupDays === 0 ? 'Backed up today' : `Last backup ${backupDays} day${backupDays === 1 ? '' : 's'} ago`} · ${counts.items} items, ${counts.txns} log entries</span></div>
          <button class="btn btn-sm" data-backup>Back up</button>
        </div>
        <div class="set-row">
          <div class="grow">Restore / import<span class="hint">Load a backup file — from this phone or your other one</span></div>
          <button class="btn btn-sm" data-restore>Choose file</button>
          <input type="file" accept=".json,application/json" data-restore-file hidden>
        </div>
        <div class="set-row" data-import-row hidden>
          <div class="grow">Bulk import items<span class="hint">Seed from a CSV or Excel list · <button class="btn-ghost" data-template style="padding:0;min-height:0;font-size:12.5px">download template</button></span></div>
          <button class="btn btn-sm" data-import>Choose file</button>
          <input type="file" accept=".csv,.xlsx,.xls,text/csv" data-import-file hidden>
        </div>
        <div class="set-row">
          <div class="grow" style="color:var(--danger)">Erase everything<span class="hint">Deletes all items and history from this phone</span></div>
          <button class="btn btn-sm" data-wipe style="color:var(--danger)">Erase</button>
        </div>
      </div>

      <div class="section-title">App</div>
      <div class="set-group">
        <div class="set-row"><div class="grow">${storageLine}<span class="hint">All data stays on this device</span></div></div>
        <div class="set-row" data-install-row hidden>
          <div class="grow">Install on this phone<span class="hint">Home-screen app with offline access</span></div>
          <button class="btn btn-sm btn-primary" data-install>Install</button>
        </div>
        <div class="set-row">
          <div class="grow">Version ${window.__appVersion || 'dev'}<span class="hint" data-upd-hint>${window.__updateReady ? 'Update ready' : 'Up to date'}</span></div>
          ${window.__updateReady ? '<button class="btn btn-sm btn-primary" data-apply-update>Update</button>' : ''}
        </div>
      </div>

      ${!isStandalone() && isIOS() ? `
        <div class="banner info" style="align-items:flex-start;line-height:1.6">
          <span>📲 To install on this iPhone: tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>. The app then works full-screen and offline.</span>
        </div>` : ''}
    </div>`;

  sec.querySelector('[data-back]').addEventListener('click', () => nav.back());

  // --- team sync wiring ---
  const refreshSyncLine = async () => {
    const line = sec.querySelector('[data-syncline]');
    if (!line) return;
    const s = await syncStatus();
    line.textContent = !s.configured ? 'Sync off — set name + team code'
      : s.lastSyncError ? `⚠ ${s.lastSyncError}`
      : s.pending ? 'Changes waiting to sync…'
      : s.lastSyncAt ? `Synced ${fmtDateTime(s.lastSyncAt)}`
      : 'Ready — will sync on next change';
  };
  refreshSyncLine();
  window.removeEventListener('sync:status', window.__syncLineHandler || (() => {}));
  window.__syncLineHandler = refreshSyncLine;
  window.addEventListener('sync:status', window.__syncLineHandler);

  sec.querySelector('[data-techname]').addEventListener('change', async (e) => {
    await metaSet('techName', e.target.value.trim());
    markDirty();
    refreshSyncLine();
  });
  sec.querySelector('[data-teamcode]').addEventListener('change', async (e) => {
    await metaSet('teamCode', e.target.value.trim());
    if (e.target.value.trim()) { toast('Team sync on'); markDirty(); } else toast('Team sync off');
    refreshSyncLine();
  });
  sec.querySelector('[data-syncnow]').addEventListener('click', async () => {
    const r = await pushNow();
    toast(r.ok ? 'Synced' : (r.reason === 'not configured' ? 'Enter your name and team code first' : r.reason), { error: !r.ok });
    refreshSyncLine();
  });
  sec.querySelector('[data-managercode]').addEventListener('change', async (e) => {
    await metaSet('managerCode', e.target.value.trim());
    if (!e.target.value.trim()) { toast('Manager view off'); return; }
    try {
      await fetchTeam();
      toast('Manager code accepted — Team view unlocked');
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  // --- notifications wiring ---
  const pushLine = sec.querySelector('[data-pushline]');
  const pushEnableBtn = sec.querySelector('[data-pushenable]');
  const pushTestBtn = sec.querySelector('[data-pushtest]');
  const refreshPushRow = async () => {
    const { pushState } = await import('../push.js');
    const state = await pushState();
    pushLine.textContent = {
      unsupported: /iPhone|iPad/.test(navigator.userAgent) && !window.navigator.standalone
        ? 'Install to the home screen first, then notifications work'
        : 'Notifications not supported in this browser',
      denied: 'Blocked — allow notifications for this app in phone settings',
      off: 'Notifications off',
      on: 'Notifications on ✓',
    }[state];
    pushEnableBtn.hidden = state !== 'off';
    pushTestBtn.hidden = state !== 'on';
  };
  refreshPushRow();
  pushEnableBtn.addEventListener('click', async () => {
    try {
      const { enableNotifications } = await import('../push.js');
      await enableNotifications();
      toast('Notifications on');
    } catch (e) {
      toast(e.message, { error: true, duration: 5000 });
    }
    refreshPushRow();
  });
  pushTestBtn.addEventListener('click', async () => {
    try {
      const { sendTestNotification } = await import('../push.js');
      await sendTestNotification();
      toast('Test sent — it should pop up in a few seconds');
    } catch (e) {
      toast(e.message, { error: true });
    }
  });

  sec.querySelector('[data-camera]').addEventListener('change', async (e) => {
    await metaSet('cameraFacing', e.target.value);
    toast('Default camera saved');
  });
  sec.querySelector('[data-sound]').addEventListener('change', async (e) => {
    await metaSet('soundOn', e.target.checked);
    setSoundEnabled(e.target.checked);
  });
  sec.querySelector('[data-xlsx]').addEventListener('click', async () => {
    const r = await exportInventoryXlsx();
    if (r === 'shared' || r === 'downloaded') toast('Excel file exported');
  });
  sec.querySelector('[data-backup]').addEventListener('click', async () => {
    const r = await exportBackup();
    if (r === 'shared' || r === 'downloaded') { toast('Backup saved'); render(); }
  });

  const fileInput = sec.querySelector('[data-restore-file]');
  sec.querySelector('[data-restore]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const data = await readBackupFile(file);
      openRestoreChoice(data);
    } catch (e) {
      toast(e.message, { error: true });
    }
  });

  // --- bulk import (managers and solo phones only — techs go through requests) ---
  import('../requests.js').then(async ({ appRole }) => {
    if ((await appRole()) !== 'tech') sec.querySelector('[data-import-row]').hidden = false;
  });
  const importInput = sec.querySelector('[data-import-file]');
  sec.querySelector('[data-import]').addEventListener('click', () => importInput.click());
  sec.querySelector('[data-template]').addEventListener('click', async () => {
    const { downloadTemplate } = await import('../importer.js');
    await downloadTemplate();
  });
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (!file) return;
    try {
      const { parseImportFile, runImport } = await import('../importer.js');
      const { rows, report } = await parseImportFile(file);
      if (!rows.length) { toast('No item rows found in that file', { error: true }); return; }
      const { sheet } = await import('../ui.js');
      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <p style="font-size:14.5px;line-height:1.7;margin-bottom:12px">
          Found <b>${rows.length}</b> item${rows.length === 1 ? '' : 's'} in <b>${esc(file.name)}</b>.<br>
          Columns matched: ${report.mapped.join(', ')}${report.unmappedHeaders.length ? `<br><span style="color:var(--text-dim)">Ignored: ${esc(report.unmappedHeaders.join(', '))}</span>` : ''}
          ${report.skippedNoName ? `<br><span style="color:var(--warn-text)">${report.skippedNoName} row(s) skipped — no name</span>` : ''}
        </p>
        ${rows.slice(0, 3).map(r => `<div class="rev-row"><div class="rev-main"><div>${esc(r.name)}</div><div class="txn-sub">${r.qty} ${esc(r.unit)} · min ${r.minQty}${r.barcode ? ' · ' + esc(r.barcode) : ''}</div></div></div>`).join('')}
        ${rows.length > 3 ? `<p class="txn-sub" style="margin-top:6px">…and ${rows.length - 3} more</p>` : ''}
        <div class="sheet-actions">
          <button class="btn" data-cancel>Cancel</button>
          <button class="btn btn-primary" data-go>Import ${rows.length}</button>
        </div>`;
      const s = sheet({ title: 'Import items', content: wrap });
      wrap.querySelector('[data-cancel]').addEventListener('click', () => s.close());
      wrap.querySelector('[data-go]').addEventListener('click', async () => {
        wrap.querySelector('[data-go]').disabled = true;
        const result = await runImport(rows);
        s.close();
        const bits = [`${result.added} added`];
        if (result.dupBarcode) bits.push(`${result.dupBarcode} skipped (barcode exists)`);
        if (result.dupName) bits.push(`${result.dupName} skipped (already have it)`);
        if (result.failed) bits.push(`${result.failed} failed`);
        toast(`Import done — ${bits.join(', ')}`, { duration: 6000 });
        render();
      });
    } catch (e) {
      toast(e.message || 'Could not read that file', { error: true, duration: 6000 });
    }
  });

  sec.querySelector('[data-wipe]').addEventListener('click', async () => {
    const one = await confirmDialog('Erase ALL items, history and settings from this phone?', { danger: true, okLabel: 'Erase' });
    if (!one) return;
    const two = await confirmDialog('Really erase everything? There is no undo unless you have a backup file.', { danger: true, okLabel: 'Erase everything' });
    if (!two) return;
    await dbClear('items', 'txns', 'meta');
    toast('All data erased');
    nav.resetTo('home');
  });

  const installRow = sec.querySelector('[data-install-row]');
  if (window.__installPrompt && !isStandalone()) {
    installRow.hidden = false;
    sec.querySelector('[data-install]').addEventListener('click', async () => {
      const p = window.__installPrompt;
      window.__installPrompt = null;
      installRow.hidden = true;
      if (p) { p.prompt(); await p.userChoice.catch(() => null); }
    });
  }
  sec.querySelector('[data-apply-update]')?.addEventListener('click', () => window.__applyUpdate && window.__applyUpdate());
}

function openRestoreChoice(data) {
  import('../ui.js').then(({ sheet }) => {
    const wrap = document.createElement('div');
    const when = data.exportedAt ? new Date(data.exportedAt).toLocaleString() : 'unknown date';
    wrap.innerHTML = `
      <p style="font-size:14.5px;line-height:1.6;margin-bottom:14px">
        Backup from <b>${esc(when)}</b> — ${data.items.length} items, ${data.txns.length} log entries.
      </p>
      <button class="btn btn-block btn-primary" data-mode="replace" style="margin-bottom:10px">Replace everything on this phone</button>
      <button class="btn btn-block" data-mode="merge">Merge into this phone</button>
      <p style="color:var(--text-dim);font-size:13px;margin-top:12px;line-height:1.5">
        Replace: this phone becomes an exact copy of the backup (recommended).<br>
        Merge: combines both — for each item the newest version wins, and all history is kept.
      </p>`;
    const s = sheet({ title: 'Restore backup', content: wrap });
    wrap.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', async () => {
      const mode = b.dataset.mode;
      s.close();
      const yes = mode === 'replace'
        ? await confirmDialog('Replace everything on this phone with the backup?', { danger: true, okLabel: 'Replace' })
        : true;
      if (!yes) return;
      try {
        const res = await restoreBackup(data, mode);
        toast(`Restored ${res.itemCount} items, ${res.txnCount} log entries${res.warnings ? ` · ${res.warnings} barcode clash${res.warnings === 1 ? '' : 'es'} (barcode dropped)` : ''}`, { duration: 4500 });
        nav.resetTo('home');
      } catch (e) {
        toast(e.message || 'Restore failed', { error: true });
      }
    }));
  });
}

export default { show: () => render() };
