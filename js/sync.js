// Team sync client. Tech phones push inventory snapshots to the Worker;
// manager phones pull the whole team. Fully optional — without a team code the
// app behaves exactly as before. Never blocks the UI; failures queue and retry.
import { dbAll, metaGet, metaSet, uuid } from './db.js';

// Baked-in production endpoint (set after the Worker is deployed).
// Overridable via meta 'workerUrl' for local development.
export const DEFAULT_WORKER_URL = 'http://localhost:8787';

const AUTH_HEADER = 'X-Stock-Auth';
const TXN_WINDOW_DAYS = 180;
const DEBOUNCE_MS = 20000;
const MAX_PAYLOAD = 1_700_000;

let debounceTimer = null;
let pushing = false;

export async function workerUrl() {
  return (await metaGet('workerUrl', DEFAULT_WORKER_URL)).replace(/\/+$/, '');
}

export async function getTechId() {
  let id = await metaGet('techId', null);
  if (!id) { id = uuid(); await metaSet('techId', id); }
  return id;
}

export async function syncConfigured() {
  const [code, name] = await Promise.all([metaGet('teamCode', ''), metaGet('techName', '')]);
  return !!(code && name);
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

export async function markDirty() {
  if (!(await syncConfigured())) return;
  await metaSet('syncPendingAt', Date.now());
  emitStatus();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { pushNow(); }, DEBOUNCE_MS);
}

async function buildSnapshot() {
  const [items, txns, techName] = await Promise.all([
    dbAll('items'), dbAll('txns'), metaGet('techName', ''),
  ]);
  const cutoff = Date.now() - TXN_WINDOW_DAYS * 24 * 3600 * 1000;
  let recent = txns.filter(t => t.ts >= cutoff).sort((a, b) => b.ts - a.ts);
  const base = {
    techId: await getTechId(),
    techName,
    appVersion: window.__appVersion,
    updatedAt: new Date().toISOString(),
    items,
  };
  // Trim history if a huge log would blow the row cap.
  for (const days of [TXN_WINDOW_DAYS, 90, 30]) {
    const windowCutoff = Date.now() - days * 24 * 3600 * 1000;
    const windowed = recent.filter(t => t.ts >= windowCutoff);
    const body = JSON.stringify({ ...base, txns: windowed, txnWindowDays: days });
    if (body.length <= MAX_PAYLOAD) return body;
  }
  return JSON.stringify({ ...base, txns: [], txnWindowDays: 0 });
}

export async function pushNow() {
  if (pushing) return { ok: false, reason: 'busy' };
  if (!(await syncConfigured())) return { ok: false, reason: 'not configured' };
  if (!navigator.onLine) { await metaSet('lastSyncError', 'Offline — will retry'); emitStatus(); return { ok: false, reason: 'offline' }; }
  pushing = true;
  clearTimeout(debounceTimer);
  try {
    const body = await buildSnapshot();
    const res = await fetch(`${await workerUrl()}/v1/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [AUTH_HEADER]: await metaGet('teamCode', '') },
      body,
    });
    if (!res.ok) {
      const msg = res.status === 401 ? 'Team code rejected' : `Sync failed (${res.status})`;
      await metaSet('lastSyncError', msg);
      emitStatus();
      return { ok: false, reason: msg };
    }
    await metaSet('lastSyncAt', Date.now());
    await metaSet('lastSyncError', null);
    await metaSet('syncPendingAt', null);
    emitStatus();
    return { ok: true };
  } catch {
    await metaSet('lastSyncError', 'No connection to sync server — will retry');
    emitStatus();
    return { ok: false, reason: 'network' };
  } finally {
    pushing = false;
  }
}

/* ---------------- manager side ---------------- */

export async function managerConfigured() {
  return !!(await metaGet('managerCode', ''));
}

export async function fetchTeam() {
  const code = await metaGet('managerCode', '');
  if (!code) throw new Error('No manager code set');
  const res = await fetch(`${await workerUrl()}/v1/team`, { headers: { [AUTH_HEADER]: code } });
  if (res.status === 401) throw new Error('Manager code rejected');
  if (!res.ok) throw new Error(`Server error (${res.status})`);
  const data = await res.json();
  await metaSet('teamCache', { at: Date.now(), team: data.team });
  return { team: data.team, cached: false, at: Date.now() };
}

export async function cachedTeam() {
  const c = await metaGet('teamCache', null);
  return c ? { team: c.team, cached: true, at: c.at } : null;
}

export async function removeTech(techId) {
  const code = await metaGet('managerCode', '');
  const res = await fetch(`${await workerUrl()}/v1/team/${encodeURIComponent(techId)}`, {
    method: 'DELETE',
    headers: { [AUTH_HEADER]: code },
  });
  if (!res.ok) throw new Error(`Could not remove (${res.status})`);
}

/* ---------------- lifecycle wiring ---------------- */

export function initSync() {
  window.addEventListener('stock:changed', () => { markDirty(); });
  window.addEventListener('online', () => { syncIfPending(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) syncIfPending({ immediate: true });
  });
  // On app open: flush anything pending, or refresh a stale snapshot (>6 h).
  (async () => {
    const s = await syncStatus();
    if (!s.configured) return;
    const stale = !s.lastSyncAt || Date.now() - s.lastSyncAt > 6 * 3600 * 1000;
    if (s.pending || stale) pushNow();
  })();
}

async function syncIfPending({ immediate = false } = {}) {
  const s = await syncStatus();
  if (!s.configured || !s.pending) return;
  if (immediate) pushNow();
  else markDirty();
}
