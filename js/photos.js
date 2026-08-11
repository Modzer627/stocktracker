// Item photos: compressed on-device, cached in IndexedDB, shared via the
// worker's R2 bucket so every phone (and the manager view) sees them.
import { dbGet, dbPut, dbDel, metaGet, metaSet } from './db.js';
import { updateItem } from './items.js';
import { workerUrl } from './sync.js';

const AUTH_HEADER = 'X-Stock-Auth';
const MAX_DIM = 900;
const JPEG_QUALITY = 0.72;

async function authCode() {
  return (await metaGet('managerCode', '')) || (await metaGet('teamCode', ''));
}

/** Item's photo key: shared per product when there's a barcode, per-item otherwise. */
export function photoKeyFor(item) {
  const base = item.barcode ? `bc-${item.barcode}` : `id-${item.id}`;
  return base.replace(/[^\w.-]/g, '_').slice(0, 80);
}

/** Downscale + transcode any camera image to a small JPEG blob. */
export async function compressImage(file) {
  let source;
  try {
    source = await createImageBitmap(file);
  } catch {
    source = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
      img.src = url;
    });
  }
  const w = source.width, h = source.height;
  const scale = Math.min(1, MAX_DIM / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY));
  if (!blob) throw new Error('Could not process that image');
  return blob;
}

const objectUrls = new Map(); // key -> blob URL for this session

/** Blob URL for a photo key: local cache first, then the server (and cache it). */
export async function getPhotoUrl(key) {
  if (!key) return null;
  if (objectUrls.has(key)) return objectUrls.get(key);
  let row = await dbGet('photos', key).catch(() => null);
  if (!row) {
    try {
      const code = await authCode();
      if (!code) return null;
      const res = await fetch(`${await workerUrl()}/v1/photo/${encodeURIComponent(key)}`, {
        headers: { [AUTH_HEADER]: code },
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      row = { key, blob, ts: Date.now() };
      await dbPut('photos', row).catch(() => {});
    } catch { return null; }
  }
  const url = URL.createObjectURL(row.blob);
  objectUrls.set(key, url);
  return url;
}

async function uploadPhoto(key, blob) {
  const code = await authCode();
  if (!code) return false;
  try {
    const res = await fetch(`${await workerUrl()}/v1/photo/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { [AUTH_HEADER]: code, 'Content-Type': 'image/jpeg' },
      body: blob,
    });
    return res.ok;
  } catch { return false; }
}

async function markPending(key, add) {
  const pending = await metaGet('pendingPhotoUploads', []);
  const next = add ? [...new Set([...pending, key])] : pending.filter(k => k !== key);
  await metaSet('pendingPhotoUploads', next);
}

/** Attach a photo to an item: compress, cache locally, upload, save the key. */
export async function setItemPhoto(item, file) {
  const blob = await compressImage(file);
  const key = photoKeyFor(item);
  await dbPut('photos', { key, blob, ts: Date.now() });
  if (objectUrls.has(key)) { URL.revokeObjectURL(objectUrls.get(key)); objectUrls.delete(key); }
  const uploaded = await uploadPhoto(key, blob);
  if (!uploaded) await markPending(key, true);
  if (item.photo !== key) await updateItem(item.id, { photo: key });
  return key;
}

export async function removeItemPhoto(item) {
  const key = item.photo;
  if (!key) return;
  await updateItem(item.id, { photo: '' });
  await dbDel('photos', key).catch(() => {});
  if (objectUrls.has(key)) { URL.revokeObjectURL(objectUrls.get(key)); objectUrls.delete(key); }
  await markPending(key, false);
  const code = await authCode();
  if (code) {
    fetch(`${await workerUrl()}/v1/photo/${encodeURIComponent(key)}`, {
      method: 'DELETE', headers: { [AUTH_HEADER]: code },
    }).catch(() => {});
  }
}

/** Retry uploads that failed offline. Called on boot and when back online. */
export async function retryPendingUploads() {
  const pending = await metaGet('pendingPhotoUploads', []);
  if (!pending.length || !navigator.onLine) return;
  for (const key of pending) {
    const row = await dbGet('photos', key).catch(() => null);
    if (!row) { await markPending(key, false); continue; }
    if (await uploadPhoto(key, row.blob)) await markPending(key, false);
  }
}

/** Fill thumbnails for any [data-photo-key] placeholders inside `root`. */
export function hydrateThumbs(root) {
  root.querySelectorAll('[data-photo-key]').forEach(async (el) => {
    const url = await getPhotoUrl(el.dataset.photoKey);
    if (url && el.isConnected) {
      el.style.backgroundImage = `url("${url}")`;
      el.classList.add('has-img');
    }
  });
}
