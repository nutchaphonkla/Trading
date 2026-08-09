const CACHE = 'kage-core-v40-1-shell';
const SHELL = [
  './',
  './index.html',
  './kage-v40.css?v=401',
  './kage-v40.js?v=401',
  './assets/kage-hero-v40.webp',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

const RUNTIME_JSON = [
  '/xauusd.json',
  '/news.json',
  '/ai-ml-brain.json',
  '/ai-learning.json',
  '/ai-model-governance.json',
  '/ai-outcome-journal.json'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (RUNTIME_JSON.some(path => url.pathname.endsWith(path))) {
    const cacheKey = new Request(`${url.origin}${url.pathname}`);
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request, { cache: 'no-store' });
        if (response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(cacheKey, response.clone());
        }
        return response;
      } catch (_) {
        return (await caches.match(cacheKey)) || Response.error();
      }
    })());
    return;
  }
  event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  })));
});
