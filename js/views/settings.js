// Settings: preferences, backup/restore, storage status, install help.
import { metaGet, metaSet, dbClear, dbAll } from '../db.js';
import { exportBackup, readBackupFile, restoreBackup, daysSinceBackup } from '../backup.js';
import { exportInventoryXlsx } from '../export.js';
import { esc, toast, confirmDialog, setSoundEnabled } from '../ui.js';
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
