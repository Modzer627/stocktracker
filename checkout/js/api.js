// Fetch wrapper for the Parts Checkout Worker.
import { store } from './util.js';

// Production backend. Override for local development with ?api=http://localhost:8787
// (remembered on the device) — see README.
export const DEFAULT_API = 'https://parts-checkout.modzer627.workers.dev';

export function apiBase() {
  const q = new URLSearchParams(location.search).get('api');
  if (q) store.set('apiUrl', q.replace(/\/+$/, ''));
  return (store.get('apiUrl') || DEFAULT_API).replace(/\/+$/, '');
}

export class ApiError extends Error {
  constructor(message, { status = 0, network = false } = {}) {
    super(message); this.status = status; this.network = network;
  }
}

/**
 * api('/v1/…', { method, body, key, editToken, raw })
 * - body: plain object (sent as JSON) or Blob (sent as image/jpeg)
 * - key: team key or manager PIN
 * Throws ApiError; `network: true` means the server was unreachable.
 */
export async function api(path, { method = 'GET', body, key, editToken, raw = false } = {}) {
  const headers = {};
  if (key) headers['X-Checkout-Key'] = key;
  if (editToken) headers['X-Edit-Token'] = editToken;
  let payload;
  if (body instanceof Blob) { headers['Content-Type'] = 'image/jpeg'; payload = body; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(apiBase() + path, { method, headers, body: payload });
  } catch {
    throw new ApiError('No connection to the server', { network: true });
  }
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, { status: res.status });
  return data;
}
