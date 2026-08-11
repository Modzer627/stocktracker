// Push notification client: permission (user gesture required, esp. iOS),
// subscription, registration with the sync server.
import { metaGet, metaSet } from './db.js';
import { workerUrl, getTechId } from './sync.js';

// VAPID public key, base64url — baked in after key generation.
export const VAPID_PUBLIC_KEY = 'BC3s41neFUOW4MJhX40A9QA3siD_P4jBKuUtH-Dv35j1iPWWWYK9hk17yHu8Z8FA3hwlaU6Ve3v7pSvdx3sYAmU';

const AUTH_HEADER = 'X-Stock-Auth';

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

/** Must be called from a tap handler (iOS requirement). */
export async function enableNotifications() {
  if (!pushSupported()) throw new Error('This browser cannot do notifications — on iPhone the app must be installed to the home screen first');
  if (VAPID_PUBLIC_KEY.includes('PLACEHOLDER')) throw new Error('Notifications are not configured on the server yet');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64ToUint8(VAPID_PUBLIC_KEY),
  });
  const code = (await metaGet('managerCode', '')) || (await metaGet('teamCode', ''));
  if (!code) throw new Error('Enter your team (or manager) code first');
  const res = await fetch(`${await workerUrl()}/v1/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [AUTH_HEADER]: code },
    body: JSON.stringify({ techId: await getTechId(), sub: sub.toJSON() }),
  });
  if (!res.ok) throw new Error(`Could not register on the server (${res.status})`);
  await metaSet('pushEnabledAt', Date.now());
  return true;
}

/** iOS silently drops push subscriptions — re-register the current one at launch. */
export async function resyncSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  if (!sub) return;
  const code = (await metaGet('managerCode', '')) || (await metaGet('teamCode', ''));
  if (!code) return;
  await fetch(`${await workerUrl()}/v1/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [AUTH_HEADER]: code },
    body: JSON.stringify({ techId: await getTechId(), sub: sub.toJSON() }),
  }).catch(() => {});
}

export async function sendTestNotification() {
  const code = (await metaGet('managerCode', '')) || (await metaGet('teamCode', ''));
  const res = await fetch(`${await workerUrl()}/v1/push/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [AUTH_HEADER]: code },
    body: JSON.stringify({ techId: await getTechId() }),
  });
  if (!res.ok) throw new Error(`Test failed (${res.status})`);
}
