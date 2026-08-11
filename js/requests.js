// Item-add requests: techs propose items, managers decide, approved items are
// created locally by the tech's own phone next time it checks in.
import { metaGet, metaSet } from './db.js';
import { createItem, getByBarcode, allItems } from './items.js';
import { workerUrl, getTechId, managerConfigured, syncConfigured } from './sync.js';

const AUTH_HEADER = 'X-Stock-Auth';

async function teamHeaders() {
  return { 'Content-Type': 'application/json', [AUTH_HEADER]: await metaGet('teamCode', '') };
}
async function managerHeaders() {
  return { 'Content-Type': 'application/json', [AUTH_HEADER]: await metaGet('managerCode', '') };
}

/** 'manager' → full item control · 'tech' → request-only · 'solo' → no team at all, full control */
export async function appRole() {
  if (await managerConfigured()) return 'manager';
  if (await syncConfigured()) return 'tech';
  return 'solo';
}

export async function submitRequest(payload) {
  const res = await fetch(`${await workerUrl()}/v1/requests`, {
    method: 'POST',
    headers: await teamHeaders(),
    body: JSON.stringify({
      techId: await getTechId(),
      techName: await metaGet('techName', ''),
      payload,
    }),
  });
  if (res.status === 401) throw new Error('Team code rejected');
  if (!res.ok) throw new Error('Could not send the request — try again when online');
  return (await res.json()).id;
}

export async function myRequests() {
  const res = await fetch(`${await workerUrl()}/v1/requests/mine?techId=${encodeURIComponent(await getTechId())}`, {
    headers: await teamHeaders(),
  });
  if (!res.ok) throw new Error(`Could not load requests (${res.status})`);
  return (await res.json()).requests;
}

/**
 * Pull decided requests and act on them:
 * - approved for THIS van → create the item locally, mark applied on the server
 * - approved for the TEAM → create locally once (deduped by barcode/name)
 * - rejected → returned so the UI can tell the tech (dismissed on tap)
 */
export async function applyDecisions() {
  const techId = await getTechId();
  const rows = await myRequests();
  const applied = [];
  const rejected = [];
  const seenTeam = await metaGet('appliedTeamRequests', []);

  for (const r of rows) {
    if (r.status === 'approved' && r.target === 'tech' && r.techId === techId) {
      const created = await createLocally(r.payload);
      if (created) applied.push(r.payload.name);
      await fetch(`${await workerUrl()}/v1/requests/${r.id}/applied`, {
        method: 'POST', headers: await teamHeaders(), body: JSON.stringify({ techId }),
      }).catch(() => {});
    } else if (r.status === 'approved' && r.target === 'team' && !seenTeam.includes(r.id)) {
      const created = await createLocally(r.payload);
      if (created) applied.push(r.payload.name);
      seenTeam.push(r.id);
    } else if (r.status === 'rejected' && r.techId === techId) {
      rejected.push({ id: r.id, name: r.payload.name, note: r.managerNote });
    }
  }
  await metaSet('appliedTeamRequests', seenTeam.slice(-200));
  return { applied, rejected };
}

async function createLocally(payload) {
  try {
    if (payload.barcode && await getByBarcode(payload.barcode)) return false; // already have it
    const items = await allItems();
    if (!payload.barcode && items.some(i =>
      i.name.trim().toLowerCase() === String(payload.name).trim().toLowerCase() && i.unit === (payload.unit || 'pcs'))) return false;
    await createItem(payload);
    return true;
  } catch { return false; }
}

export async function dismissRejected(id) {
  await fetch(`${await workerUrl()}/v1/requests/${id}/dismiss`, {
    method: 'POST', headers: await teamHeaders(), body: JSON.stringify({ techId: await getTechId() }),
  }).catch(() => {});
}

/* ---------------- manager side ---------------- */

export async function allRequests() {
  const res = await fetch(`${await workerUrl()}/v1/requests`, { headers: await managerHeaders() });
  if (res.status === 401) throw new Error('Manager code rejected');
  if (!res.ok) throw new Error(`Could not load requests (${res.status})`);
  return (await res.json()).requests;
}

export async function decideRequest(id, { approve, payload, target = 'tech', note = '' }) {
  const res = await fetch(`${await workerUrl()}/v1/requests/${id}/decide`, {
    method: 'POST',
    headers: await managerHeaders(),
    body: JSON.stringify({ approve, payload, target, note }),
  });
  if (res.status === 409) throw new Error('Already decided on another device');
  if (!res.ok) throw new Error(`Could not save decision (${res.status})`);
}
