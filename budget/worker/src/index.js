// Budget sync backend — Cloudflare Worker + D1.
//
// Sync:    POST /v1/push (records upsert, LWW)   GET /v1/pull?since=N
// Photos:  GET/PUT/DELETE /v1/photo/:key (base64 in D1)
// Push:    POST /v1/push/subscribe   GET /v1/push/vapid   POST /v1/push/test
// Cron:    daily bill-due reminders (see scheduled())
// Misc:    GET /v1/health
//
// Auth: single shared household code in the X-Budget-Auth header, checked
// against the HOUSEHOLD_CODE secret. A workflow gate, not a security boundary
// — same model as the stocktracker worker.
import { sendNotification } from './webpush.js';

const ALLOWED_ORIGINS = [
  'https://modzer627.github.io',
  'http://localhost:8123', // local development
];
const AUTH_HEADER = 'X-Budget-Auth';
const MAX_BODY_BYTES = 1_800_000;
const SYNCED_STORES = ['txns', 'categories', 'recurring', 'shared'];
const PUSH_SUBJECT = 'mailto:modzer627@gmail.com';

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

async function codeMatches(given, expected) {
  if (!given || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/* ---------------- push helpers ---------------- */

async function pushTo(env, rows, note) {
  const results = [];
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return results;
  const payload = JSON.stringify(note);
  for (const row of rows) {
    const tail = row.endpoint.slice(-12);
    try {
      const sub = JSON.parse(row.sub);
      const res = await sendNotification(sub, payload, {
        subject: PUSH_SUBJECT,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
      });
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?1').bind(row.endpoint).run();
        results.push({ endpoint: tail, result: 'dead-removed' });
      } else {
        results.push({ endpoint: tail, result: `sent:${res.status}` });
      }
    } catch (e) {
      results.push({ endpoint: tail, result: `error:${(e && e.name) || 'unknown'}` });
    }
  }
  return results;
}

async function notifyOthers(env, exceptDeviceId, note) {
  const { results } = await env.DB.prepare('SELECT endpoint, sub FROM push_subs WHERE device_id != ?1')
    .bind(exceptDeviceId || '-').all();
  return pushTo(env, results, note);
}

async function notifyAll(env, note) {
  const { results } = await env.DB.prepare('SELECT endpoint, sub FROM push_subs').all();
  return pushTo(env, results, note);
}

/* -------- recurring date math (mirror of budget/js/recurring.js) -------- */

function occurrenceDate(def, i) {
  const [y, m, d] = String(def.anchorDate).split('-').map(Number);
  const { unit, interval } = def.freq || { unit: 'month', interval: 1 };
  const p = (x) => String(x).padStart(2, '0');
  if (unit === 'week') {
    const base = new Date(Date.UTC(y, m - 1, d));
    base.setUTCDate(base.getUTCDate() + i * 7 * interval);
    return `${base.getUTCFullYear()}-${p(base.getUTCMonth() + 1)}-${p(base.getUTCDate())}`;
  }
  const monthsAdded = unit === 'year' ? i * 12 * interval : i * interval;
  const total = (m - 1) + monthsAdded;
  const yy = y + Math.floor(total / 12);
  const mm = (total % 12) + 1;
  const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return `${yy}-${p(mm)}-${p(Math.min(d, dim))}`;
}

function occursOn(def, date) {
  for (let i = 0; i < 2000; i++) {
    const d = occurrenceDate(def, i);
    if (d === date) return true;
    if (d > date) return false;
  }
  return false;
}

const money = (cents) => '$' + (cents / 100).toFixed(2);

/* ---------------- request handler ---------------- */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': req.headers.get('Access-Control-Request-Headers') || `${AUTH_HEADER},Content-Type`,
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const auth = req.headers.get(AUTH_HEADER);
    const isHousehold = () => codeMatches(auth, env.HOUSEHOLD_CODE);

    try {
      if (url.pathname === '/v1/health' && req.method === 'GET') {
        return json({ ok: true, time: new Date().toISOString() }, 200, cors);
      }

      /* ---------- record sync ---------- */

      if (url.pathname === '/v1/push' && req.method === 'POST') {
        if (!(await isHousehold())) return json({ error: 'unauthorized' }, 401, cors);
        const raw = await req.text();
        if (raw.length > MAX_BODY_BYTES) return json({ error: 'payload too large' }, 413, cors);
        let body;
        try { body = JSON.parse(raw); } catch { return json({ error: 'invalid JSON' }, 400, cors); }
        const deviceId = String(body.deviceId || '').trim();
        const personName = String(body.personName || '').trim().slice(0, 40);
        const records = Array.isArray(body.records) ? body.records : [];
        if (deviceId.length < 8 || records.length > 500) return json({ error: 'deviceId required, max 500 records' }, 400, cors);

        const valid = records.filter(r =>
          SYNCED_STORES.includes(r.store) &&
          typeof r.id === 'string' && r.id.length >= 1 && r.id.length <= 120 &&
          r.data && r.data.id === r.id && Number.isFinite(r.data.updatedAt));
        if (!valid.length) return json({ ok: true, saved: 0 }, 200, cors);

        // Atomically reserve a block of sequence numbers for this batch.
        const counter = await env.DB.prepare(
          'UPDATE counters SET value = value + ?1 WHERE name = ?2 RETURNING value'
        ).bind(valid.length, 'seq').first();
        let seq = counter.value - valid.length;

        // Which incoming txns are brand-new? (for the partner-activity ping)
        const txnIds = valid.filter(r => r.store === 'txns').map(r => r.id);
        const existing = new Set();
        for (let i = 0; i < txnIds.length; i += 50) {
          const chunk = txnIds.slice(i, i + 50);
          const q = await env.DB.prepare(
            `SELECT id FROM records WHERE store = 'txns' AND id IN (${chunk.map(() => '?').join(',')})`
          ).bind(...chunk).all();
          for (const row of q.results) existing.add(row.id);
        }

        const stmts = valid.map(r => {
          seq++;
          return env.DB.prepare(
            `INSERT INTO records (store, id, data, updated_at, seq) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(store, id) DO UPDATE SET data = ?3, updated_at = ?4, seq = ?5
             WHERE excluded.updated_at >= records.updated_at`
          ).bind(r.store, r.id, JSON.stringify(r.data), r.data.updatedAt, seq);
        });
        await env.DB.batch(stmts);

        // Partner activity: fresh, human-entered expenses ping the other phone.
        const fresh = valid.filter(r =>
          r.store === 'txns' && !existing.has(r.id) && !r.data.deleted &&
          r.data.source !== 'recurring' && r.data.amountCents > 0);
        if (fresh.length) {
          const who = personName || 'Your partner';
          const total = fresh.reduce((s, r) => s + r.data.amountCents, 0);
          const first = fresh[0].data;
          ctx.waitUntil(notifyOthers(env, deviceId, {
            title: 'Budget update',
            body: fresh.length === 1
              ? `${who} added ${money(first.amountCents)}${first.merchant ? ' — ' + first.merchant : ''}`
              : `${who} added ${fresh.length} expenses (${money(total)})`,
            tag: `activity-${deviceId}`,
          }));
        }

        return json({ ok: true, saved: valid.length, latestSeq: counter.value }, 200, cors);
      }

      if (url.pathname === '/v1/pull' && req.method === 'GET') {
        if (!(await isHousehold())) return json({ error: 'unauthorized' }, 401, cors);
        const since = Number(url.searchParams.get('since')) || 0;
        const { results } = await env.DB.prepare(
          'SELECT store, id, data, seq FROM records WHERE seq > ?1 ORDER BY seq ASC LIMIT 500'
        ).bind(since).all();
        const latest = results.length ? results[results.length - 1].seq : since;
        const counter = await env.DB.prepare("SELECT value FROM counters WHERE name = 'seq'").first();
        return json({
          ok: true,
          records: results.map(r => ({ store: r.store, id: r.id, data: r.data, seq: r.seq })),
          latestSeq: latest,
          more: (counter?.value || 0) > latest && results.length === 500,
        }, 200, cors);
      }

      /* ---------- receipt photos (base64 in D1) ---------- */

      const photoMatch = url.pathname.match(/^\/v1\/photo\/([\w.-]{4,120})$/);
      if (photoMatch) {
        const key = photoMatch[1];
        if (!(await isHousehold())) return json({ error: 'unauthorized' }, 401, cors);

        if (req.method === 'GET') {
          const row = await env.DB.prepare('SELECT data FROM photos WHERE key = ?1').bind(key).first();
          if (!row) return json({ error: 'not found' }, 404, cors);
          return new Response(b64ToBytes(row.data), {
            status: 200,
            headers: { ...cors, 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
          });
        }
        if (req.method === 'PUT') {
          const buf = await req.arrayBuffer();
          if (buf.byteLength < 100) return json({ error: 'empty image' }, 400, cors);
          if (buf.byteLength > 500_000) return json({ error: 'photo too large' }, 413, cors);
          await env.DB.prepare(
            `INSERT INTO photos (key, data, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET data = ?2, updated_at = ?3`
          ).bind(key, bytesToB64(buf), new Date().toISOString()).run();
          return json({ ok: true, bytes: buf.byteLength }, 200, cors);
        }
        if (req.method === 'DELETE') {
          await env.DB.prepare('DELETE FROM photos WHERE key = ?1').bind(key).run();
          return json({ ok: true }, 200, cors);
        }
      }

      /* ---------- web push ---------- */

      if (url.pathname === '/v1/push/vapid' && req.method === 'GET') {
        if (!(await isHousehold())) return json({ error: 'unauthorized' }, 401, cors);
        if (!env.VAPID_PUBLIC_KEY) return json({ error: 'push not configured' }, 503, cors);
        return json({ ok: true, key: env.VAPID_PUBLIC_KEY }, 200, cors);
      }

      if (url.pathname === '/v1/push/subscribe' && req.method === 'POST') {
        if (!(await isHousehold())) return json({ error: 'unauthorized' }, 401, cors);
        const body = await req.json();
        const endpoint = String(body.sub?.endpoint || '');
        const deviceId = String(body.deviceId || '').trim();
        if (!endpoint.startsWith('https://') || deviceId.length < 8) return json({ error: 'invalid subscription' }, 400, cors);
        await env.DB.prepare(
          `INSERT INTO push_subs (endpoint, device_id, sub, created_at) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(endpoint) DO UPDATE SET device_id = ?2, sub = ?3`
        ).bind(endpoint, deviceId, JSON.stringify(body.sub), new Date().toISOString()).run();
        return json({ ok: true }, 200, cors);
      }

      if (url.pathname === '/v1/push/test' && req.method === 'POST') {
        if (!(await isHousehold())) return json({ error: 'unauthorized' }, 401, cors);
        const body = await req.json();
        const deviceId = String(body.deviceId || '').trim();
        const { results } = await env.DB.prepare('SELECT endpoint, sub FROM push_subs WHERE device_id = ?1')
          .bind(deviceId).all();
        const out = await pushTo(env, results, { title: 'Household Budget', body: 'Notifications are working on this device 🎉', tag: 'test' });
        return json({ ok: true, results: out }, 200, cors);
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: 'server error' }, 500, cors);
    }
  },

  /* ---------- daily cron: bill-due reminders ---------- */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDueReminders(env));
  },
};

async function sendDueReminders(env) {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return;
  const { results } = await env.DB.prepare("SELECT data FROM records WHERE store = 'recurring'").all();
  const p = (x) => String(x).padStart(2, '0');
  const day = (offset) => {
    const d = new Date(Date.now() + offset * 24 * 3600 * 1000);
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  };
  const today = day(0), tomorrow = day(1);
  const dueLines = [];
  for (const row of results) {
    let def;
    try { def = JSON.parse(row.data); } catch { continue; }
    if (!def || def.deleted || !def.active || !def.anchorDate) continue;
    const when = occursOn(def, today) ? 'today' : (occursOn(def, tomorrow) ? 'tomorrow' : null);
    if (!when) continue;
    // Remind-mode bills need a human; autoposts are informational only.
    if (def.mode === 'remind') dueLines.push(`${def.name} (${money(def.amountCents)}) due ${when}`);
  }
  if (!dueLines.length) return;
  await notifyAll(env, {
    title: dueLines.length === 1 ? 'Bill due' : `${dueLines.length} bills due`,
    body: dueLines.slice(0, 4).join(' · ') + (dueLines.length > 4 ? ` +${dueLines.length - 4} more` : ''),
    tag: 'bills-due',
  });
}

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
