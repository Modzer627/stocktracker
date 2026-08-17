// Boot: database, seed, views, recurring catch-up, sync, service worker.
import { initDB } from './db.js';
import { toast } from './ui.js';
import * as nav from './nav.js';
import { seedIfNeeded } from './seed.js';
import homeView from './views/home.js';
import txnsView from './views/txns.js';
import recurringView from './views/recurring.js';
import goalsView from './views/goals.js';
import settingsView from './views/settings.js';
import { initSync } from './sync.js';
import { postDueRecurring } from './recurring.js';

const APP_VERSION = '1.0.0';
window.__appVersion = APP_VERSION;
window.__updateReady = false;

async function boot() {
  try {
    await initDB();
  } catch (e) {
    document.body.innerHTML = `<div style="padding:2rem;font-family:system-ui">
      <h2>Storage unavailable</h2>
      <p>Household Budget could not open its local database (${e && e.name || 'error'}).
      If you are in a private/incognito tab, open the app normally instead.</p></div>`;
    return;
  }

  await seedIfNeeded();

  nav.register('home', homeView);
  nav.register('txns', txnsView);
  nav.register('recurring', recurringView);
  nav.register('goals', goalsView);
  nav.register('settings', settingsView);
  await nav.show('home');

  // Recurring bills catch up on open and whenever the app comes back to front.
  postDueRecurring().then(n => { if (n) refreshCurrent(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) postDueRecurring().then(n => { if (n) refreshCurrent(); });
  });

  initSync();
  // Partner changes arrived via sync — repaint whatever screen is open.
  window.addEventListener('budget:remote', refreshCurrent);

  // Keep the push subscription registered (iOS drops them silently).
  import('./push.js').then(m => m.resyncSubscription()).catch(() => {});

  // Receipt photos taken offline upload when we're back on a connection.
  import('./receipts.js').then(m => {
    m.retryPendingUploads();
    window.addEventListener('online', () => m.retryPendingUploads());
  }).catch(() => {});

  // Ask the browser to protect our data from automatic cleanup.
  try { await navigator.storage?.persist?.(); } catch { /* best-effort */ }

  registerSW();
}

function refreshCurrent() {
  const views = { home: homeView, txns: txnsView, recurring: recurringView, goals: goalsView, settings: settingsView };
  const v = views[nav.currentScreen()];
  if (v && v.refresh) v.refresh();
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // Skip SW on plain localhost dev so edits show up without cache-version bumps.
  const params = new URLSearchParams(location.search);
  if (params.get('nosw') === '1') return;

  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          window.__updateReady = true;
          if (nav.currentScreen() === 'home') homeView.refresh();
        }
      });
    });
    window.__applyUpdate = () => {
      const waiting = reg.waiting;
      if (waiting) waiting.postMessage('skipWaiting');
      else location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
  }).catch(() => { /* offline-first is a bonus; the app still runs */ });
}

/* ---- dev helper: sample data from the console: __seedDemo() ---- */
window.__seedDemo = async () => {
  const { saveTxn } = await import('./txns.js');
  const { isoDate } = await import('./ui.js');
  const day = (off) => isoDate(Date.now() - off * 24 * 3600 * 1000);
  const samples = [
    { amountCents: 5423, categoryId: 'cat-food', merchant: 'Kroger', date: day(1) },
    { amountCents: 3812, categoryId: 'cat-gas', merchant: 'Shell', date: day(2) },
    { amountCents: 1299, categoryId: 'cat-subs', merchant: 'Netflix', date: day(3) },
    { amountCents: 8250, categoryId: 'cat-food', merchant: 'Hello Fresh', date: day(5) },
    { amountCents: 4500, categoryId: 'cat-farrier', merchant: 'Farrier visit', date: day(6) },
  ];
  for (const s of samples) await saveTxn(s);
  return `${samples.length} sample expenses created`;
};

window.__resetAll = async () => {
  const { resetAll } = await import('./seed.js');
  await resetAll();
  nav.resetTo('home');
  return 'wiped & reseeded';
};

boot().catch(e => {
  console.error('Boot failed', e);
  toast('App failed to start: ' + (e.message || e), { error: true, duration: 8000 });
});
