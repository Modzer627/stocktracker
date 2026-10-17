// Pure functions: week math and the weekly roll-ups the manager sees.
// Weeks start Monday and are computed in the browser's local time.
import { normalizePart } from './util.js';

const DAY = 24 * 3600 * 1000;
const pad = (n) => String(n).padStart(2, '0');

export function startOfWeek(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
/** "YYYY-MM-DD" of the Monday that starts the week containing `d`. */
export function weekKey(d = new Date()) {
  const m = startOfWeek(d);
  return `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
}
export function parseWeekKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function weekRange(key) {
  const start = parseWeekKey(key);
  const end = new Date(start); end.setDate(end.getDate() + 7);
  return { start, end };
}
export function shiftWeek(key, n) {
  const d = parseWeekKey(key); d.setDate(d.getDate() + 7 * n);
  return weekKey(d);
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function weekLabel(key) {
  const { start, end } = weekRange(key);
  const last = new Date(end.getTime() - DAY);
  const sameMonth = start.getMonth() === last.getMonth();
  return `${MONTHS[start.getMonth()]} ${start.getDate()} – ${sameMonth ? '' : MONTHS[last.getMonth()] + ' '}${last.getDate()}, ${last.getFullYear()}`;
}

export const partKey = (line) => line.partId || ('txt:' + normalizePart(line.partText));

export function destLabel(sub) {
  if (sub.dest === 'van') return 'Van stock';
  if (sub.dest === 'job') return `Job ${sub.job}`;
  return sub.job || 'Other';
}

const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Roll up a week's take/return submissions. Requests are excluded (they are
 * not movements). Returns:
 *   byTech: [{ techId, techName, taken, returned, net, count, parts: [{ part, taken, returned, net, dests: [] }], submissions: [] }]
 *   byPart: [{ part, taken, returned, net, techs: [{ techName, taken, returned, net }] }]
 *   totals: { taken, returned, net, submissions, techs, parts }
 */
export function aggregate(submissions) {
  const techs = new Map();
  const parts = new Map();
  let totalTaken = 0, totalReturned = 0, count = 0;

  for (const s of submissions) {
    if (s.type !== 'take' && s.type !== 'return') continue;
    count++;
    const sign = s.type === 'return' ? 'returned' : 'taken';
    let t = techs.get(s.techId);
    if (!t) { t = { techId: s.techId, techName: s.techName, taken: 0, returned: 0, count: 0, parts: new Map(), submissions: [] }; techs.set(s.techId, t); }
    t.count++;
    t.submissions.push(s);
    const dest = destLabel(s);
    for (const l of s.lines) {
      const k = partKey(l);
      const name = l.part || l.partText;
      let tp = t.parts.get(k);
      if (!tp) { tp = { part: name, taken: 0, returned: 0, dests: new Map() }; t.parts.set(k, tp); }
      tp[sign] = r3(tp[sign] + l.qty);
      tp.dests.set(dest, r3((tp.dests.get(dest) || 0) + (sign === 'taken' ? l.qty : -l.qty)));
      t[sign] = r3(t[sign] + l.qty);

      let p = parts.get(k);
      if (!p) { p = { part: name, taken: 0, returned: 0, techs: new Map() }; parts.set(k, p); }
      p[sign] = r3(p[sign] + l.qty);
      let pt = p.techs.get(s.techId);
      if (!pt) { pt = { techName: s.techName, taken: 0, returned: 0 }; p.techs.set(s.techId, pt); }
      pt[sign] = r3(pt[sign] + l.qty);

      if (sign === 'taken') totalTaken = r3(totalTaken + l.qty); else totalReturned = r3(totalReturned + l.qty);
    }
  }

  const byName = (a, b) => a.part.localeCompare(b.part, undefined, { numeric: true, sensitivity: 'base' });
  const byTech = [...techs.values()].map(t => ({
    ...t,
    net: r3(t.taken - t.returned),
    parts: [...t.parts.values()].map(p => ({
      ...p, net: r3(p.taken - p.returned),
      dests: [...p.dests.entries()].map(([label, qty]) => ({ label, qty })),
    })).sort(byName),
    submissions: t.submissions.sort((a, b) => a.createdAt < b.createdAt ? 1 : -1),
  })).sort((a, b) => a.techName.localeCompare(b.techName));

  const byPart = [...parts.values()].map(p => ({
    ...p, net: r3(p.taken - p.returned),
    techs: [...p.techs.values()].map(t => ({ ...t, net: r3(t.taken - t.returned) })).sort((a, b) => b.net - a.net),
  })).sort(byName);

  return {
    byTech, byPart,
    totals: { taken: totalTaken, returned: totalReturned, net: r3(totalTaken - totalReturned), submissions: count, techs: byTech.length, parts: byPart.length },
  };
}

/** Flat rows for export / copy: one row per tech × part. */
export function techRows(agg) {
  const rows = [];
  for (const t of agg.byTech) for (const p of t.parts) {
    rows.push({ Tech: t.techName, Part: p.part, Taken: p.taken, Returned: p.returned, Net: p.net, For: p.dests.map(d => `${d.label} (${d.qty})`).join('; ') });
  }
  return rows;
}
export function partRows(agg) {
  return agg.byPart.map(p => ({ Part: p.part, Taken: p.taken, Returned: p.returned, Net: p.net, Techs: p.techs.map(t => `${t.techName} (${t.net})`).join('; ') }));
}
export function logRows(submissions) {
  const rows = [];
  for (const s of [...submissions].sort((a, b) => a.createdAt < b.createdAt ? -1 : 1)) {
    for (const l of s.lines) {
      rows.push({
        When: new Date(s.createdAt).toLocaleString(), Tech: s.techName, Type: s.type,
        Part: l.part || l.partText, Qty: l.qty, For: destLabel(s), 'Needed by': s.neededBy || '', Note: s.note || '',
      });
    }
  }
  return rows;
}

export function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n');
}
export function toTsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return [cols.join('\t'), ...rows.map(r => cols.map(c => String(r[c] ?? '').replace(/\t|\n/g, ' ')).join('\t'))].join('\n');
}
