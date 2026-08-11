// Boot: database, views, service worker, install prompt, persistent storage.
import { initDB, metaGet } from './db.js';
import { setSoundEnabled, unlockAudio, toast } from './ui.js';
import * as nav from './nav.js';
import homeView from './views/home.js';
import scanView from './views/scan.js';
import itemView from './views/item.js';
import settingsView from './views/settings.js';
import teamView from './views/team.js';
import catalogView from './views/catalog.js';
import insightsView from './views/insights.js';
import { stocktakeView, reviewView } from './views/stocktake.js';
import { initSync } from './sync.js';

const APP_VERSION = '1.5.1';
window.__appVersion = APP_VERSION;
window.__updateReady = false;
window.__installPrompt = null;

async function boot() {
  try {
    await initDB();
  } catch (e) {
    document.body.innerHTML = `<div style="padding:2rem;font-family:system-ui">
      <h2>Storage unavailable</h2>
      <p>Stock Tracker could not open its local database (${e && e.name || 'error'}).
      If you are in a private/incognito tab, open the app normally instead.</p></div>`;
    return;
  }

  setSoundEnabled(await metaGet('soundOn', true));

  nav.register('home', homeView);
  nav.register('scan', scanView);
  nav.register('item', itemView);
  nav.register('stocktake', stocktakeView);
  nav.register('review', reviewView);
  nav.register('settings', settingsView);
  nav.register('team', teamView);
  nav.register('catalog', catalogView);
  nav.register('insights', insightsView);
  await nav.show('home');

  initSync();

  // Keep the push subscription registered (iOS drops them silently).
  import('./push.js').then(m => m.resyncSubscription()).catch(() => {});

  // Photos taken offline upload when we're back on a connection.
  import('./photos.js').then(m => {
    m.retryPendingUploads();
    window.addEventListener('online', () => m.retryPendingUploads());
  }).catch(() => {});

  // Catalog writes made offline (manager phones) retry the same way.
  import('./catalog.js').then(m => {
    m.flushCatalogQueue();
    window.addEventListener('online', () => m.flushCatalogQueue());
  }).catch(() => {});

  // Pull manager decisions + transfer commands on open and apply them locally.
  (async () => {
    const { appRole, applyDecisions, dismissRejected, applyCommands } = await import('./requests.js');
    const role = await appRole();
    if (role === 'solo') return;
    try {
      const { applied, rejected } = await applyDecisions();
      const { transfers } = await applyCommands();
      if (applied.length) toast(`Manager approved: ${applied.join(', ')} — added to your inventory`, { duration: 5000 });
      if (transfers.length) toast(`Stock transfer: ${transfers.join(' · ')}`, { duration: 6000 });
      if (applied.length || transfers.length) homeView.refresh();
      for (const r of rejected) {
        toast(`Request rejected: ${r.name}${r.note ? ' — ' + r.note : ''}`, {
          error: true, actionLabel: 'OK', action: () => dismissRejected(r.id), duration: 8000,
        });
      }
    } catch { /* offline — will retry next open */ }
  })();

  // First user gesture unlocks WebAudio so scan beeps work on iOS.
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  // Ask the browser to protect our data from automatic cleanup.
  try { await navigator.storage?.persist?.(); } catch { /* best-effort */ }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__installPrompt = e;
  });

  registerSW();
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

/* ---- dev helper: seed sample data from the console: __seed() ---- */
window.__seed = async () => {
  const { createItem } = await import('./items.js');
  const { applyStockChange } = await import('./db.js');
  const samples = [
    { name: 'Deck screws 4x40', barcode: '4006381333931', category: 'Fixings', unit: 'box', qty: 12, minQty: 4, location: 'Van shelf A' },
    { name: 'Silicone sealant clear', barcode: '5901234123457', category: 'Sealants', unit: 'tube', qty: 3, minQty: 5, location: 'Van shelf B' },
    { name: 'Cable 2.5mm² T&E', barcode: '4012345678901', category: 'Electrical', unit: 'm', qty: 47.5, minQty: 20, location: 'Shop rack 2' },
    { name: 'PVC elbow 22mm', category: 'Plumbing', unit: 'pcs', qty: 8, minQty: 10, location: 'Bin 14' },
    { name: 'Work gloves L', barcode: '7311271089889', category: 'PPE', unit: 'pair', qty: 6, minQty: 2, location: 'Shop cupboard' },
    { name: 'Masking tape 48mm', category: 'Consumables', unit: 'roll', qty: 0, minQty: 3, location: 'Van shelf A' },
  ];
  const made = [];
  for (const s of samples) made.push(await createItem(s));
  await applyStockChange({ itemId: made[0].id, delta: -2, type: 'out', job: 'Miller kitchen refit' });
  await applyStockChange({ itemId: made[2].id, delta: -12.5, type: 'out', job: 'Unit 7 rewire' });
  await applyStockChange({ itemId: made[1].id, delta: -1, type: 'out', job: 'Miller kitchen refit' });
  const { pushJob } = await import('./txns.js');
  await pushJob('Unit 7 rewire');
  await pushJob('Miller kitchen refit');
  homeView.refresh();
  return `${made.length} sample items created`;
};

window.__resetAll = async () => {
  const { dbClear } = await import('./db.js');
  await dbClear('items', 'txns', 'meta');
  nav.resetTo('home');
  return 'wiped';
};

boot().catch(e => {
  console.error('Boot failed', e);
  toast('App failed to start: ' + (e.message || e), { error: true, duration: 8000 });
});
