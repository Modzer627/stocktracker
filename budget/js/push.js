// Push notification client. The VAPID public key is served by the worker
// (GET /v1/push/vapid) rather than baked in, so deploying new keys never
// requires an app update.
import { metaGet, metaSet } from './db.js';
import { workerUrl, getDeviceId } from './sync.js';

const AUTH_HEADER = 'X-Budget-Auth';

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

function b64ToUint8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function authHeaders() {
  return { 'Content-Type': 'application/json', [AUTH_HEADER]: await metaGet('householdCode', '') };
}

async function fetchVapidKey() {
  const cached = await metaGet('vapidPublicKey', null);
  if (cached) return cached;
  const res = await fetch(`${await workerUrl()}/v1/push/vapid`, { headers: await authHeaders() });
  if (!res.ok) throw new Error(res.status === 503 ? 'Notifications are not configured on the server yet' : `Server error (${res.status})`);
  const { key } = await res.json();
  await metaSet('vapidPublicKey', key);
  return key;
}

async function registerSub(sub) {
  const res = await fetch(`${await workerUrl()}/v1/push/subscribe`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ deviceId: await getDeviceId(), sub: sub.toJSON() }),
  });
  if (!res.ok) throw new Error(`Could not register on the server (${res.status})`);
}

/** Must be called from a tap handler (iOS requirement). */
export async function enableNotifications() {
  if (!pushSupported()) throw new Error('This browser cannot do notifications — on iPhone the app must be installed to the home screen first');
  if (!(await metaGet('householdCode', ''))) throw new Error('Enter your household code first');
  const key = await fetchVapidKey();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64ToUint8(key),
  });
  await registerSub(sub);
  await metaSet('pushEnabledAt', Date.now());
  return true;
}

/** iOS silently drops push subscriptions — re-register the current one at launch. */
export async function resyncSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  if (!(await metaGet('householdCode', ''))) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  if (!sub) return;
  await registerSub(sub).catch(() => {});
}

export async function sendTestNotification() {
  const res = await fetch(`${await workerUrl()}/v1/push/test`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ deviceId: await getDeviceId() }),
  });
  if (!res.ok) throw new Error(`Test failed (${res.status})`);
}
