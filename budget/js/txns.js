// Expense transactions. Amounts are integer cents, positive = money spent.
import { dbAllByIndex, dbGet, metaGet, uuid } from './db.js';
import { putRecord, softDelete, alive } from './store.js';
import { isoDate, monthKey } from './ui.js';

export async function saveTxn(t) {
  if (!t.id) t.id = uuid();
  t.amountCents = Math.round(Number(t.amountCents) || 0);
  t.date = t.date || isoDate();
  t.month = monthKey(t.date);
  t.categoryId = t.categoryId || null;
  t.merchant = String(t.merchant || '').trim().slice(0, 80);
  t.note = String(t.note || '').trim().slice(0, 300);
  t.source = t.source || 'manual';
  if (!t.enteredBy) t.enteredBy = (await metaGet('personName', '')) || 'someone';
  if (!t.createdAt) t.createdAt = Date.now();
  return putRecord('txns', t);
}

export function getTxn(id) {
  return dbGet('txns', id);
}

export function deleteTxn(id) {
  return softDelete('txns', id);
}

export async function txnsForMonth(ym) {
  const rows = alive(await dbAllByIndex('txns', 'month', ym));
  return rows.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
}

export async function monthTotals(ym) {
  const rows = await txnsForMonth(ym);
  return rows.reduce((s, t) => s + (t.amountCents || 0), 0);
}

/** All live txns in a split group (a receipt divided across categories). */
export async function splitSiblings(splitGroup) {
  if (!splitGroup) return [];
  const { dbAll } = await import('./db.js');
  return alive(await dbAll('txns')).filter(t => t.splitGroup === splitGroup);
}
