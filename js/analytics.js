// Pure analytics computations over items + movement logs. Team variants take
// the array of tech snapshots the sync server returns.
import { round3 } from './db.js';

const DAY = 24 * 3600 * 1000;
const NO_JOB = '(no job recorded)';

const outs = (txns) => txns.filter(t => t.type === 'out' && t.delta < 0);

/** Usage grouped by job. Returns jobs sorted by most recent use. */
export function usageByJob(txns, { sinceTs = 0 } = {}) {
  const jobs = new Map();
  for (const t of outs(txns).filter(t => t.ts >= sinceTs)) {
    const key = (t.job || '').trim() || NO_JOB;
    let j = jobs.get(key);
    if (!j) { j = { job: key, total: 0, lastTs: 0, lines: new Map() }; jobs.set(key, j); }
    const qty = -t.delta;
    j.total = round3(j.total + qty);
    j.lastTs = Math.max(j.lastTs, t.ts);
    const lk = `${t.itemName}|${t.unit}` + (t.tech ? `|${t.tech}` : '');
    const line = j.lines.get(lk) || { itemName: t.itemName, unit: t.unit, qty: 0, tech: t.tech || null };
    line.qty = round3(line.qty + qty);
    j.lines.set(lk, line);
  }
  return [...jobs.values()]
    .map(j => ({ ...j, lines: [...j.lines.values()].sort((a, b) => b.qty - a.qty) }))
    .sort((a, b) => b.lastTs - a.lastTs);
}

/**
 * Reorder forecasting: trailing usage rate per item → estimated days of stock
 * left. Only items with usage in the window get a forecast.
 */
export function usageRates(items, txns, { days = 90 } = {}) {
  const sinceTs = Date.now() - days * DAY;
  const used = new Map();
  for (const t of outs(txns).filter(t => t.ts >= sinceTs)) {
    used.set(t.itemId, round3((used.get(t.itemId) || 0) + -t.delta));
  }
  const rows = [];
  for (const item of items) {
    const total = used.get(item.id);
    if (!total) continue;
    const perDay = total / days;
    rows.push({
      item,
      perDay: round3(perDay),
      usedInWindow: total,
      daysLeft: item.qty > 0 ? Math.floor(item.qty / perDay) : 0,
    });
  }
  return rows.sort((a, b) => a.daysLeft - b.daysLeft);
}

export function topUsed(txns, { days = 30, limit = 8 } = {}) {
  const sinceTs = Date.now() - days * DAY;
  const totals = new Map();
  for (const t of outs(txns).filter(t => t.ts >= sinceTs)) {
    const key = `${t.itemName}|${t.unit}`;
    const row = totals.get(key) || { itemName: t.itemName, unit: t.unit, qty: 0 };
    row.qty = round3(row.qty + -t.delta);
    totals.set(key, row);
  }
  return [...totals.values()].sort((a, b) => b.qty - a.qty).slice(0, limit);
}

/** Weekly out-usage buckets, oldest → newest, weeks start Monday. */
export function weeklyUsage(txns, { weeks = 12 } = {}) {
  const now = new Date();
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(monday.getTime() - i * 7 * DAY);
    buckets.push({ start: start.getTime(), end: start.getTime() + 7 * DAY, total: 0 });
  }
  for (const t of outs(txns)) {
    const b = buckets.find(b => t.ts >= b.start && t.ts < b.end);
    if (b) b.total = round3(b.total + -t.delta);
  }
  return buckets.map(b => {
    const d = new Date(b.start);
    return { label: `${d.getMonth() + 1}/${d.getDate()}`, hint: `Week of ${d.toLocaleDateString()}`, value: b.total };
  });
}

/** Inventory value from the optional cost-per-unit field. */
export function stockValue(items) {
  let total = 0, costed = 0;
  for (const i of items) {
    if (typeof i.cost === 'number' && i.cost > 0) {
      total += i.qty > 0 ? i.qty * i.cost : 0;
      costed++;
    }
  }
  return { total: Math.round(total * 100) / 100, costed, uncosted: items.length - costed };
}

/* ---------------- team variants ---------------- */

/** All techs' txns merged, each tagged with its tech name. */
export function mergeTeamTxns(team) {
  const all = [];
  for (const t of team) {
    for (const txn of (t.snapshot.txns || [])) all.push({ ...txn, tech: t.techName });
  }
  return all.sort((a, b) => b.ts - a.ts);
}

/** Items matched across techs (barcode first, else name+unit). */
export function aggregateTeamItems(team) {
  const map = new Map();
  for (const t of team) {
    for (const item of (t.snapshot.items || [])) {
      const key = item.barcode ? `bc:${item.barcode}` : `nm:${item.name.trim().toLowerCase()}|${item.unit}`;
      let row = map.get(key);
      if (!row) {
        row = { key, name: item.name, unit: item.unit, barcode: item.barcode || '', total: 0, value: 0, perTech: [], anyLow: false };
        map.set(key, row);
      }
      const low = item.qty <= item.minQty;
      row.total = round3(row.total + item.qty);
      if (typeof item.cost === 'number' && item.cost > 0 && item.qty > 0) row.value += item.qty * item.cost;
      row.perTech.push({ techName: t.techName, qty: item.qty, low, minQty: item.minQty });
      row.anyLow = row.anyLow || low;
    }
  }
  return [...map.values()]
    .map(r => ({ ...r, value: Math.round(r.value * 100) / 100 }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Per-tech usage totals for a window (team comparison meter rows). */
export function usageByTech(team, { days = 30 } = {}) {
  const sinceTs = Date.now() - days * DAY;
  return team.map(t => ({
    techName: t.techName,
    total: round3(outs(t.snapshot.txns || []).filter(x => x.ts >= sinceTs).reduce((s, x) => s + -x.delta, 0)),
    moves: outs(t.snapshot.txns || []).filter(x => x.ts >= sinceTs).length,
  })).sort((a, b) => b.total - a.total);
}
