// StockTracker sync + requests + push backend.
//
// Sync:      POST /v1/sync (team)           GET /v1/team (manager)
//            DELETE /v1/team/:techId (manager)
// Requests:  POST /v1/requests (team)       GET /v1/requests/mine?techId= (team)
//            POST /v1/requests/:id/applied  POST /v1/requests/:id/dismiss (team)
//            GET /v1/requests (manager)     POST /v1/requests/:id/decide (manager)
// Push:      POST /v1/push/subscribe (team or manager)   POST /v1/push/test (either)
// Misc:      GET /v1/health
import { sendNotification } from './webpush.js';

const ALLOWED_ORIGINS = [
  'https://modzer627.github.io',
  'http://localhost:8123', // local development
];
const AUTH_HEADER = 'X-Stock-Auth';
const MAX_BODY_BYTES = 1_800_000;

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
        subject: 'mailto:modzer627@gmail.com',
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
      // one bad subscription must not block the rest
      results.push({ endpoint: tail, result: `error:${(e && e.name) || 'unknown'}` });
    }
  }
  return results;
}

async function notifyManagers(env, note) {
  const { results } = await env.DB.prepare("SELECT endpoint, sub FROM push_subs WHERE role = 'manager'").all();
  return pushTo(env, results, note);
}

async function notifyTech(env, techId, note) {
  const { results } = await env.DB.prepare('SELECT endpoint, sub FROM push_subs WHERE tech_id = ?1').bind(techId).all();
  return pushTo(env, results, note);
}

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
    const isTeam = () => codeMatches(auth, env.TEAM_CODE);
    const isManager = () => codeMatches(auth, env.MANAGER_CODE);

    try {
      if (url.pathname === '/v1/health' && req.method === 'GET') {
        return json({ ok: true, time: new Date().toISOString() }, 200, cors);
      }

      /* ---------- sync ---------- */

      if (url.pathname === '/v1/sync' && req.method === 'POST') {
        if (!(await isTeam())) return json({ error: 'unauthorized' }, 401, cors);
        const raw = await req.text();
        if (raw.length > MAX_BODY_BYTES) return json({ error: 'snapshot too large' }, 413, cors);
        let body;
        try { body = JSON.parse(raw); } catch { return json({ error: 'invalid JSON' }, 400, cors); }
        const techId = String(body.techId || '').trim();
        const techName = String(body.techName || '').trim().slice(0, 40);
        if (techId.length < 8 || techId.length > 64 || !techName) {
          return json({ error: 'techId and techName required' }, 400, cors);
        }
        const prev = await env.DB.prepare('SELECT data FROM snapshots WHERE tech_id = ?1').bind(techId).first();
        const now = new Date().toISOString();
        await env.DB.prepare(
          `INSERT INTO snapshots (tech_id, tech_name, updated_at, data) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(tech_id) DO UPDATE SET tech_name = ?2, updated_at = ?3, data = ?4`
        ).bind(techId, techName, now, raw).run();

        // Alert managers about items that CROSSED into low stock since the last
        // snapshot. Items that are new (or vans syncing for the first time)
        // don't alert — that keeps CSV seeding and onboarding quiet.
        let lowAlerts = 0;
        if (prev) {
          try {
            const prevItems = new Map((JSON.parse(prev.data).items || []).map(i => [i.id, i]));
            const isLow = (i) => i.qty <= i.minQty;
            const crossed = (body.items || []).filter(i => {
              const before = prevItems.get(i.id);
              return isLow(i) && before && !isLow(before);
            });
            lowAlerts = crossed.length;
            if (crossed.length) {
              const names = crossed.map(i => i.name);
              const shown = names.slice(0, 3).join(', ');
              ctx.waitUntil(notifyManagers(env, {
                title: `Low stock — ${techName}`,
                body: names.length > 3 ? `${shown} + ${names.length - 3} more` : shown,
                tag: `low-${techId}`,
              }));
            }
          } catch { /* alerting must never break a sync */ }
        }
        return json({ ok: true, serverTime: now, lowAlerts }, 200, cors);
      }

      if (url.pathname === '/v1/team' && req.method === 'GET') {
        if (!(await isManager())) return json({ error: 'unauthorized' }, 401, cors);
        const { results } = await env.DB.prepare(
          'SELECT tech_id, tech_name, updated_at, data FROM snapshots ORDER BY tech_name COLLATE NOCASE'
        ).all();
        const team = results.map(r => {
          let snap;
          try { snap = JSON.parse(r.data); } catch { snap = null; }
          return { techId: r.tech_id, techName: r.tech_name, updatedAt: r.updated_at, snapshot: snap };
        }).filter(t => t.snapshot);
        return json({ ok: true, team, serverTime: new Date().toISOString() }, 200, cors);
      }

      const delTech = url.pathname.match(/^\/v1\/team\/([\w-]{8,64})$/);
      if (delTech && req.method === 'DELETE') {
        if (!(await isManager())) return json({ error: 'unauthorized' }, 401, cors);
        await env.DB.prepare('DELETE FROM snapshots WHERE tech_id = ?1').bind(delTech[1]).run();
        return json({ ok: true }, 200, cors);
      }

      /* ---------- item requests ---------- */

      if (url.pathname === '/v1/requests' && req.method === 'POST') {
        if (!(await isTeam())) return json({ error: 'unauthorized' }, 401, cors);
        const body = await req.json();
        const techId = String(body.techId || '').trim();
        const techName = String(body.techName || '').trim().slice(0, 40);
        const name = String(body.payload?.name || '').trim();
        if (techId.length < 8 || !techName || !name) return json({ error: 'techId, techName and item name required' }, 400, cors);
        const id = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO requests (id, tech_id, tech_name, status, payload, created_at)
           VALUES (?1, ?2, ?3, 'pending', ?4, ?5)`
        ).bind(id, techId, techName, JSON.stringify(body.payload), new Date().toISOString()).run();
        ctx.waitUntil(notifyManagers(env, {
          title: 'Item request',
          body: `${techName} requested: ${name}`,
          tag: `req-${id}`,
        }));
        return json({ ok: true, id }, 200, cors);
      }

      if (url.pathname === '/v1/requests/mine' && req.method === 'GET') {
        if (!(await isTeam())) return json({ error: 'unauthorized' }, 401, cors);
        const techId = url.searchParams.get('techId') || '';
        const { results } = await env.DB.prepare(
          `SELECT * FROM requests
           WHERE (tech_id = ?1 AND status IN ('pending','approved','rejected'))
              OR (status = 'approved' AND target = 'team')
           ORDER BY created_at DESC LIMIT 100`
        ).bind(techId).all();
        return json({ ok: true, requests: results.map(rowToReq) }, 200, cors);
      }

      if (url.pathname === '/v1/requests' && req.method === 'GET') {
        if (!(await isManager())) return json({ error: 'unauthorized' }, 401, cors);
        const { results } = await env.DB.prepare(
          `SELECT * FROM requests
           WHERE status = 'pending'
              OR (decided_at IS NOT NULL AND decided_at > datetime('now', '-14 days'))
           ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 200`
        ).all();
        return json({ ok: true, requests: results.map(rowToReq) }, 200, cors);
      }

      const reqAction = url.pathname.match(/^\/v1\/requests\/([\w-]{8,64})\/(applied|dismiss|decide)$/);
      if (reqAction && req.method === 'POST') {
        const [, id, action] = reqAction;
        const row = await env.DB.prepare('SELECT * FROM requests WHERE id = ?1').bind(id).first();
        if (!row) return json({ error: 'not found' }, 404, cors);

        if (action === 'decide') {
          if (!(await isManager())) return json({ error: 'unauthorized' }, 401, cors);
          if (row.status !== 'pending') return json({ error: 'already decided' }, 409, cors);
          const body = await req.json();
          const approve = !!body.approve;
          const target = body.target === 'team' ? 'team' : 'tech';
          const payload = body.payload ? JSON.stringify(body.payload) : row.payload;
          const note = String(body.note || '').slice(0, 300) || null;
          await env.DB.prepare(
            `UPDATE requests SET status = ?2, target = ?3, payload = ?4, manager_note = ?5, decided_at = ?6 WHERE id = ?1`
          ).bind(id, approve ? 'approved' : 'rejected', approve ? target : null, payload, note, new Date().toISOString()).run();
          const itemName = JSON.parse(payload).name;
          ctx.waitUntil(approve && target === 'team'
            ? notifyAllTechs(env, { title: 'New stock item', body: `Added for everyone: ${itemName}`, tag: `req-${id}` })
            : notifyTech(env, row.tech_id, {
                title: approve ? 'Request approved' : 'Request rejected',
                body: approve ? `${itemName} was added to your van` : `${itemName}${note ? ' — ' + note : ''}`,
                tag: `req-${id}`,
              }));
          return json({ ok: true }, 200, cors);
        }

        // tech-side actions on own requests
        if (!(await isTeam())) return json({ error: 'unauthorized' }, 401, cors);
        const body = await req.json().catch(() => ({}));
        if (String(body.techId || '') !== row.tech_id) return json({ error: 'not your request' }, 403, cors);
        if (action === 'applied' && row.status === 'approved' && row.target === 'tech') {
          await env.DB.prepare("UPDATE requests SET status = 'applied' WHERE id = ?1").bind(id).run();
          return json({ ok: true }, 200, cors);
        }
        if (action === 'dismiss' && row.status === 'rejected') {
          await env.DB.prepare("UPDATE requests SET status = 'closed' WHERE id = ?1").bind(id).run();
          return json({ ok: true }, 200, cors);
        }
        return json({ error: 'invalid state' }, 409, cors);
      }

      /* ---------- commands (manager → tech phones; currently transfers) ---------- */

      if (url.pathname === '/v1/commands' && req.method === 'POST') {
        if (!(await isManager())) return json({ error: 'unauthorized' }, 401, cors);
        const body = await req.json();
        const cmds = Array.isArray(body.commands) ? body.commands : [];
        if (!cmds.length || cmds.length > 10) return json({ error: 'commands array required' }, 400, cors);
        const now = new Date().toISOString();
        const stmts = [];
        for (const c of cmds) {
          const techId = String(c.techId || '').trim();
          const type = String(c.type || '');
          if (techId.length < 8 || !['transfer_out', 'transfer_in'].includes(type) || !c.payload) {
            return json({ error: 'invalid command' }, 400, cors);
          }
          stmts.push(env.DB.prepare(
            `INSERT INTO commands (id, tech_id, type, payload, status, created_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5)`
          ).bind(crypto.randomUUID(), techId, type, JSON.stringify(c.payload), now));
        }
        await env.DB.batch(stmts);
        ctx.waitUntil((async () => {
          for (const c of cmds) {
            const p = c.payload;
            await notifyTech(env, c.techId, {
              title: 'Stock transfer',
              body: c.type === 'transfer_in'
                ? `+${p.qty} ${p.item?.unit || ''} ${p.item?.name || 'item'} from ${p.otherTech}`
                : `−${p.qty} ${p.item?.unit || ''} ${p.item?.name || 'item'} to ${p.otherTech}`,
              tag: `cmd-${p.groupId || 'transfer'}`,
            });
          }
        })());
        return json({ ok: true, created: cmds.length }, 200, cors);
      }

      if (url.pathname === '/v1/commands/mine' && req.method === 'GET') {
        if (!(await isTeam())) return json({ error: 'unauthorized' }, 401, cors);
        const techId = url.searchParams.get('techId') || '';
        const { results } = await env.DB.prepare(
          "SELECT * FROM commands WHERE tech_id = ?1 AND status = 'pending' ORDER BY created_at ASC LIMIT 50"
        ).bind(techId).all();
        return json({
          ok: true,
          commands: results.map(r => ({ id: r.id, type: r.type, payload: JSON.parse(r.payload), createdAt: r.created_at })),
        }, 200, cors);
      }

      const cmdApplied = url.pathname.match(/^\/v1\/commands\/([\w-]{8,64})\/applied$/);
      if (cmdApplied && req.method === 'POST') {
        if (!(await isTeam())) return json({ error: 'unauthorized' }, 401, cors);
        const body = await req.json().catch(() => ({}));
        const row = await env.DB.prepare('SELECT tech_id FROM commands WHERE id = ?1').bind(cmdApplied[1]).first();
        if (!row) return json({ error: 'not found' }, 404, cors);
        if (String(body.techId || '') !== row.tech_id) return json({ error: 'not your command' }, 403, cors);
        await env.DB.prepare("UPDATE commands SET status = 'applied' WHERE id = ?1").bind(cmdApplied[1]).run();
        return json({ ok: true }, 200, cors);
      }

      /* ---------- item photos (stored base64 in D1 — no extra services) ---------- */

      const photoMatch = url.pathname.match(/^\/v1\/photo\/([\w.-]{4,80})$/);
      if (photoMatch) {
        const key = photoMatch[1];
        const manager = await isManager();
        if (!manager && !(await isTeam())) return json({ error: 'unauthorized' }, 401, cors);

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

      /* ---------- push ---------- */

      if (url.pathname === '/v1/push/subscribe' && req.method === 'POST') {
        const manager = await isManager();
        if (!manager && !(await isTeam())) return json({ error: 'unauthorized' }, 401, cors);
        const body = await req.json();
        const endpoint = String(body.sub?.endpoint || '');
        const techId = String(body.techId || '').trim();
        if (!endpoint.startsWith('https://') || techId.length < 8) return json({ error: 'invalid subscription' }, 400, cors);
        await env.DB.prepare(
          `INSERT INTO push_subs (endpoint, tech_id, role, sub, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(endpoint) DO UPDATE SET tech_id = ?2, role = ?3, sub = ?4`
        ).bind(endpoint, techId, manager ? 'manager' : 'tech', JSON.stringify(body.sub), new Date().toISOString()).run();
        return json({ ok: true }, 200, cors);
      }

      if (url.pathname === '/v1/push/test' && req.method === 'POST') {
        if (!(await isManager()) && !(await isTeam())) return json({ error: 'unauthorized' }, 401, cors);
        const body = await req.json();
        const techId = String(body.techId || '').trim();
        if (techId.length < 8) return json({ error: 'techId required' }, 400, cors);
        const results = await notifyTech(env, techId, { title: 'Stock Tracker', body: 'Notifications are working on this device 🎉', tag: 'test' });
        return json({ ok: true, results }, 200, cors);
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
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

function rowToReq(r) {
  let payload;
  try { payload = JSON.parse(r.payload); } catch { payload = {}; }
  return {
    id: r.id, techId: r.tech_id, techName: r.tech_name, status: r.status,
    target: r.target, payload, managerNote: r.manager_note,
    createdAt: r.created_at, decidedAt: r.decided_at,
  };
}

async function notifyAllTechs(env, note) {
  const { results } = await env.DB.prepare('SELECT endpoint, sub FROM push_subs').all();
  await pushTo(env, results, note);
}
