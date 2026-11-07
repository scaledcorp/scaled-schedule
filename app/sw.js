// Offline support: always try the network first so updates show up right away, and fall back to the
// last copy saved here when there's no connection. Bump VERSION when the file list changes.
const VERSION = 'v3';
const CACHE = `scaled-schedule-${VERSION}`;
const CORE = [
  './', 'index.html', 'style.css', 'favicon.svg', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'js/app.js', 'js/calendar.js', 'js/model.js', 'js/scheduler.js', 'js/store.js', 'js/sample.js',
  'js/io/mspdi.js', 'js/io/xer.js', 'js/io/csv.js', 'js/io/inversion.js', 'js/ui/grid.js', 'js/ui/gantt.js', 'js/ui/panels.js', 'js/ui/iguana.js', 'iguana.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('scaled-schedule-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Cross-origin isolation lets Schedule Iguana's AI use every processor core. GitHub Pages can't send
// these headers, so the service worker adds them. "credentialless" still allows fonts and model downloads.
function isolate(res) {
  if (!res || res.type === 'opaque' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return isolate(res);
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(isolate)));
});
