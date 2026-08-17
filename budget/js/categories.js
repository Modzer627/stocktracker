// Categories: CRUD + per-month spend aggregation.
import { dbAll, dbGet, uuid } from './db.js';
import { putRecord, softDelete, alive } from './store.js';

/** Display order of the groups; anything unknown sorts last alphabetically. */
export const GROUP_ORDER = [
  'Housing & Utilities', 'Horses', 'Food', 'Transportation & Phone',
  'Debt & Other', 'Savings',
];

export async function allCategories({ includeArchived = false } = {}) {
  const rows = alive(await dbAll('categories'));
  const cats = includeArchived ? rows : rows.filter(c => !c.archived);
  const gi = (g) => { const i = GROUP_ORDER.indexOf(g); return i === -1 ? 99 : i; };
  return cats.sort((a, b) =>
    gi(a.group) - gi(b.group) ||
    String(a.group).localeCompare(String(b.group)) ||
    (a.sortOrder || 0) - (b.sortOrder || 0) ||
    a.name.localeCompare(b.name));
}

export function getCategory(id) {
  return dbGet('categories', id);
}

export async function saveCategory(cat) {
  if (!cat.id) cat.id = 'cat-' + uuid().slice(0, 8);
  cat.name = String(cat.name || '').trim().slice(0, 60);
  cat.group = String(cat.group || 'Other').trim().slice(0, 60);
  cat.budgetCents = Math.max(0, Math.round(Number(cat.budgetCents) || 0));
  if (!cat.name) throw new Error('Category needs a name');
  return putRecord('categories', cat);
}

export function archiveCategory(id, archived = true) {
  return getCategory(id).then(c => c && putRecord('categories', { ...c, archived: archived ? 1 : 0 }));
}

export function deleteCategory(id) {
  return softDelete('categories', id);
}

/** Map of categoryId → spent cents for one 'YYYY-MM' month. */
export async function spentByCategory(ym) {
  const { dbAllByIndex } = await import('./db.js');
  const txns = alive(await dbAllByIndex('txns', 'month', ym));
  const map = new Map();
  for (const t of txns) {
    map.set(t.categoryId, (map.get(t.categoryId) || 0) + (t.amountCents || 0));
  }
  return map;
}

/** Grouped view-model for the dashboard: [{group, cats:[{cat, spent}]}] */
export async function groupedWithSpend(ym) {
  const [cats, spent] = await Promise.all([allCategories(), spentByCategory(ym)]);
  const groups = [];
  for (const cat of cats) {
    let g = groups[groups.length - 1];
    if (!g || g.group !== cat.group) {
      g = { group: cat.group, cats: [] };
      groups.push(g);
    }
    g.cats.push({ cat, spent: spent.get(cat.id) || 0 });
  }
  return groups;
}

/* ---------- shared household settings (single synced row) ---------- */

export async function getHousehold() {
  return (await dbGet('shared', 'household')) || { id: 'household', incomeCents: 0, updatedAt: 0, deleted: 0 };
}

export async function saveHousehold(patch) {
  const cur = await getHousehold();
  return putRecord('shared', { ...cur, ...patch, id: 'household', deleted: 0 });
}
