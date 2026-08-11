// Bulk item import from CSV or Excel — for seeding a van without scanning
// everything one by one. Parsing is done by the already-vendored SheetJS.
import { createItem, getByBarcode, allItems } from './items.js';
import { deliverFile } from './export.js';
import { isoDate } from './ui.js';

const HEADER_ALIASES = {
  name: ['name', 'item', 'item name', 'product', 'description'],
  barcode: ['barcode', 'code', 'ean', 'upc', 'sku'],
  category: ['category', 'cat', 'group', 'type'],
  unit: ['unit', 'uom', 'units'],
  location: ['location', 'loc', 'bin', 'shelf'],
  qty: ['qty', 'quantity', 'stock', 'on hand', 'count'],
  minQty: ['min', 'minqty', 'min qty', 'min stock', 'minimum', 'reorder', 'reorder point'],
  cost: ['cost', 'price', 'unit cost', 'cost/unit', 'unit price'],
  notes: ['notes', 'note', 'comments', 'comment'],
};

/** Quote-aware CSV parser — SheetJS coerces CSV cells (e.g. "2,5" → 25), so
    CSVs are parsed by hand and SheetJS only handles real .xlsx files. */
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

/** Parse a .csv/.xlsx file into normalized item rows + a mapping report. */
export async function parseImportFile(file) {
  let grid;
  if (/\.csv$/i.test(file.name) || (file.type || '').includes('csv')) {
    grid = parseCsv(await file.text());
  } else {
    if (typeof XLSX === 'undefined') throw new Error('Spreadsheet library not loaded yet — try again');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error('No sheet found in that file');
    grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  }
  if (grid.length < 2) throw new Error('File needs a header row plus at least one item row');

  const headers = grid[0].map(h => String(h).trim().toLowerCase());
  const colFor = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = headers.findIndex(h => aliases.includes(h));
    if (idx !== -1) colFor[field] = idx;
  }
  if (colFor.name === undefined) {
    throw new Error(`Could not find a "Name" column. Found columns: ${grid[0].filter(Boolean).join(', ') || '(none)'}`);
  }

  const num = (v) => {
    const n = parseFloat(String(v).replace(',', '.').replace(/[^0-9.\-]/g, ''));
    return Number.isNaN(n) ? 0 : n;
  };
  const rows = [];
  let skippedNoName = 0;
  for (const line of grid.slice(1)) {
    const get = (f) => colFor[f] === undefined ? '' : String(line[colFor[f]] ?? '').trim();
    const name = get('name');
    if (!name) { if (line.some(c => String(c).trim() !== '')) skippedNoName++; continue; }
    rows.push({
      name,
      barcode: get('barcode'),
      category: get('category'),
      unit: get('unit') || 'pcs',
      location: get('location'),
      qty: num(get('qty')),
      minQty: num(get('minQty')),
      cost: colFor.cost !== undefined ? num(get('cost')) : undefined,
      notes: get('notes'),
    });
  }
  return {
    rows,
    report: {
      mapped: Object.keys(colFor),
      unmappedHeaders: grid[0].filter((h, i) => h && !Object.values(colFor).includes(i)),
      skippedNoName,
    },
  };
}

/** Create the parsed items, skipping anything that already exists. */
export async function runImport(rows) {
  const existing = await allItems();
  const nameKeys = new Set(existing.map(i => `${i.name.trim().toLowerCase()}|${i.unit}`));
  let added = 0, dupBarcode = 0, dupName = 0, failed = 0;
  for (const row of rows) {
    try {
      if (row.barcode && await getByBarcode(row.barcode)) { dupBarcode++; continue; }
      if (nameKeys.has(`${row.name.trim().toLowerCase()}|${row.unit}`)) { dupName++; continue; }
      await createItem(row);
      nameKeys.add(`${row.name.trim().toLowerCase()}|${row.unit}`);
      added++;
    } catch { failed++; }
  }
  return { added, dupBarcode, dupName, failed };
}

export async function downloadTemplate() {
  const csv = [
    'Name,Barcode,Category,Unit,Location,Qty,Min Stock,Cost,Notes',
    'Deck screws 4x40,4006381333931,Fixings,box,Van shelf A,12,4,8.50,',
    'Silicone sealant clear,,Sealants,tube,Van shelf B,6,3,6.20,Clear only',
    'Cable 2.5mm T&E,,Electrical,m,Rack 2,50,20,1.10,',
  ].join('\r\n');
  return deliverFile(`stock-import-template-${isoDate()}.csv`, csv, 'text/csv');
}
