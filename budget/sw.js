// Offline cache. DEPLOY RITUAL: bump VERSION on every deploy — it is what
// makes phones pick up new files. Add any new file to ASSETS.
// The big OCR files (core wasm + traineddata, ~10 MB) are deliberately NOT
// precached — a failed addAll would abort the whole install. They are
// runtime-cached the first time OCR runs (or via Settings → Download).
const VERSION = 'v1.0.0';
const CACHE = `budgettracker-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/ui.js',
  './js/nav.js',
  './js/store.js',
  './js/categories.js',
  './js/txns.js',
  './js/recurring.js',
  './js/receipts.js',
  './js/ocr.js',
  './js/seed.js',
  './js/sync.js',
  './js/push.js',
  './js/charts.js',
  './js/importer.js',
  './js/export.js',
  './js/views/home.js',
  './js/views/txns.js',
  './js/views/recurring.js',
  './js/views/goals.js',
  './js/views/settings.js',
  './js/views/sheets.js',
  './vendor/tesseract/tesseract.min.js',
  './vendor/tesseract/worker.min.js',
  '../vendor/sheetjs/xlsx.full.min.js',
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

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch { data = { body: e.data && e.data.text() }; }
  // iOS revokes push permission if a push arrives without a visible notification.
  e.waitUntil(self.registration.showNotification(data.title || 'Household Budget', {
    body: data.body || '',
    tag: data.tag || undefined,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
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
