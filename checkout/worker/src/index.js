// Parts Checkout backend — Cloudflare Worker + D1.
//
// Tech page (team key):
//   GET  /v1/bootstrap                      techs + parts pick list
//   POST /v1/submissions                    create a take / return / request
//        (also the Power Automate bridge: techName + partsText instead of techId + lines)
//   PUT  /v1/submissions/:id                edit own submission (edit token, 24 h)
//   DELETE /v1/submissions/:id              delete own submission (edit token, 24 h)
//   PUT  /v1/photo/:key                     upload a JPEG for a return / request
// Manager dashboard (manager PIN):
//   GET  /v1/manager/ping                   verify the PIN
//   GET  /v1/manager/config                 team key (to print the QR code)
//   GET  /v1/submissions?from=&to=          submissions + lines in a time range
//   PUT/DELETE /v1/submissions/:id          edit / delete anything
//   GET  /v1/requests                       open requests (+ recently closed)
//   POST /v1/submissions/:id/status         request status
//   GET/PUT /v1/weeks/:key                  "reviewed" flag per week
//   GET/PUT /v1/techs, DELETE /v1/techs/:id
//   GET/PUT /v1/parts, DELETE /v1/parts/:id, POST /v1/parts/merge
// Either key: GET /v1/photo/:key, GET /v1/health
//
// Secrets: TEAM_KEY (baked into the QR code link), MANAGER_PIN.

const ALLOWED_ORIGINS = [
  'https://modzer627.github.io',
  'http://localhost:8123',
  'http://127.0.0.1:8123',
];
const KEY_HEADER = 'X-Checkout-Key';
const EDIT_HEADER = 'X-Edit-Token';
const EDIT_WINDOW_MS = 24 * 3600 * 1000;
const MAX_LINES = 50;
const MAX_PHOTO_BYTES = 600_000;
const TYPES = new Set(['take', 'return', 'request']);
const DESTS = new Set(['van', 'job', 'other']);
const REQUEST_STATUSES = new Set(['open', 'ordered', 'received', 'closed']);
const ID_RE = /^[\w-]{8,64}$/;

