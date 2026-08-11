import { uuid, round3, newTx, txDone, dbGet, dbAll, dbGetByIndex, dbPut, dbDel } from './db.js';

const now = () => Date.now();

function normalize(data) {
  const item = {
    name: (data.name || '').trim(),
    category: (data.category || '').trim(),
    unit: (data.unit || '').trim() || 'pcs',
    location: (data.location || '').trim(),
    qty: round3(Number(data.qty) || 0),
    minQty: round3(Number(data.minQty) || 0),
    notes: (data.notes || '').trim(),
  };
  const barcode = (data.barcode || '').trim();
  if (barcode) item.barcode = barcode; // omitted entirely when absent → stays out of the unique index
  return item;
}

/** Create item + optional initial stock log entry atomically. */
export function createItem(data) {
  const item = { id: uuid(), ...normalize(data), createdAt: now(), updatedAt: now() };
  if (!item.name) return Promise.reject(new Error('Name is required'));
  return new Promise((resolve, reject) => {
    const t = newTx(['items', 'txns'], 'readwrite');
    t.objectStore('items').add(item);
    if (item.qty !== 0) {
      t.objectStore('txns').add({
        id: uuid(), itemId: item.id, itemName: item.name, unit: item.unit,
        delta: item.qty, type: 'in', job: null, note: 'Initial stock', ts: now(),
      });
    }
    t.oncomplete = () => resolve(item);
    t.onerror = (e) => reject(friendly((e.target && e.target.error) || t.error));
    t.onabort = () => reject(friendly(t.error));
  });
}

export async function updateItem(id, patch) {
  const existing = await dbGet('items', id);
  if (!existing) throw new Error('Item not found');
  const clean = normalize({ ...existing, ...patch });
  const item = { ...existing, ...clean, id, updatedAt: now() };
  if (!('barcode' in clean)) delete item.barcode;
  try {
    await dbPut('items', item);
  } catch (e) {
    throw friendly(e);
  }
  return item;
}

function friendly(e) {
  if (e && (e.name === 'ConstraintError' || String(e).includes('Constraint'))) {
    return new Error('That barcode is already assigned to another item');
  }
  return e || new Error('Database error');
}

export const getItem = (id) => dbGet('items', id);

export async function getByBarcode(code) {
  if (!code) return undefined;
  return dbGetByIndex('items', 'barcode', String(code).trim());
}

export async function allItems() {
  const items = await dbAll('items');
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return items;
}

export const deleteItem = (id) => dbDel('items', id);

export const isLow = (item) => item.qty <= item.minQty;

export function searchFilter(items, q) {
  const s = (q || '').trim().toLowerCase();
  if (!s) return items;
  return items.filter(it =>
    it.name.toLowerCase().includes(s) ||
    (it.barcode || '').toLowerCase().includes(s) ||
    (it.category || '').toLowerCase().includes(s) ||
    (it.location || '').toLowerCase().includes(s)
  );
}

export function distinct(items, field) {
  return [...new Set(items.map(i => i[field]).filter(Boolean))].sort();
}
