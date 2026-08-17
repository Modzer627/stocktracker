// Household sync client. Unlike the stocktracker's per-device snapshots, the
// budget is one shared dataset: individual records merge row-by-row with
// last-write-wins on updatedAt, and deletes travel as tombstones. Fully
// optional — without a household code the app is local-only.
import { dbAll, dbGet, dbPut, metaGet, metaSet, uuid } from './db.js';
import { SYNCED_STORES } from './store.js';

// Baked-in production endpoint. Overridable via meta 'workerUrl' for local
// development (Settings → advanced, or metaSet('workerUrl','http://localhost:8787')).
export const DEFAULT_WORKER_URL = 'https://budget-sync.modzer627.workers.dev';

const AUTH_HEADER = 'X-Budget-Auth';
const DEBOUNCE_MS = 8000;
const PUSH_CHUNK = 200;

let debounceTimer = null;
let running = false;

export async function workerUrl() {
  return (await metaGet('workerUrl', DEFAULT_WORKER_URL)).replace(/\/+$/, '');
}

export async function getDeviceId() {
  let id = await metaGet('deviceId', null);
  if (!id) { id = uuid(); await metaSet('deviceId', id); }
  return id;
}

export async function syncConfigured() {
  return !!(await metaGet('householdCode', ''));
}

export async function syncStatus() {
  const [lastSyncAt, lastSyncError, pendingAt, configured] = await Promise.all([
    metaGet('lastSyncAt', null), metaGet('lastSyncError', null), metaGet('syncPendingAt', null), syncConfigured(),
  ]);
  return { configured, lastSyncAt, lastSyncError, pending: !!pendingAt };
}

function emitStatus() {
  window.dispatchEvent(new CustomEvent('sync:status'));
}

/** Views listen for this to re-render after a pull applies partner changes. */
function emitRemoteChange() {
  window.dispatchEvent(new CustomEvent('budget:remote'));
}

export async function markDirty() {
  if (!(await syncConfigured())) return;
  await metaSet('syncPendingAt', Date.now());
  emitStatus();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { syncNow(); }, DEBOUNCE_MS);
}

async function authHeaders() {
  return { 'Content-Type': 'application/json', [AUTH_HEADER]: await metaGet('householdCode', '') };
}

/* ---------------- pull ---------------- */

async function pullOnce() {
  let since = await metaGet('lastPullSeq', 0);
  let applied = 0;
  for (let page = 0; page < 40; page++) {
    const res = await fetch(`${await workerUrl()}/v1/pull?since=${since}`, { headers: await authHeaders() });
    if (res.status === 401) throw new Error('Household code rejected');
    if (!res.ok) throw new Error(`Sync failed (${res.status})`);
    const data = await res.json();
    for (const rec of (data.records || [])) {
      if (!SYNCED_STORES.includes(rec.store)) continue;
      let remote;
      try { remote = typeof rec.data === 'string' ? JSON.parse(rec.data) : rec.data; } catch { continue; }
      if (!remote || remote.id !== rec.id) continue;
      const local = await dbGet(rec.store, rec.id).catch(() => null);
      if (!local || (remote.updatedAt || 0) > (local.updatedAt || 0)) {
        await dbPut(rec.store, remote);
        applied++;
      }
    }
    since = data.latestSeq ?? since;
    await metaSet('lastPullSeq', since);
    if (!data.more) break;
  }
  if (applied) emitRemoteChange();
  return applied;
}

/* ---------------- push ---------------- */

async function collectDirty() {
  const lastPushedAt = await metaGet('lastPushedAt', 0);
  const records = [];
  for (const store of SYNCED_STORES) {
    for (const rec of await dbAll(store)) {
      if ((rec.updatedAt || 0) > lastPushedAt) records.push({ store, id: rec.id, data: rec });
    }
  }
  return { records, lastPushedAt };
}

async function pushOnce() {
  const { records } = await collectDirty();
  if (!records.length) return 0;
  const deviceId = await getDeviceId();
  const personName = await metaGet('personName', '');
  let maxUpdated = 0;
  for (let i = 0; i < records.length; i += PUSH_CHUNK) {
    const chunk = records.slice(i, i + PUSH_CHUNK);
    const res = await fetch(`${await workerUrl()}/v1/push`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ deviceId, personName, records: chunk }),
    });
    if (res.status === 401) throw new Error('Household code rejected');
    if (!res.ok) throw new Error(`Sync failed (${res.status})`);
    for (const r of chunk) maxUpdated = Math.max(maxUpdated, r.data.updatedAt || 0);
  }
  if (maxUpdated) await metaSet('lastPushedAt', maxUpdated);
  return records.length;
}

/* ---------------- combined ---------------- */

export async function syncNow() {
  if (running) return { ok: false, reason: 'busy' };
  if (!(await syncConfigured())) return { ok: false, reason: 'not configured' };
  if (!navigator.onLine) {
    await metaSet('lastSyncError', 'Offline — will retry');
    emitStatus();
    return { ok: false, reason: 'offline' };
  }
  running = true;
  clearTimeout(debounceTimer);
  try {
    await pullOnce();
    await pushOnce();
    await metaSet('lastSyncAt', Date.now());
    await metaSet('lastSyncError', null);
    await metaSet('syncPendingAt', null);
    emitStatus();
    return { ok: true };
  } catch (e) {
    await metaSet('lastSyncError', e.message || 'No connection to sync server — will retry');
    emitStatus();
    return { ok: false, reason: e.message || 'network' };
  } finally {
    running = false;
  }
}

/**
 * Joining a household whose data already lives on the server: reset the pull
 * cursor so the first sync downloads everything from seq 0.
 */
export async function joinHousehold(code) {
  await metaSet('householdCode', String(code || '').trim());
  await metaSet('lastPullSeq', 0);
  await metaSet('lastPushedAt', 0);
  return syncNow();
}

export async function leaveHousehold() {
  await metaSet('householdCode', '');
  await metaSet('lastSyncError', null);
  await metaSet('syncPendingAt', null);
  emitStatus();
}

/* ---------------- lifecycle wiring ---------------- */

export function initSync() {
  window.addEventListener('budget:changed', () => { markDirty(); });
  window.addEventListener('online', () => { syncNow(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncNow();
    else syncIfPending();
  });
  (async () => {
    if (await syncConfigured()) syncNow();
  })();
}

async function syncIfPending() {
  const s = await syncStatus();
  if (s.configured && s.pending) syncNow();
}
