// Bank statement import (CSV or XLSX): map columns, preview with per-row
// category picks, remember merchant → category choices, skip duplicates.
// CSV is parsed by hand (SheetJS mangles CSV decimals); SheetJS — vendored by
// the stocktracker app at ../vendor/sheetjs — handles real .xlsx files.
import { dbAll } from './db.js';
import { alive } from './store.js';
import { saveTxn } from './txns.js';
import { getHousehold, saveHousehold } from './categories.js';

const HEADER_ALIASES = {
  date: ['date', 'transaction date', 'posted date', 'post date', 'posting date'],
  amount: ['amount', 'debit', 'withdrawal', 'transaction amount', 'value'],
  description: ['description', 'merchant', 'payee', 'name', 'details', 'memo', 'transaction'],
};

/** Quote-aware CSV parser (same approach as the stocktracker importer). */
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}

function toIsoDate(v) {
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);            // 2026-08-17
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);            // 8/17/2026 (US banks)
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return null;
}

/**
 * Parse a bank CSV/XLSX into candidate expenses.
 * Bank conventions vary: debits may be negative ("-42.10") or a separate
 * positive Debit column. Amounts normalize to positive expense cents;
 * credits/deposits (money in) are skipped.
 */
export async function parseBankFile(file) {
  let grid;
  if (/\.csv$/i.test(file.name) || (file.type || '').includes('csv')) {
    grid = parseCsv(await file.text());
  } else {
    if (typeof XLSX === 'undefined') throw new Error('Spreadsheet library not loaded yet — try again');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error('No sheet found in that file');
    grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  }
  if (grid.length < 2) throw new Error('File needs a header row plus at least one transaction');

  const headers = grid[0].map(h => String(h).trim().toLowerCase());
  const colFor = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = headers.findIndex(h => aliases.includes(h));
    if (idx !== -1) colFor[field] = idx;
  }
  for (const f of ['date', 'amount', 'description']) {
    if (colFor[f] === undefined) {
      throw new Error(`Could not find a "${f}" column. Found: ${grid[0].filter(Boolean).join(', ') || '(none)'}`);
    }
  }

  const rows = [];
  let skipped = 0;
  for (const line of grid.slice(1)) {
    const date = toIsoDate(line[colFor.date]);
    const rawAmount = String(line[colFor.amount] ?? '').trim();
    const desc = String(line[colFor.description] ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const n = parseFloat(rawAmount.replace(/[$,()\s]/g, '')) * (/^\(.*\)$/.test(rawAmount) ? -1 : 1);
    if (!date || !desc || Number.isNaN(n) || n === 0) { skipped++; continue; }
    const headerSaysDebit = /debit|withdrawal/.test(headers[colFor.amount]);
    // Negative = money out for signed exports; debit columns are positive.
    const cents = headerSaysDebit ? Math.round(n * 100) : Math.round(-n * 100);
    if (cents <= 0) { skipped++; continue; } // deposit / credit — not an expense
    rows.push({ date, amountCents: cents, merchant: desc });
  }
  return { rows, skipped };
}

const merchantKey = (m) => String(m || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 24);

/** Pre-pick categories from the learned merchant map + flag likely duplicates. */
export async function annotateRows(rows) {
  const [txns, household] = await Promise.all([dbAll('txns'), getHousehold()]);
  const live = alive(txns);
  const seen = new Set(live.map(t => `${t.date}|${t.amountCents}`));
  const map = household.merchantMap || {};
  return rows.map(r => ({
    ...r,
    categoryId: map[merchantKey(r.merchant)] || null,
    duplicate: seen.has(`${r.date}|${r.amountCents}`),
  }));
}

/** Write the chosen rows and remember their merchant → category picks. */
export async function runImport(rows) {
  const household = await getHousehold();
  const map = { ...(household.merchantMap || {}) };
  let added = 0;
  for (const r of rows) {
    await saveTxn({
      amountCents: r.amountCents,
      categoryId: r.categoryId,
      date: r.date,
      merchant: r.merchant,
      source: 'import',
    });
    const key = merchantKey(r.merchant);
    if (key && r.categoryId) map[key] = r.categoryId;
    added++;
  }
  await saveHousehold({ merchantMap: map });
  return { added };
}
