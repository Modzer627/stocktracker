// First-run seed from the household's budget spreadsheet (Aug 2026).
// Every record uses a deterministic id, a FIXED anchor date and updatedAt: 1,
// so two phones that seed independently produce byte-identical rows that
// merge into one after the first sync — and any human edit (updatedAt = now)
// beats the seed everywhere. Never change these ids or anchors in a way that
// would make fresh installs diverge from synced households.
import { dbPut, metaGet, metaSet } from './db.js';

const SEED_TS = 1; // loses to any real edit under last-write-wins

const CATEGORIES = [
  // [id, name, group, monthly budget cents, icon]
  ['cat-rent',     'Rent',               'Housing & Utilities', 160000, '🏠'],
  ['cat-electric', 'Electric',           'Housing & Utilities',  15000, '💡'],
  ['cat-internet', 'Internet',           'Housing & Utilities',  12000, '🌐'],
  ['cat-board',    'Board',              'Horses',              105000, '🐴'],
  ['cat-vaccines', 'Vaccines (sinking)', 'Horses',               13500, '💉'],
  ['cat-farrier',  'Farrier (sinking)',  'Horses',                5000, '🧲'],
  ['cat-food',     'Food',               'Food',                100000, '🍽️'],
  ['cat-gas',      'Vehicle Gas',        'Transportation & Phone', 20000, '⛽'],
  ['cat-verizon',  'Verizon Phone',      'Transportation & Phone', 19500, '📱'],
  ['cat-debt',     'Debt Payments',      'Debt & Other',         48300, '💳'],
  ['cat-subs',     'Subscriptions',      'Debt & Other',         12500, '📺'],
  ['cat-savings',  'Emergency Fund',     'Savings',                  0, '🏦'],
];

const RECURRING = [
  // [id, name, cents, categoryId, unit, interval, anchor, mode]
  ['rec-rent',       'Rent',                160000, 'cat-rent',     'month', 1, '2026-09-01', 'autopost'],
  ['rec-electric',   'Electric bill',        15000, 'cat-electric', 'month', 1, '2026-09-01', 'remind'],
  ['rec-internet',   'Internet',             12000, 'cat-internet', 'month', 1, '2026-09-01', 'autopost'],
  ['rec-board',      'Horse board',         105000, 'cat-board',    'month', 1, '2026-09-01', 'autopost'],
  ['rec-verizon',    'Verizon phone bill',   19500, 'cat-verizon',  'month', 1, '2026-09-01', 'autopost'],
  ['rec-hellofresh', 'Hello Fresh',          15000, 'cat-food',     'week',  1, '2026-08-24', 'autopost'],
  ['rec-cc',         'Credit card payment',  25000, 'cat-debt',     'month', 1, '2026-09-01', 'remind'],
  ['rec-loan',       'Loan payment',         23300, 'cat-debt',     'month', 1, '2026-09-01', 'remind'],
  ['rec-subs',       'Misc subscriptions',   12500, 'cat-subs',     'month', 1, '2026-09-01', 'remind'],
  ['rec-vaccines',   'Horse vaccines',       80000, 'cat-vaccines', 'month', 6, '2027-02-01', 'remind'],
  ['rec-farrier',    'Farrier visit',        10000, 'cat-farrier',  'month', 2, '2026-10-01', 'remind'],
];

export async function seedIfNeeded() {
  if (await metaGet('seededAt', null)) return false;

  for (const [i, [id, name, group, budgetCents, icon]] of CATEGORIES.entries()) {
    await dbPut('categories', {
      id, name, group, budgetCents, icon,
      sortOrder: i, archived: 0, updatedAt: SEED_TS, deleted: 0,
    });
  }
  for (const [id, name, amountCents, categoryId, unit, interval, anchorDate, mode] of RECURRING) {
    await dbPut('recurring', {
      id, name, amountCents, categoryId,
      freq: { unit, interval }, anchorDate, nextDue: anchorDate,
      mode, active: 1, notes: '', updatedAt: SEED_TS, deleted: 0,
    });
  }
  await dbPut('shared', {
    id: 'household',
    incomeCents: 740000, // $7,400/mo combined, from the budget spreadsheet
    // 1-Year Plan assumptions (goals screen) — from the spreadsheet
    plan: {
      startingDebtCents: 351259,
      monthlyAvailableCents: 242500,
      apy: 0.04,
      goalCents: 2000000,
      stretchCents: 3000000,
      startMonth: '2026-09',
    },
    merchantMap: {}, // learned merchant → category picks (bank import)
    updatedAt: SEED_TS, deleted: 0,
  });

  await metaSet('seededAt', Date.now());
  return true;
}

/** Wipe local data and reseed (Settings → reset). */
export async function resetAll() {
  const { dbClear } = await import('./db.js');
  await dbClear('txns', 'categories', 'recurring', 'shared', 'photos', 'meta');
  return seedIfNeeded();
}
