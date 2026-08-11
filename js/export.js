// Excel export via the vendored SheetJS build, delivered through the native
// share sheet on phones (iOS home-screen apps can't download reliably) or a
// plain download elsewhere.
import { allItems, isLow } from './items.js';
import { allTxnsDesc } from './txns.js';
import { fmtQty, isoDate, toast } from './ui.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function stamp(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const TYPE_LABEL = { in: 'In', out: 'Out', adjust: 'Adjust' };

export function buildInventoryWorkbook(items, txns) {
  const wb = XLSX.utils.book_new();

  const invRows = [
    ['Name', 'Barcode', 'Category', 'Unit', 'Location', 'Qty', 'Min Qty', 'Low?', 'Cost/unit', 'Value', 'Notes', 'Updated'],
    ...items.map(i => [
      i.name, i.barcode || '', i.category || '', i.unit || '', i.location || '',
      Number(fmtQty(i.qty)), Number(fmtQty(i.minQty)), isLow(i) ? 'YES' : '',
      typeof i.cost === 'number' && i.cost > 0 ? i.cost : '',
      typeof i.cost === 'number' && i.cost > 0 && i.qty > 0 ? Math.round(i.qty * i.cost * 100) / 100 : '',
      i.notes || '', stamp(i.updatedAt),
    ]),
  ];
  const wsInv = XLSX.utils.aoa_to_sheet(invRows);
  wsInv['!cols'] = [{ wch: 28 }, { wch: 16 }, { wch: 14 }, { wch: 8 }, { wch: 14 }, { wch: 8 }, { wch: 8 }, { wch: 6 }, { wch: 9 }, { wch: 9 }, { wch: 30 }, { wch: 17 }];
  XLSX.utils.book_append_sheet(wb, wsInv, 'Inventory');

  const logRows = [
    ['Date', 'Item', 'Type', 'Qty change', 'Unit', 'Job', 'Note'],
    ...txns.map(t => [
      stamp(t.ts), t.itemName, TYPE_LABEL[t.type] || t.type, Number(fmtQty(t.delta)), t.unit || '', t.job || '', t.note || '',
    ]),
  ];
  const wsLog = XLSX.utils.aoa_to_sheet(logRows);
  wsLog['!cols'] = [{ wch: 17 }, { wch: 28 }, { wch: 8 }, { wch: 11 }, { wch: 8 }, { wch: 22 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, wsLog, 'Usage Log');

  return wb;
}

export function buildVarianceWorkbook(review) {
  const wb = XLSX.utils.book_new();
  const rows = [
    ['Name', 'Barcode', 'Unit', 'Expected', 'Counted', 'Difference'],
    ...review.counted.map(r => [
      r.item.name, r.item.barcode || '', r.item.unit || '',
      Number(fmtQty(r.expected)), Number(fmtQty(r.counted)), Number(fmtQty(r.diff)),
    ]),
    ...review.uncounted.map(i => [i.name, i.barcode || '', i.unit || '', Number(fmtQty(i.qty)), 'not counted', '']),
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 28 }, { wch: 16 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 11 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Stocktake');
  return wb;
}

/**
 * Hand a file to the user. Phones (touch devices) get the share sheet when the
 * browser supports sharing files; everything else gets a download.
 * Returns 'shared' | 'downloaded' | 'cancelled'.
 */
export async function deliverFile(filename, data, mime) {
  const file = new File([data], filename, { type: mime });
  const preferShare = navigator.maxTouchPoints > 0 && navigator.canShare && navigator.canShare({ files: [file] });
  if (preferShare) {
    try {
      await navigator.share({ files: [file] }); // files-only payload: most reliable on iOS
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // fall through to download on any other share failure
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

export async function exportInventoryXlsx() {
  if (typeof XLSX === 'undefined') { toast('Excel library not loaded yet — try again', { error: true }); return null; }
  const [items, txns] = await Promise.all([allItems(), allTxnsDesc()]);
  const wb = buildInventoryWorkbook(items, txns);
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return deliverFile(`inventory-${isoDate()}.xlsx`, buf, XLSX_MIME);
}

export async function exportVarianceXlsx(review) {
  if (typeof XLSX === 'undefined') { toast('Excel library not loaded yet — try again', { error: true }); return null; }
  const wb = buildVarianceWorkbook(review);
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return deliverFile(`stocktake-${isoDate()}.xlsx`, buf, XLSX_MIME);
}

/* ---------------- v1.1: job costing + team workbooks ---------------- */

export function buildJobCostingWorkbook(jobs, { itemCosts = new Map() } = {}) {
  const wb = XLSX.utils.book_new();
  const anyCosts = itemCosts.size > 0;
  const header = ['Job', 'Item', 'Qty', 'Unit', 'Tech', 'Last used'];
  if (anyCosts) header.push('Cost/unit', 'Cost');
  const rows = [header];
  for (const j of jobs) {
    for (const l of j.lines) {
      const row = [j.job, l.itemName, Number(fmtQty(l.qty)), l.unit || '', l.tech || '', stamp(j.lastTs)];
      if (anyCosts) {
        const c = itemCosts.get(`${l.itemName}|${l.unit}`);
        row.push(c || '', c ? Math.round(l.qty * c * 100) / 100 : '');
      }
      rows.push(row);
    }
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 24 }, { wch: 28 }, { wch: 8 }, { wch: 8 }, { wch: 16 }, { wch: 17 }, { wch: 9 }, { wch: 9 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Usage by Job');
  return wb;
}

export async function exportJobCostingXlsx(jobs, { scopeLabel = 'van', days = 90, itemCosts } = {}) {
  if (typeof XLSX === 'undefined') { toast('Excel library not loaded yet — try again', { error: true }); return null; }
  const wb = buildJobCostingWorkbook(jobs, { itemCosts });
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return deliverFile(`jobs-${scopeLabel}-${days}d-${isoDate()}.xlsx`, buf, XLSX_MIME);
}

export function buildTeamWorkbook(team, { aggregate, teamTxns, teamJobs }) {
  const wb = XLSX.utils.book_new();
  const techNames = team.map(t => t.techName);
  const anyValue = aggregate.some(r => r.value > 0);

  const stockRows = [
    ['Item', 'Barcode', 'Unit', ...techNames, 'Total', ...(anyValue ? ['Value'] : [])],
    ...aggregate.map(r => [
      r.name, r.barcode, r.unit,
      ...techNames.map(n => {
        const p = r.perTech.filter(p => p.techName === n).reduce((s, p) => s + p.qty, 0);
        return r.perTech.some(p => p.techName === n) ? Number(fmtQty(p)) : '';
      }),
      Number(fmtQty(r.total)),
      ...(anyValue ? [r.value || ''] : []),
    ]),
  ];
  const wsStock = XLSX.utils.aoa_to_sheet(stockRows);
  wsStock['!cols'] = [{ wch: 28 }, { wch: 16 }, { wch: 7 }, ...techNames.map(() => ({ wch: 12 })), { wch: 9 }, { wch: 9 }];
  XLSX.utils.book_append_sheet(wb, wsStock, 'Team Stock');

  const lowRows = [['Tech', 'Item', 'Qty', 'Min', 'Unit']];
  for (const t of team) {
    for (const i of (t.snapshot.items || []).filter(i => i.qty <= i.minQty)) {
      lowRows.push([t.techName, i.name, Number(fmtQty(i.qty)), Number(fmtQty(i.minQty)), i.unit || '']);
    }
  }
  const wsLow = XLSX.utils.aoa_to_sheet(lowRows);
  wsLow['!cols'] = [{ wch: 16 }, { wch: 28 }, { wch: 8 }, { wch: 8 }, { wch: 7 }];
  XLSX.utils.book_append_sheet(wb, wsLow, 'Low Stock');

  const jobRows = [['Job', 'Item', 'Qty', 'Unit', 'Tech', 'Last used']];
  for (const j of teamJobs) {
    for (const l of j.lines) jobRows.push([j.job, l.itemName, Number(fmtQty(l.qty)), l.unit || '', l.tech || '', stamp(j.lastTs)]);
  }
  const wsJobs = XLSX.utils.aoa_to_sheet(jobRows);
  wsJobs['!cols'] = [{ wch: 24 }, { wch: 28 }, { wch: 8 }, { wch: 8 }, { wch: 16 }, { wch: 17 }];
  XLSX.utils.book_append_sheet(wb, wsJobs, 'Usage by Job');

  const logRows = [
    ['Date', 'Tech', 'Item', 'Type', 'Qty change', 'Unit', 'Job', 'Note'],
    ...teamTxns.map(t => [stamp(t.ts), t.tech || '', t.itemName, TYPE_LABEL[t.type] || t.type, Number(fmtQty(t.delta)), t.unit || '', t.job || '', t.note || '']),
  ];
  const wsLog = XLSX.utils.aoa_to_sheet(logRows);
  wsLog['!cols'] = [{ wch: 17 }, { wch: 16 }, { wch: 28 }, { wch: 8 }, { wch: 11 }, { wch: 7 }, { wch: 22 }, { wch: 28 }];
  XLSX.utils.book_append_sheet(wb, wsLog, 'Usage Log');

  return wb;
}

export async function exportTeamXlsx(team) {
  if (typeof XLSX === 'undefined') { toast('Excel library not loaded yet — try again', { error: true }); return null; }
  const { aggregateTeamItems, mergeTeamTxns, usageByJob } = await import('./analytics.js');
  const aggregate = aggregateTeamItems(team);
  const teamTxns = mergeTeamTxns(team).filter(t => t.ts >= Date.now() - 90 * 24 * 3600 * 1000);
  const teamJobs = usageByJob(teamTxns, { sinceTs: Date.now() - 90 * 24 * 3600 * 1000 });
  const wb = buildTeamWorkbook(team, { aggregate, teamTxns, teamJobs });
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return deliverFile(`team-stock-${isoDate()}.xlsx`, buf, XLSX_MIME);
}
