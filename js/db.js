// IndexedDB layer: stores `items`, `txns` (movement log), `meta` (key/value).
const DB_NAME = 'stocktracker';
const DB_VERSION = 1;

let _db = null;

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/** Fired after any inventory mutation; the team-sync module listens for it. */
export function notifyDataChanged() {
  try { window.dispatchEvent(new CustomEvent('stock:changed')); } catch { /* non-browser context */ }
}

function openOnce() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) {
        const items = db.createObjectStore('items', { keyPath: 'id' });
        // Sparse unique index: items without a barcode simply omit the property.
        items.createIndex('barcode', 'barcode', { unique: true });
        items.createIndex('name', 'name');
      }
      if (!db.objectStoreNames.contains('txns')) {
        const txns = db.createObjectStore('txns', { keyPath: 'id' });
        txns.createIndex('itemId', 'itemId');
        txns.createIndex('ts', 'ts');
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
    // On a failed request the bubbled event carries the real error (e.g.
    // ConstraintError) on the request; transaction.error may still be null here.
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
export function dbGetByIndex(store, index, query) {
  return reqP(db().transaction(store).objectStore(store).index(index).get(query));
}
export async function dbPut(store, val) {
  const t = db().transaction(store, 'readwrite');
  t.objectStore(store).put(val);
  await txDone(t);
  return val;
}
export async function dbAdd(store, val) {
  const t = db().transaction(store, 'readwrite');
  t.objectStore(store).add(val);
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

/**
 * Apply a stock movement: updates the item count and writes the log entry
 * in ONE transaction so the two can never drift apart.
 * delta is signed. type: 'in' | 'out' | 'adjust'.
 */
export function applyStockChange({ itemId, delta, type, job = null, note = null }) {
  return new Promise((resolve, reject) => {
    const t = db().transaction(['items', 'txns'], 'readwrite');
    const items = t.objectStore('items');
    let updated = null;
    const getReq = items.get(itemId);
    getReq.onsuccess = () => {
      const item = getReq.result;
      if (!item) { t.abort(); reject(new Error('Item not found')); return; }
      item.qty = round3((item.qty || 0) + delta);
      item.updatedAt = Date.now();
      updated = item;
      items.put(item);
      t.objectStore('txns').add({
        id: uuid(),
        itemId,
        itemName: item.name,
        unit: item.unit || '',
        delta: round3(delta),
        type,
        job: job || null,
        note: note || null,
        ts: Date.now(),
      });
    };
    t.oncomplete = () => { notifyDataChanged(); resolve(updated); };
    t.onerror = (e) => reject((e.target && e.target.error) || t.error || new Error('Transaction error'));
    t.onabort = () => reject(t.error || new Error('Item not found'));
  });
}