/* ---------------- helpers ---------------- */

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': allowed, 'Vary': 'Origin' };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function secretMatches(given, expected) {
  if (!given || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const nowIso = () => new Date().toISOString();

/** Matching key for a part number: upper-case, single spaces, no stray punctuation at the ends. */
export function normalizePart(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, ' ').replace(/^[\s.,;:-]+|[\s.,;:-]+$/g, '').trim();
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------------- parts ---------------- */

/** Find the part a typed line refers to, learning it if it is new. Returns the part id or null. */
async function resolvePart(env, text, now) {
  const norm = normalizePart(text);
  if (!norm) return null;
  let row = await env.DB.prepare('SELECT id FROM parts WHERE norm = ?1').bind(norm).first();
  if (!row) {
    const alias = await env.DB.prepare('SELECT part_id FROM part_aliases WHERE alias_norm = ?1').bind(norm).first();
    if (alias) row = { id: alias.part_id };
  }
  if (!row) {
    const id = crypto.randomUUID();
    // Learned part numbers are stored in their normalised (upper-case) form so
    // the pick list looks the same no matter which client sent them.
    await env.DB.prepare(
      'INSERT INTO parts (id, number, norm, active, uses, last_used_at, created_at) VALUES (?1, ?2, ?2, 1, 0, ?3, ?3)'
    ).bind(id, norm, now).run();
    row = { id };
  }
  await env.DB.prepare('UPDATE parts SET uses = uses + 1, last_used_at = ?2, active = 1 WHERE id = ?1').bind(row.id, now).run();
  return row.id;
}

function rowToPart(r) {
  return {
    id: r.id, number: r.number, description: r.description || '',
    active: !!r.active, uses: r.uses || 0, lastUsedAt: r.last_used_at || null,
  };
}

function rowToTech(r) {
  return { id: r.id, name: r.name, truck: r.truck || '', active: !!r.active };
}

/* ---------------- submissions ---------------- */

/** Validate and normalise a submission body. Throws HttpError on bad input. */
async function readSubmission(env, body) {
  const type = str(body.type, 10).toLowerCase();
  if (!TYPES.has(type)) throw new HttpError(400, 'type must be take, return or request');
  // The tech page sends techId; an outside sender (e.g. Power Automate) may send
  // techName instead, matched case-insensitively against the active tech list.
  const techId = str(body.techId, 64);
  let tech = null;
  if (ID_RE.test(techId)) {
    tech = await env.DB.prepare('SELECT id, name FROM techs WHERE id = ?1').bind(techId).first();
  } else if (str(body.techName, 60)) {
    tech = await env.DB.prepare('SELECT id, name FROM techs WHERE active = 1 AND name = ?1 COLLATE NOCASE')
      .bind(str(body.techName, 60)).first();
    if (!tech) throw new HttpError(400, `unknown technician "${str(body.techName, 60)}" — add them in Setup first`);
  } else {
    throw new HttpError(400, 'techId or techName required');
  }
  if (!tech) throw new HttpError(400, 'unknown technician');

  let dest = str(body.dest, 10).toLowerCase() || 'van';
  if (!DESTS.has(dest)) throw new HttpError(400, 'dest must be van, job or other');
  const job = str(body.job, 80);
  if (dest === 'job' && !job) throw new HttpError(400, 'job number required');

  let neededBy = null;
  if (type === 'request' && body.neededBy) {
    neededBy = str(body.neededBy, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(neededBy)) throw new HttpError(400, 'neededBy must be YYYY-MM-DD');
  }
  const note = str(body.note, 500) || null;
  const photoKey = str(body.photoKey, 64) || null;
  if (photoKey && !ID_RE.test(photoKey)) throw new HttpError(400, 'bad photo key');

  // Lines can arrive structured ([{partText, qty}]) or as one free-text blob
  // ("4x 711S\n2x 7060") that gets parsed here.
  const rawLines = Array.isArray(body.lines) && body.lines.length ? body.lines : parsePartsText(body.partsText);
  const lines = [];
  for (const l of rawLines) {
    const partText = str(l?.partText, 120);
    const qty = Math.round(Number(l?.qty) * 1000) / 1000;
    if (!partText) continue;
    if (!(qty > 0) || qty > 100000) throw new HttpError(400, `quantity for "${partText}" must be a positive number`);
    lines.push({ partText, qty });
  }
  if (!lines.length) throw new HttpError(400, 'at least one part is required');
  if (lines.length > MAX_LINES) throw new HttpError(400, `at most ${MAX_LINES} parts per submission`);

  return { type, techId: tech.id, techName: tech.name, dest, job: dest === 'van' ? null : (job || null), neededBy, note, photoKey, lines };
}

/**
 * Parse a free-text parts blob, one part per line (or comma / semicolon), into
 * [{partText, qty}]. Understands the ways techs write quantities:
 *   "4x 711S", "711S x4", "(2) CO1224T", "CO1224T (2)", "14 PG9303",
 *   "2 - 1106W", "1106W - 2"; a bare "PS-1820UL" is quantity 1.
 */
export function parsePartsText(text) {
  const out = [];
  const num = '(\\d+(?:\\.\\d+)?)';
  const rules = [
    [new RegExp(`^${num}[xX×]\\s*(.+)$`), 'qty-first'],            // 2x 7060, 2x7060
    [new RegExp(`^(.+?)\\s*[xX×]${num}$`), 'part-first'],          // 1168 x2, 711S x4
    [new RegExp(`^${num}\\s+[xX×]\\s+(.+)$`), 'qty-first'],      // 9 x DS151i
    [new RegExp(`^(.+?)\\s+[xX×]\\s+${num}$`), 'part-first'],    // CR123 x 40
    [new RegExp(`^\\(\\s*${num}\\s*\\)\\s*(.+)$`), 'qty-first'], // (2) CO1224T
    [new RegExp(`^(.+?)\\s*\\(\\s*${num}\\s*\\)$`), 'part-first'], // CO1224T (2)
    [new RegExp(`^${num}\\s*[-–:]\\s*(.+)$`), 'qty-first'],      // 2 - 1106W
    [new RegExp(`^(.+?)\\s*[-–:]\\s*${num}$`), 'part-first'],    // 1106W - 2
    [new RegExp(`^${num}\\s+([A-Za-z].*)$`), 'qty-first'],         // 14 PG9303
  ];
  for (let line of String(text || '').split(/[\n;,]+/)) {
    line = line.replace(/^[\s.\-–]+|[\s.\-–]+$/g, '');
    if (!line) continue;
    let hit = null;
    for (const [re, order] of rules) {
      const m = line.match(re);
      if (!m) continue;
      let qty = Number(order === 'qty-first' ? m[1] : m[2]);
      let part = (order === 'qty-first' ? m[2] : m[1]).trim();
      // "1168 x 2": both numeric — the smaller one is the quantity.
      if (/^\d+(?:\.\d+)?$/.test(part) && Number(part) < qty) [qty, part] = [Number(part), String(qty)];
      hit = { partText: part, qty };
      break;
    }
    out.push(hit || { partText: line, qty: 1 });
  }
  return out;
}

async function writeLines(env, submissionId, lines, now) {
  const stmts = [env.DB.prepare('DELETE FROM lines WHERE submission_id = ?1').bind(submissionId)];
  let pos = 0;
  for (const l of lines) {
    const partId = await resolvePart(env, l.partText, now);
    stmts.push(env.DB.prepare(
      'INSERT INTO lines (id, submission_id, part_id, part_text, qty, pos) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
    ).bind(crypto.randomUUID(), submissionId, partId, l.partText, l.qty, pos++));
  }
  await env.DB.batch(stmts);
}

function rowToSubmission(r, lines = []) {
  return {
    id: r.id, type: r.type, techId: r.tech_id, techName: r.tech_name,
    dest: r.dest, job: r.job || '', neededBy: r.needed_by || null, note: r.note || '',
    photoKey: r.photo_key || null, status: r.status || null, source: r.source,
    createdAt: r.created_at, updatedAt: r.updated_at,
    lines: lines.map(l => ({
      id: l.id, partId: l.part_id || null, partText: l.part_text,
      part: l.part_number || l.part_text, qty: l.qty, pos: l.pos,
    })),
  };
}

async function loadSubmission(env, id) {
  const row = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?1 AND deleted_at IS NULL').bind(id).first();
  if (!row) return null;
  const { results } = await env.DB.prepare(
    `SELECT l.*, p.number AS part_number FROM lines l LEFT JOIN parts p ON p.id = l.part_id
     WHERE l.submission_id = ?1 ORDER BY l.pos`
  ).bind(id).all();
  return { row, sub: rowToSubmission(row, results) };
}

/** Submissions (with their lines) matching a WHERE clause written against alias `s`. */
async function listSubmissions(env, where, binds) {
  const { results: subs } = await env.DB.prepare(
    `SELECT s.* FROM submissions s WHERE s.deleted_at IS NULL AND ${where} ORDER BY s.created_at DESC`
  ).bind(...binds).all();
  const { results: lines } = await env.DB.prepare(
    `SELECT l.*, p.number AS part_number FROM lines l
     JOIN submissions s ON s.id = l.submission_id
     LEFT JOIN parts p ON p.id = l.part_id
     WHERE s.deleted_at IS NULL AND ${where}
     ORDER BY l.pos`
  ).bind(...binds).all();
  const bySub = new Map();
  for (const l of lines) {
    if (!bySub.has(l.submission_id)) bySub.set(l.submission_id, []);
    bySub.get(l.submission_id).push(l);
  }
  return subs.map(r => rowToSubmission(r, bySub.get(r.id) || []));
}

/* ---------------- request handler ---------------- */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req.headers.get('Origin'));

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': req.headers.get('Access-Control-Request-Headers') || `${KEY_HEADER},${EDIT_HEADER},Content-Type`,
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const key = req.headers.get(KEY_HEADER);
    const isManager = await secretMatches(key, env.MANAGER_PIN);
    const isTeam = isManager || await secretMatches(key, env.TEAM_KEY);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;

    try {
      if (path === '/v1/health' && m === 'GET') return json({ ok: true, time: nowIso() }, 200, cors);

      /* ---------- tech page ---------- */

      if (path === '/v1/bootstrap' && m === 'GET') {
        if (!isTeam) return json({ error: 'unauthorized' }, 401, cors);
        const [{ results: techs }, { results: parts }] = await Promise.all([
          env.DB.prepare('SELECT * FROM techs WHERE active = 1 ORDER BY name COLLATE NOCASE').all(),
          env.DB.prepare('SELECT * FROM parts WHERE active = 1 ORDER BY uses DESC, number COLLATE NOCASE LIMIT 1500').all(),
        ]);
        return json({ ok: true, techs: techs.map(rowToTech), parts: parts.map(rowToPart), serverTime: nowIso() }, 200, cors);
      }

      if (path === '/v1/submissions' && m === 'POST') {
        if (!isTeam) return json({ error: 'unauthorized' }, 401, cors);
        const body = await req.json().catch(() => { throw new HttpError(400, 'invalid JSON'); });
        const s = await readSubmission(env, body);
        const id = crypto.randomUUID();
        const editToken = crypto.randomUUID();
        const now = nowIso();
        // Allow a client-supplied timestamp only within the last 7 days (offline queue replay).
        let createdAt = now;
        const t = Date.parse(body.createdAt || '');
        if (t && t < Date.now() + 60_000 && t > Date.now() - 7 * 24 * 3600 * 1000) createdAt = new Date(t).toISOString();
        await env.DB.prepare(
          `INSERT INTO submissions (id, type, tech_id, tech_name, dest, job, needed_by, note, photo_key, status, source, edit_token, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)`
        ).bind(id, s.type, s.techId, s.techName, s.dest, s.job, s.neededBy, s.note, s.photoKey,
               s.type === 'request' ? 'open' : null, str(body.source, 20) || 'web', editToken, createdAt).run();
        await writeLines(env, id, s.lines, now);
        const { sub } = await loadSubmission(env, id);
        return json({ ok: true, id, editToken, submission: sub }, 200, cors);
      }

      const subMatch = path.match(/^\/v1\/submissions\/([\w-]{8,64})$/);
      if (subMatch && (m === 'PUT' || m === 'DELETE')) {
        if (!isTeam) return json({ error: 'unauthorized' }, 401, cors);
        const found = await loadSubmission(env, subMatch[1]);
        if (!found) return json({ error: 'not found' }, 404, cors);
        if (!isManager) {
          const token = req.headers.get(EDIT_HEADER);
          const ok = await secretMatches(token, found.row.edit_token);
          if (!ok) return json({ error: 'not your submission' }, 403, cors);
          if (Date.now() - Date.parse(found.row.created_at) > EDIT_WINDOW_MS) {
            return json({ error: 'Submissions can only be changed within 24 hours. Ask the parts manager.' }, 403, cors);
          }
        }
        const now = nowIso();
        if (m === 'DELETE') {
          await env.DB.prepare('UPDATE submissions SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1').bind(found.row.id, now).run();
          return json({ ok: true }, 200, cors);
        }
        const body = await req.json().catch(() => { throw new HttpError(400, 'invalid JSON'); });
        const s = await readSubmission(env, body);
        await env.DB.prepare(
          `UPDATE submissions SET type = ?2, tech_id = ?3, tech_name = ?4, dest = ?5, job = ?6, needed_by = ?7,
             note = ?8, photo_key = ?9, status = ?10, updated_at = ?11 WHERE id = ?1`
        ).bind(found.row.id, s.type, s.techId, s.techName, s.dest, s.job, s.neededBy, s.note, s.photoKey,
               s.type === 'request' ? (found.row.status || 'open') : null, now).run();
        await writeLines(env, found.row.id, s.lines, now);
        const { sub } = await loadSubmission(env, found.row.id);
        return json({ ok: true, submission: sub }, 200, cors);
      }

      /* ---------- photos ---------- */

      const photoMatch = path.match(/^\/v1\/photo\/([\w-]{8,64})$/);
      if (photoMatch) {
        if (!isTeam) return json({ error: 'unauthorized' }, 401, cors);
        const pkey = photoMatch[1];
        if (m === 'PUT') {
          const buf = await req.arrayBuffer();
          if (buf.byteLength < 100) return json({ error: 'empty image' }, 400, cors);
          if (buf.byteLength > MAX_PHOTO_BYTES) return json({ error: 'photo too large' }, 413, cors);
          await env.DB.prepare(
            'INSERT INTO photos (key, data, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET data = ?2'
          ).bind(pkey, bytesToB64(buf), nowIso()).run();
          return json({ ok: true, key: pkey, bytes: buf.byteLength }, 200, cors);
        }
        if (m === 'GET') {
          const row = await env.DB.prepare('SELECT data FROM photos WHERE key = ?1').bind(pkey).first();
          if (!row) return json({ error: 'not found' }, 404, cors);
          return new Response(b64ToBytes(row.data), {
            status: 200,
            headers: { ...cors, 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
          });
        }
      }

      /* ---------- manager ---------- */

      if (!isManager) {
        if (path.startsWith('/v1/')) return json({ error: 'unauthorized' }, 401, cors);
        return json({ error: 'not found' }, 404, cors);
      }

      if (path === '/v1/manager/ping' && m === 'GET') return json({ ok: true }, 200, cors);
      if (path === '/v1/manager/config' && m === 'GET') return json({ ok: true, teamKey: env.TEAM_KEY || '' }, 200, cors);

      if (path === '/v1/submissions' && m === 'GET') {
        const from = Date.parse(url.searchParams.get('from') || '');
        const to = Date.parse(url.searchParams.get('to') || '');
        if (!from || !to || to <= from) return json({ error: 'from and to (ISO timestamps) required' }, 400, cors);
        if (to - from > 400 * 24 * 3600 * 1000) return json({ error: 'range too large' }, 400, cors);
        const subs = await listSubmissions(env, 's.created_at >= ?1 AND s.created_at < ?2',
          [new Date(from).toISOString(), new Date(to).toISOString()]);
        return json({ ok: true, submissions: subs, serverTime: nowIso() }, 200, cors);
      }

      if (path === '/v1/requests' && m === 'GET') {
        const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
        const subs = await listSubmissions(env, "s.type = 'request' AND (s.status IS NULL OR s.status != 'closed' OR s.updated_at > ?1)", [cutoff]);
        return json({ ok: true, requests: subs }, 200, cors);
      }

      const statusMatch = path.match(/^\/v1\/submissions\/([\w-]{8,64})\/status$/);
      if (statusMatch && m === 'POST') {
        const body = await req.json().catch(() => ({}));
        const status = str(body.status, 10).toLowerCase();
        if (!REQUEST_STATUSES.has(status)) return json({ error: 'bad status' }, 400, cors);
        const r = await env.DB.prepare(
          "UPDATE submissions SET status = ?2, updated_at = ?3 WHERE id = ?1 AND type = 'request' AND deleted_at IS NULL"
        ).bind(statusMatch[1], status, nowIso()).run();
        if (!r.meta.changes) return json({ error: 'not found' }, 404, cors);
        return json({ ok: true }, 200, cors);
      }

      const weekMatch = path.match(/^\/v1\/weeks\/(\d{4}-\d{2}-\d{2})$/);
      if (weekMatch && m === 'GET') {
        const row = await env.DB.prepare('SELECT * FROM weeks WHERE week_key = ?1').bind(weekMatch[1]).first();
        return json({ ok: true, week: { weekKey: weekMatch[1], reviewedAt: row?.reviewed_at || null, note: row?.note || '' } }, 200, cors);
      }
      if (weekMatch && m === 'PUT') {
        const body = await req.json().catch(() => ({}));
        const reviewedAt = body.reviewed ? nowIso() : null;
        const note = str(body.note, 500) || null;
        await env.DB.prepare(
          `INSERT INTO weeks (week_key, reviewed_at, note) VALUES (?1, ?2, ?3)
           ON CONFLICT(week_key) DO UPDATE SET reviewed_at = ?2, note = COALESCE(?3, weeks.note)`
        ).bind(weekMatch[1], reviewedAt, note).run();
        return json({ ok: true, week: { weekKey: weekMatch[1], reviewedAt, note: note || '' } }, 200, cors);
      }

      /* techs */
      if (path === '/v1/techs' && m === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM techs ORDER BY active DESC, name COLLATE NOCASE').all();
        return json({ ok: true, techs: results.map(rowToTech) }, 200, cors);
      }
      if (path === '/v1/techs' && m === 'PUT') {
        const body = await req.json().catch(() => ({}));
        const techs = Array.isArray(body.techs) ? body.techs : [];
        if (!techs.length || techs.length > 200) return json({ error: 'techs array required (max 200)' }, 400, cors);
        const now = nowIso();
        const stmts = [];
        for (const t of techs) {
          const name = str(t.name, 60);
          if (!name) continue;
          const id = ID_RE.test(String(t.id || '')) ? String(t.id) : crypto.randomUUID();
          stmts.push(env.DB.prepare(
            `INSERT INTO techs (id, name, truck, active, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET name = ?2, truck = ?3, active = ?4`
          ).bind(id, name, str(t.truck, 20) || null, t.active === false ? 0 : 1, now));
        }
        if (stmts.length) await env.DB.batch(stmts);
        const { results } = await env.DB.prepare('SELECT * FROM techs ORDER BY active DESC, name COLLATE NOCASE').all();
        return json({ ok: true, techs: results.map(rowToTech) }, 200, cors);
      }
      const techDel = path.match(/^\/v1\/techs\/([\w-]{8,64})$/);
      if (techDel && m === 'DELETE') {
        await env.DB.prepare('UPDATE techs SET active = 0 WHERE id = ?1').bind(techDel[1]).run();
        return json({ ok: true }, 200, cors);
      }

      /* parts */
      if (path === '/v1/parts' && m === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM parts ORDER BY active DESC, uses DESC, number COLLATE NOCASE').all();
        return json({ ok: true, parts: results.map(rowToPart) }, 200, cors);
      }
      if (path === '/v1/parts' && m === 'PUT') {
        const body = await req.json().catch(() => ({}));
        const parts = Array.isArray(body.parts) ? body.parts : [];
        if (!parts.length || parts.length > 500) return json({ error: 'parts array required (max 500)' }, 400, cors);
        const now = nowIso();
        for (const p of parts) {
          const number = str(p.number, 120);
          const norm = normalizePart(number);
          if (!norm) continue;
          const id = ID_RE.test(String(p.id || '')) ? String(p.id) : crypto.randomUUID();
          const clash = await env.DB.prepare('SELECT id FROM parts WHERE norm = ?1 AND id != ?2').bind(norm, id).first();
          if (clash) return json({ error: `"${number}" already exists — use Merge instead`, clashId: clash.id }, 409, cors);
          await env.DB.prepare(
            `INSERT INTO parts (id, number, norm, description, active, uses, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
             ON CONFLICT(id) DO UPDATE SET number = ?2, norm = ?3, description = ?4, active = ?5`
          ).bind(id, number, norm, str(p.description, 200) || null, p.active === false ? 0 : 1, now).run();
        }
        const { results } = await env.DB.prepare('SELECT * FROM parts ORDER BY active DESC, uses DESC, number COLLATE NOCASE').all();
        return json({ ok: true, parts: results.map(rowToPart) }, 200, cors);
      }
      if (path === '/v1/parts/merge' && m === 'POST') {
        const body = await req.json().catch(() => ({}));
        const fromId = str(body.fromId, 64), intoId = str(body.intoId, 64);
        if (!ID_RE.test(fromId) || !ID_RE.test(intoId) || fromId === intoId) return json({ error: 'fromId and intoId required' }, 400, cors);
        const [from, into] = await Promise.all([
          env.DB.prepare('SELECT * FROM parts WHERE id = ?1').bind(fromId).first(),
          env.DB.prepare('SELECT * FROM parts WHERE id = ?1').bind(intoId).first(),
        ]);
        if (!from || !into) return json({ error: 'not found' }, 404, cors);
        await env.DB.batch([
          env.DB.prepare('UPDATE lines SET part_id = ?2 WHERE part_id = ?1').bind(fromId, intoId),
          env.DB.prepare('UPDATE part_aliases SET part_id = ?2 WHERE part_id = ?1').bind(fromId, intoId),
          env.DB.prepare('INSERT OR REPLACE INTO part_aliases (alias_norm, part_id) VALUES (?1, ?2)').bind(from.norm, intoId),
          env.DB.prepare('UPDATE parts SET uses = uses + ?2 WHERE id = ?1').bind(intoId, from.uses || 0),
          env.DB.prepare('DELETE FROM parts WHERE id = ?1').bind(fromId),
        ]);
        return json({ ok: true }, 200, cors);
      }
      const partDel = path.match(/^\/v1\/parts\/([\w-]{8,64})$/);
      if (partDel && m === 'DELETE') {
        await env.DB.prepare('UPDATE parts SET active = 0 WHERE id = ?1').bind(partDel[1]).run();
        return json({ ok: true }, 200, cors);
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
      return json({ error: 'server error' }, 500, cors);
    }
  },
};

function bytesToB64(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
