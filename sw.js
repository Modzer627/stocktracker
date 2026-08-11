// Offline cache. DEPLOY RITUAL: bump VERSION on every deploy — it is what
// makes phones pick up new files. Add any new file to ASSETS.
const VERSION = 'v1.1.1';
const CACHE = `stocktracker-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/items.js',
  './js/txns.js',
  './js/ui.js',
  './js/nav.js',
  './js/scanner.js',
  './js/stocktake.js',
  './js/export.js',
  './js/backup.js',
  './js/sync.js',
  './js/analytics.js',
  './js/charts.js',
  './js/views/home.js',
  './js/views/scan.js',
  './js/views/item.js',
  './js/views/stocktake.js',
  './js/views/settings.js',
  './js/views/sheets.js',
  './js/views/team.js',
  './js/views/insights.js',
  './vendor/barcode-detector/ponyfill.js',
  './vendor/zxing/zxing_reader.wasm',
  './vendor/sheetjs/xlsx.full.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then(hit =>
      hit ||
      fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
    )
  );
});
