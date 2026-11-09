// Offline support: always try the network first so updates show up right away, and fall back to the
// last copy saved here when there's no connection. Bump VERSION when the file list changes.
const VERSION = 'v4';
const CACHE = `scaled-schedule-${VERSION}`;
const CORE = [
  './', 'index.html', 'style.css', 'favicon.svg', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'js/app.js', 'js/calendar.js', 'js/model.js', 'js/scheduler.js', 'js/store.js', 'js/sample.js',
  'js/io/mspdi.js', 'js/io/xer.js', 'js/io/csv.js', 'js/io/inversion.js', 'js/io/p6.js', 'js/io/xlsx.js', 'js/io/files.js',
  'js/io/layout.js', 'js/io/office.js', 'js/io/pdf.js', 'js/ui/review.js', 'js/io/ocr.js', 'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs', 'js/ui/grid.js', 'js/ui/gantt.js', 'js/ui/panels.js', 'js/ui/iguana.js', 'iguana.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('scaled-schedule-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
