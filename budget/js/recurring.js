// Recurring bills & subscriptions. Occurrence dates derive purely from
// anchorDate + freq, so both partners' phones compute identical schedules.
// Each occurrence posts as a txn with the deterministic id
// 'ro-<defId>-<dueDate>' — an idempotent put locally, and the same row after
// sync when both devices post it. That id is the whole dedup mechanism.
import { dbAll, dbGet, metaGet, uuid } from './db.js';
import { putRecord, softDelete, alive } from './store.js';
import { isoDate, toast } from './ui.js';
import { saveTxn } from './txns.js';

const CATCHUP_MAX = 12; // occurrences auto-posted after a long absence

export function occurrenceId(defId, dueDate) {
  return `ro-${defId}-${dueDate}`;
}

function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return { y, m, d };
}
function fmt(y, m, d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${y}-${p(m)}-${p(d)}`;
}
function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

/** The i-th occurrence date (i = 0 is the anchor itself). */
export function occurrenceDate(def, i) {
  const { y, m, d } = parseDate(def.anchorDate);
  const { unit, interval } = def.freq;
  if (unit === 'week') {
    const base = new Date(y, m - 1, d);
    base.setDate(base.getDate() + i * 7 * interval);
    return fmt(base.getFullYear(), base.getMonth() + 1, base.getDate());
  }
  const monthsAdded = unit === 'year' ? i * 12 * interval : i * interval;
  const total = (m - 1) + monthsAdded;
  const yy = y + Math.floor(total / 12);
  const mm = (total % 12) + 1;
  // Clamp the anchor's day-of-month (31st → Feb 28) so schedules never skip.
  return fmt(yy, mm, Math.min(d, daysInMonth(yy, mm)));
}

/** All occurrence dates ≤ `upto` (ascending). */
export function occurrencesUpTo(def, upto) {
  const out = [];
  for (let i = 0; i < 2000; i++) {
    const date = occurrenceDate(def, i);
    if (date > upto) break;
    out.push(date);
  }
  return out;
}

/** First occurrence strictly after `after`. */
export function nextOccurrenceAfter(def, after) {
  for (let i = 0; i < 2000; i++) {
    const date = occurrenceDate(def, i);
    if (date > after) return date;
  }
  return null;
}

/** Rough monthly set-aside for display ($800 every 6 months → $133/mo). */
export function monthlySetAside(def) {
  const { unit, interval } = def.freq;
  if (unit === 'week') return Math.round(def.amountCents * 52 / 12 / interval);
  if (unit === 'year') return Math.round(def.amountCents / (12 * interval));
  return Math.round(def.amountCents / interval);
}

export function freqLabel(def) {
  const { unit, interval } = def.freq;
  if (interval === 1) return { week: 'weekly', month: 'monthly', year: 'yearly' }[unit];
  return `every ${interval} ${unit}s`;
}

/* ---------- CRUD ---------- */

export async function allRecurring({ includeInactive = true } = {}) {
  const rows = alive(await dbAll('recurring'));
  const defs = includeInactive ? rows : rows.filter(r => r.active);
  return defs.sort((a, b) => String(a.nextDue || '9999').localeCompare(String(b.nextDue || '9999')));
}

export async function saveRecurring(def) {
  if (!def.id) def.id = 'rec-' + uuid().slice(0, 8);
  def.name = String(def.name || '').trim().slice(0, 80);
  def.amountCents = Math.max(0, Math.round(Number(def.amountCents) || 0));
  def.freq = { unit: def.freq?.unit || 'month', interval: Math.max(1, Math.round(Number(def.freq?.interval) || 1)) };
  def.anchorDate = def.anchorDate || isoDate();
  def.mode = def.mode === 'autopost' ? 'autopost' : 'remind';
  def.active = def.active === undefined ? 1 : (def.active ? 1 : 0);
  def.nextDue = nextOccurrenceAfter(def, isoDate()) || def.anchorDate;
  if (!def.name) throw new Error('Needs a name');
  return putRecord('recurring', def);
}

export function deleteRecurring(id) {
  return softDelete('recurring', id);
}

/* ---------- posting engine ---------- */

async function txnExists(id) {
  // Tombstones count: a deleted auto-post must stay deleted.
  return !!(await dbGet('txns', id));
}

/** Post one occurrence as a transaction (Mark paid / autopost / backfill). */
export async function postOccurrence(def, dueDate, { amountCents = null, date = null } = {}) {
  return saveTxn({
    id: occurrenceId(def.id, dueDate),
    amountCents: amountCents ?? def.amountCents,
    categoryId: def.categoryId,
    date: date || dueDate,
    merchant: def.name,
    note: '',
    source: 'recurring',
    recurringId: def.id,
    enteredBy: 'auto',
  });
}

/** Skip an occurrence: a tombstoned txn marks it handled on every device. */
export async function skipOccurrence(def, dueDate) {
  const rec = {
    id: occurrenceId(def.id, dueDate),
    amountCents: def.amountCents,
    categoryId: def.categoryId,
    date: dueDate,
    month: dueDate.slice(0, 7),
    merchant: def.name,
    source: 'recurring',
    recurringId: def.id,
    enteredBy: 'auto',
    createdAt: Date.now(),
    deleted: 1,
  };
  return putRecord('txns', rec);
}

/**
 * Catch up all autopost defs to today. Called on boot and when the app
 * becomes visible again. Returns how many transactions were posted.
 */
export async function postDueRecurring() {
  const today = isoDate();
  const seededAt = await metaGet('seededAt', null);
  const floor = seededAt ? isoDate(seededAt) : today;
  const defs = await allRecurring();
  let posted = 0;
  for (const def of defs) {
    if (!def.active) continue;
    if (def.mode === 'autopost') {
      // Occurrences since install only, newest CATCHUP_MAX — a phone that was
      // in a drawer for a year shouldn't flood the ledger.
      const due = occurrencesUpTo(def, today).filter(d => d >= floor).slice(-CATCHUP_MAX);
      for (const dueDate of due) {
        if (await txnExists(occurrenceId(def.id, dueDate))) continue;
        await postOccurrence(def, dueDate);
        posted++;
      }
    }
    const nextDue = nextOccurrenceAfter(def, today);
    if (nextDue !== def.nextDue) {
      await putRecord('recurring', { ...def, nextDue }, { silent: true });
    }
  }
  if (posted) toast(`Posted ${posted} recurring ${posted === 1 ? 'bill' : 'bills'}`);
  return posted;
}

/**
 * Remind-mode occurrences that need attention: due within `horizon` days or
 * overdue (since install), and not yet paid or skipped. Plus the next few
 * upcoming items of any mode for the home strip.
 */
export async function dueList({ horizon = 7 } = {}) {
  const today = isoDate();
  const seededAt = await metaGet('seededAt', null);
  const floor = seededAt ? isoDate(seededAt) : today;
  const horizonDate = isoDate(Date.now() + horizon * 24 * 3600 * 1000);
  const defs = await allRecurring();
  const due = [];
  const upcoming = [];
  for (const def of defs) {
    if (!def.active) continue;
    if (def.mode === 'remind') {
      const candidates = occurrencesUpTo(def, horizonDate).filter(d => d >= floor).slice(-CATCHUP_MAX);
      for (const dueDate of candidates) {
        if (await txnExists(occurrenceId(def.id, dueDate))) continue;
        due.push({ def, dueDate, overdue: dueDate < today });
      }
    } else if (def.nextDue && def.nextDue <= horizonDate) {
      upcoming.push({ def, dueDate: def.nextDue, overdue: false });
    }
  }
  due.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return { due, upcoming };
}
