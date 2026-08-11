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
    ['Name', 'Barcode', 'Category', 'Unit', 'Location', 'Qty', 'Min Qty', 'Low?', 'Notes', 'Updated'],
    ...items.map(i => [
      i.name, i.barcode || '', i.category || '', i.unit || '', i.location || '',
      Number(fmtQty(i.qty)), Number(fmtQty(i.minQty)), isLow(i) ? 'YES' : '', i.notes || '', stamp(i.updatedAt),
    ]),
  ];
  const wsInv = XLSX.utils.aoa_to_sheet(invRows);
  wsInv['!cols'] = [{ wch: 28 }, { wch: 16 }, { wch: 14 }, { wch: 8 }, { wch: 14 }, { wch: 8 }, { wch: 8 }, { wch: 6 }, { wch: 30 }, { wch: 17 }];
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
