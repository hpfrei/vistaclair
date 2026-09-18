// Service worker: makes the dashboard installable and keeps the CDN
// libraries (xterm, marked, d3, monaco, fonts) in a local cache so a
// phone launch is not gated on jsDelivr. Same-origin requests — the
// app's own HTML/JS/CSS, /api, SSE — always go to the network untouched,
// so a server deploy is never masked by a stale copy.
const CDN_CACHE = 'vistaclair-cdn-v1';
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith('vistaclair-cdn-') && k !== CDN_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || !CDN_HOSTS.includes(url.hostname)) return;
  event.respondWith(
    caches.open(CDN_CACHE).then(async cache => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok || res.type === 'opaque') cache.put(event.request, res.clone());
      return res;
    })
  );
});
