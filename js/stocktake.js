// Stocktake (physical count) session. Counts live in `meta` until the user
// confirms on the review screen — only then does stock actually change.
import { metaGet, metaSet, applyStockChange, round3 } from './db.js';
import { isoDate } from './ui.js';

const KEY = 'stocktake';

export function getSession() {
  return metaGet(KEY, null);
}

export async function startSession() {
  const session = { startedAt: Date.now(), counts: {} };
  await metaSet(KEY, session);
  return session;
}

export async function saveSession(session) {
  await metaSet(KEY, session);
}

export async function clearSession() {
  await metaSet(KEY, null);
}

/** Set the counted quantity for an item (null/'' removes the count). */
export function setCount(session, itemId, qty) {
  if (qty === null || qty === '' || Number.isNaN(Number(qty))) delete session.counts[itemId];
  else session.counts[itemId] = round3(Number(qty));
}

/** Add to the counted quantity (scan tally). Returns the new count. */
export function tally(session, itemId, n = 1) {
  const next = round3((session.counts[itemId] ?? 0) + n);
  session.counts[itemId] = next;
  return next;
}

export function progress(session, items) {
  const ids = new Set(items.map(i => i.id));
  const counted = Object.keys(session.counts).filter(id => ids.has(id)).length;
  return { counted, total: items.length };
}

/** Build the review model: per-item expected vs counted, plus the uncounted list. */
export function buildReview(items, session) {
  const counted = [];
  const uncounted = [];
  for (const item of items) {
    if (item.id in session.counts) {
      const c = session.counts[item.id];
      counted.push({ item, expected: item.qty, counted: c, diff: round3(c - item.qty) });
    } else {
      uncounted.push(item);
    }
  }
  counted.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.item.name.localeCompare(b.item.name));
  return { counted, uncounted, variances: counted.filter(r => r.diff !== 0).length };
}

/**
 * Apply the stocktake: one 'adjust' movement per variance (and optionally one
 * per uncounted item, zeroing it). Clears the session afterwards.
 */
export async function commit(review, { zeroUncounted = false } = {}) {
  const note = `Stocktake ${isoDate()}`;
  let adjusted = 0;
  let zeroed = 0;
  for (const row of review.counted) {
    if (row.diff === 0) continue;
    await applyStockChange({ itemId: row.item.id, delta: row.diff, type: 'adjust', note });
    adjusted++;
  }
  if (zeroUncounted) {
    for (const item of review.uncounted) {
      if (item.qty === 0) continue;
      await applyStockChange({ itemId: item.id, delta: -item.qty, type: 'adjust', note: `${note} (not counted → 0)` });
      zeroed++;
    }
  }
  await clearSession();
  return { adjusted, zeroed, unchanged: review.counted.length - adjusted };
}
