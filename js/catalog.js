// Team parts catalog client. The catalog lives in the Worker's D1 database and
// is the source of truth for what parts exist — deleting an item from a phone
// never touches it. Only managers write to it; everyone on the team can read.
import { metaGet, metaSet } from './db.js';
import { workerUrl, managerConfigured } from './sync.js';

const AUTH_HEADER = 'X-Stock-Auth';

async function anyCode() {
  return (await metaGet('managerCode', '')) || (await metaGet('teamCode', ''));
}

/** True when this phone can reach the catalog (has a team or manager code). */
export async function catalogAvailable() {
  return !!(await anyCode());
}

export async function fetchCatalog() {
  const code = await anyCode();
  if (!code) throw new Error('Set a team or manager code in Settings first');
  const res = await fetch(`${await workerUrl()}/v1/catalog`, { headers: { [AUTH_HEADER]: code } });
  if (res.status === 401) throw new Error('Code rejected');
  if (!res.ok) throw new Error(`Could not load the parts catalog (${res.status})`);
  const data = await res.json();
  await metaSet('catalogCache', { at: Date.now(), items: data.items });
  return { items: data.items, cached: false, at: Date.now() };
}

export async function cachedCatalog() {
  const c = await metaGet('catalogCache', null);
  return c ? { items: c.items, cached: true, at: c.at } : null;
}

function pickFields(i) {
  return {
    id: i.id, name: i.name, barcode: i.barcode, category: i.category,
    unit: i.unit, minQty: i.minQty, cost: i.cost, notes: i.notes, photo: i.photo,
  };
}

/**
 * Manager-only, best-effort: publish item(s) to the shared catalog.
 * Failures are queued in meta and retried on the next app open / reconnect,
 * so working offline never loses a catalog write.
 */
export async function publishItems(items) {
  if (!(await managerConfigured())) return { ok: false, reason: 'not manager' };
  const list = (Array.isArray(items) ? items : [items]).map(pickFields).filter(i => (i.name || '').trim());
  if (!list.length) return { ok: false, reason: 'nothing to publish' };
  try {
    const res = await fetch(`${await workerUrl()}/v1/catalog`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', [AUTH_HEADER]: await metaGet('managerCode', '') },
      body: JSON.stringify({ items: list }),
    });
    if (!res.ok) throw new Error(String(res.status));
    return { ok: true, count: list.length };
  } catch {
    const q = await metaGet('catalogQueue', []);
    await metaSet('catalogQueue', [...q, ...list].slice(-300));
    return { ok: false, reason: 'queued' };
  }
}

/** Retry queued catalog writes (called on app open and when back online). */
export async function flushCatalogQueue() {
  if (!(await managerConfigured())) return;
  const q = await metaGet('catalogQueue', []);
  if (!q.length) return;
  await metaSet('catalogQueue', []);
  await publishItems(q); // re-queues itself if still offline
}

/** Manager-only: retire a part from the catalog (soft delete on the server). */
export async function removeCatalogItem(id) {
  const code = await metaGet('managerCode', '');
  if (!code) throw new Error('Manager code required');
  const res = await fetch(`${await workerUrl()}/v1/catalog/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { [AUTH_HEADER]: code },
  });
  if (!res.ok) throw new Error(`Could not remove from catalog (${res.status})`);
}
