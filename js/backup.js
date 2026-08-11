// JSON backup/restore. With local-only storage this is both the safety net and
// the way to move the inventory between the two phones.
import { dbAll, dbPut, dbClear, metaGet, metaSet, newTx, txDone, notifyDataChanged } from './db.js';
import { deliverFile, confirmExport } from './export.js';
import { isoDate } from './ui.js';

const SCHEMA_VERSION = 1;
const BACKUP_NAG_DAYS = 30;

export async function buildBackupPayload() {
  const [items, txns, meta] = await Promise.all([dbAll('items'), dbAll('txns'), dbAll('meta')]);
  return {
    app: 'StockTracker',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    items,
    txns,
    meta: meta.filter(m => m.key === 'recentJobs'), // data only; device prefs stay per-device
  };
}

export async function exportBackup() {
  if (!(await confirmExport('a backup file (.json) of everything on this phone'))) return 'cancelled';
  const payload = await buildBackupPayload();
  const json = JSON.stringify(payload, null, 1);
  const result = await deliverFile(`stock-backup-${isoDate()}.json`, json, 'application/json');
  if (result === 'shared' || result === 'downloaded') {
    await metaSet('lastBackupAt', Date.now());
  }
  return result;
}

export async function readBackupFile(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Not a valid backup file'); }
  if (data.app !== 'StockTracker' || !Array.isArray(data.items) || !Array.isArray(data.txns)) {
    throw new Error('Not a StockTracker backup file');
  }
  if (data.schemaVersion > SCHEMA_VERSION) {
    throw new Error('Backup was made by a newer app version — update this app first');
  }
  return data;
}

/**
 * mode 'replace': wipe items+txns and load the backup as-is.
 * mode 'merge': newest-wins per item id, union of log entries — used to pull
 * the other phone's changes in. If two different items claim the same barcode,
 * the incoming one keeps its data but loses the barcode (counted as a warning).
 */
export async function restoreBackup(data, mode) {
  let itemCount = 0;
  let txnCount = 0;
  let warnings = 0;

  if (mode === 'replace') {
    await dbClear('items', 'txns');
    for (const item of data.items) { await putItemSafe(item, () => warnings++); itemCount++; }
    for (const txn of data.txns) { await dbPut('txns', txn); txnCount++; }
  } else {
    const t = newTx('items');
    const localItems = new Map();
    const req = t.objectStore('items').getAll();
    req.onsuccess = () => { for (const i of req.result) localItems.set(i.id, i); };
    await txDone(t);

    for (const incoming of data.items) {
      const local = localItems.get(incoming.id);
      if (!local || (incoming.updatedAt || 0) > (local.updatedAt || 0)) {
        await putItemSafe(incoming, () => warnings++);
        itemCount++;
      }
    }
    for (const txn of data.txns) { await dbPut('txns', txn); txnCount++; }
  }

  // Merge recent jobs from the backup under both modes.
  const incomingJobs = (data.meta || []).find(m => m.key === 'recentJobs')?.value || [];
  if (incomingJobs.length) {
    const localJobs = await metaGet('recentJobs', []);
    const seen = new Set(localJobs.map(j => j.toLowerCase()));
    const merged = [...localJobs, ...incomingJobs.filter(j => !seen.has(j.toLowerCase()))].slice(0, 10);
    await metaSet('recentJobs', merged);
  }
  if (mode === 'replace') await metaSet('stocktake', null); // a foreign count session makes no sense here

  notifyDataChanged();
  return { itemCount, txnCount, warnings };
}

async function putItemSafe(item, onWarn) {
  try {
    await dbPut('items', item);
  } catch (e) {
    if (e && e.name === 'ConstraintError') {
      const stripped = { ...item };
      delete stripped.barcode; // barcode already owned by a different local item
      await dbPut('items', stripped);
      onWarn();
    } else {
      throw e;
    }
  }
}

export async function backupBannerNeeded(itemCount) {
  if (!itemCount) return false;
  const last = await metaGet('lastBackupAt', null);
  if (!last) return true;
  return Date.now() - last > BACKUP_NAG_DAYS * 24 * 3600 * 1000;
}

export async function daysSinceBackup() {
  const last = await metaGet('lastBackupAt', null);
  if (!last) return null;
  return Math.floor((Date.now() - last) / (24 * 3600 * 1000));
}
