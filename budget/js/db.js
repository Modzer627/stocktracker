// IndexedDB layer for the budget app. Stores: txns, categories, recurring,
// shared (household-wide settings), photos (receipt cache), meta (device-local).
// Every synced record carries updatedAt (ms) + deleted (0/1 tombstone).
const DB_NAME = 'budgettracker'; // must differ from 'stocktracker' — same origin
const DB_VERSION = 1;

let _db = null;

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Fired after any budget mutation; the sync module listens for it. */
export function notifyDataChanged() {
  try { window.dispatchEvent(new CustomEvent('budget:changed')); } catch { /* non-browser context */ }
}

function openOnce() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('txns')) {
        const txns = db.createObjectStore('txns', { keyPath: 'id' });
        txns.createIndex('month', 'month');
        txns.createIndex('categoryId', 'categoryId');
        txns.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('categories')) {
        const cats = db.createObjectStore('categories', { keyPath: 'id' });
        cats.createIndex('group', 'group');
      }
      if (!db.objectStoreNames.contains('recurring')) {
        const rec = db.createObjectStore('recurring', { keyPath: 'id' });
        rec.createIndex('nextDue', 'nextDue');
      }
      if (!db.objectStoreNames.contains('shared')) {
        db.createObjectStore('shared', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('photos')) {
        db.createObjectStore('photos', { keyPath: 'key' }); // {key, blob, ts}
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database blocked by another tab'));
  });
}

export async function initDB() {
  if (_db) return _db;
  try {
    _db = await openOnce();
  } catch (e) {
    // iOS Safari occasionally flakes on first open — retry once.
    await new Promise(r => setTimeout(r, 300));
    _db = await openOnce();
  }
  _db.onversionchange = () => { _db.close(); _db = null; };
  return _db;
}

function db() {
  if (!_db) throw new Error('DB not initialised');
  return _db;
}

export function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = (e) => reject((e.target && e.target.error) || t.error || new Error('Transaction error'));
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

export function dbGet(store, key) {
  return reqP(db().transaction(store).objectStore(store).get(key));
}
export function dbAll(store) {
  return reqP(db().transaction(store).objectStore(store).getAll());
}
export function dbAllByIndex(store, index, query) {
  return reqP(db().transaction(store).objectStore(store).index(index).getAll(query));
}
export async function dbPut(store, val) {
  const t = db().transaction(store, 'readwrite');
  t.objectStore(store).put(val);
  await txDone(t);
  return val;
}
export async function dbDel(store, key) {
  const t = db().transaction(store, 'readwrite');
  t.objectStore(store).delete(key);
  await txDone(t);
}
export async function dbClear(...stores) {
  const t = db().transaction(stores, 'readwrite');
  for (const s of stores) t.objectStore(s).clear();
  await txDone(t);
}

export async function metaGet(key, def = null) {
  const row = await dbGet('meta', key);
  return row === undefined || row === null ? def : row.value;
}
export async function metaSet(key, value) {
  await dbPut('meta', { key, value });
}

export function newTx(stores, mode = 'readonly') {
  return db().transaction(stores, mode);
}
