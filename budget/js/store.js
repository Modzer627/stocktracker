// Domain write layer for synced stores. All view writes go through here so
// every record gets an updatedAt stamp and the sync module hears about it.
// Deletes are tombstones (deleted = 1) — never hard deletes — so a removal on
// one phone propagates to the other instead of resurrecting on next pull.
import { dbGet, dbPut, notifyDataChanged } from './db.js';

export const SYNCED_STORES = ['txns', 'categories', 'recurring', 'shared'];

export async function putRecord(store, rec, { silent = false } = {}) {
  rec.updatedAt = Date.now();
  if (rec.deleted === undefined) rec.deleted = 0;
  await dbPut(store, rec);
  if (!silent) notifyDataChanged();
  return rec;
}

export async function softDelete(store, id) {
  const rec = await dbGet(store, id);
  if (!rec) return null;
  rec.deleted = 1;
  rec.updatedAt = Date.now();
  await dbPut(store, rec);
  notifyDataChanged();
  return rec;
}

export const alive = (rows) => rows.filter(r => !r.deleted);
