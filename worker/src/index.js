// StockTracker sync backend.
// POST /v1/sync    (team code)    — a tech phone upserts its inventory snapshot
// GET  /v1/team    (manager code) — all tech snapshots
// DELETE /v1/team/:techId (manager code) — remove a tech's snapshot
// GET  /v1/health  (no auth)

const ALLOWED_ORIGINS = [
  'https://modzer627.github.io',
  'http://localhost:8123', // local development
];
const AUTH_HEADER = 'X-Stock-Auth';
const MAX_BODY_BYTES = 1_800_000; // D1 row cap is 2 MB; leave headroom

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Vary': 'Origin',
  };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// Constant-time comparison via SHA-256 digests (inputs differ in length).
async function codeMatches(given, expected) {
  if (!given || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': req.headers.get('Access-Control-Request-Headers') || `${AUTH_HEADER},Content-Type`,
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const auth = req.headers.get(AUTH_HEADER);

    try {
      if (url.pathname === '/v1/health' && req.method === 'GET') {
        return json({ ok: true, time: new Date().toISOString() }, 200, cors);
      }

      if (url.pathname === '/v1/sync' && req.method === 'POST') {
        if (!(await codeMatches(auth, env.TEAM_CODE))) return json({ error: 'unauthorized' }, 401, cors);
        const raw = await req.text();
        if (raw.length > MAX_BODY_BYTES) return json({ error: 'snapshot too large' }, 413, cors);
        let body;
        try { body = JSON.parse(raw); } catch { return json({ error: 'invalid JSON' }, 400, cors); }
        const techId = String(body.techId || '').trim();
        const techName = String(body.techName || '').trim().slice(0, 40);
        if (techId.length < 8 || techId.length > 64 || !techName) {
          return json({ error: 'techId and techName required' }, 400, cors);
        }
        const now = new Date().toISOString();
        // JSON goes in as a bound parameter — never inlined into SQL text.
        await env.DB.prepare(
          `INSERT INTO snapshots (tech_id, tech_name, updated_at, data) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(tech_id) DO UPDATE SET tech_name = ?2, updated_at = ?3, data = ?4`
        ).bind(techId, techName, now, raw).run();
        return json({ ok: true, serverTime: now }, 200, cors);
      }

      if (url.pathname === '/v1/team' && req.method === 'GET') {
        if (!(await codeMatches(auth, env.MANAGER_CODE))) return json({ error: 'unauthorized' }, 401, cors);
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

      const delMatch = url.pathname.match(/^\/v1\/team\/([\w-]{8,64})$/);
      if (delMatch && req.method === 'DELETE') {
        if (!(await codeMatches(auth, env.MANAGER_CODE))) return json({ error: 'unauthorized' }, 401, cors);
        await env.DB.prepare('DELETE FROM snapshots WHERE tech_id = ?1').bind(delMatch[1]).run();
        return json({ ok: true }, 200, cors);
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: 'server error' }, 500, cors);
    }
  },
};
