// Monthly Excel report (mirrors the household's original spreadsheet) plus a
// JSON backup. Files go out through the native share sheet on phones.
import { isoDate, monthLabel, toast, confirmDialog } from './ui.js';
import { dbAll } from './db.js';
import { allCategories, getHousehold, spentByCategory } from './categories.js';
import { allRecurring, monthlySetAside, freqLabel } from './recurring.js';
import { txnsForMonth } from './txns.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const usd = (cents) => Math.round(cents) / 100;

export function confirmExport(what) {
  return confirmDialog(`Create ${what}?`, { okLabel: 'Create file', title: 'Export' });
}

/** Share sheet on phones, download elsewhere (same logic as stocktracker). */
export async function deliverFile(filename, data, mime) {
  const file = new File([data], filename, { type: mime });
  const preferShare = navigator.maxTouchPoints > 0 && navigator.canShare && navigator.canShare({ files: [file] });
  if (preferShare) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'downloaded';
}

export async function buildMonthlyWorkbook(ym) {
  const [cats, spent, household, txns, recurring] = await Promise.all([
    allCategories({ includeArchived: true }), spentByCategory(ym), getHousehold(), txnsForMonth(ym), allRecurring(),
  ]);
  const wb = XLSX.utils.book_new();

  // Sheet 1: Monthly Budget — budget vs actual per category, like the original
  const budgetRows = [
    [`Household Budget — ${monthLabel(ym)}`],
    [],
    ['Group', 'Category', 'Budget', 'Spent', 'Remaining'],
  ];
  let bTotal = 0, sTotal = 0;
  for (const c of cats.filter(c => !c.archived)) {
    const s = spent.get(c.id) || 0;
    bTotal += c.budgetCents; sTotal += s;
    budgetRows.push([c.group, c.name, usd(c.budgetCents), usd(s), usd(c.budgetCents - s)]);
  }
  budgetRows.push([]);
  budgetRows.push(['', 'Total Expenses', usd(bTotal), usd(sTotal), usd(bTotal - sTotal)]);
  budgetRows.push(['', 'Income', usd(household.incomeCents || 0)]);
  budgetRows.push(['', 'Remaining (Income − Spent)', '', '', usd((household.incomeCents || 0) - sTotal)]);
  const wsB = XLSX.utils.aoa_to_sheet(budgetRows);
  wsB['!cols'] = [{ wch: 22 }, { wch: 26 }, { wch: 10 }, { wch: 10 }, { wch: 11 }];
  XLSX.utils.book_append_sheet(wb, wsB, 'Monthly Budget');

  // Sheet 2: Transactions
  const catName = new Map(cats.map(c => [c.id, c.name]));
  const txRows = [
    ['Date', 'Merchant', 'Category', 'Amount', 'Entered by', 'Source', 'Note'],
    ...txns.map(t => [
      t.date, t.merchant || '', catName.get(t.categoryId) || '', usd(t.amountCents),
      t.enteredBy || '', t.source || '', t.note || '',
    ]),
  ];
  const wsT = XLSX.utils.aoa_to_sheet(txRows);
  wsT['!cols'] = [{ wch: 11 }, { wch: 24 }, { wch: 18 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 28 }];
  XLSX.utils.book_append_sheet(wb, wsT, 'Transactions');

  // Sheet 3: Recurring & set-asides (the original "Non-Monthly Items")
  const recRows = [
    ['Item', 'Amount', 'Frequency', 'Mode', 'Next due', 'Monthly set-aside'],
    ...recurring.filter(d => d.active).map(d => [
      d.name, usd(d.amountCents), freqLabel(d), d.mode, d.nextDue || '', usd(monthlySetAside(d)),
    ]),
  ];
  const wsR = XLSX.utils.aoa_to_sheet(recRows);
  wsR['!cols'] = [{ wch: 24 }, { wch: 10 }, { wch: 16 }, { wch: 10 }, { wch: 11 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, wsR, 'Recurring');

  return wb;
}

export async function exportMonthlyXlsx(ym) {
  if (typeof XLSX === 'undefined') { toast('Excel library not loaded yet — try again', { error: true }); return null; }
  if (!(await confirmExport(`the ${monthLabel(ym)} budget report (.xlsx)`))) return 'cancelled';
  const wb = await buildMonthlyWorkbook(ym);
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return deliverFile(`budget-${ym}.xlsx`, buf, XLSX_MIME);
}

/** Full JSON backup of every store (photos excluded — they live on the server). */
export async function exportBackup() {
  const [txns, categories, recurring, shared] = await Promise.all([
    dbAll('txns'), dbAll('categories'), dbAll('recurring'), dbAll('shared'),
  ]);
  const backup = {
    app: 'budgettracker', version: 1, exportedAt: new Date().toISOString(),
    txns, categories, recurring, shared,
  };
  return deliverFile(`budget-backup-${isoDate()}.json`, JSON.stringify(backup, null, 1), 'application/json');
}
