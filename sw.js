const VERSION='v25.8-no-cache';
self.addEventListener('install',event=>{self.skipWaiting()});
self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});
self.addEventListener('fetch',event=>{
  // No respondWith: browser handles the request normally.
  // This SW exists only to support installed-app capability without stale cache risk.
});
