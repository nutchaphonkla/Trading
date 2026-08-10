const CACHE='kage-core-v45-early-signal-4501-shell';

// Only immutable/static app-shell files are pre-cached.
// Dynamic market/model JSON is deliberately NOT pre-cached at install time.
// It is still cached after a successful network response, so offline fallback remains available
// without pinning an obsolete AI artifact forever.
const SHELL=[
  './index.html',
  './manifest.webmanifest',
  './kage-v40-full.css',
  './kage-v41-monochrome.css',
  './kage-v42-adaptive.css',
  './kage-v43-clarity.css',
  './adaptive-ai-v42.js',
  './icon-32.png',
  './icon-64.png',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './assets/kage-app-icon-v42.png',
  './assets/kage-anime-avatar-v41.webp',
  './assets/kage-anime-hero-v41.webp'
];

const DYNAMIC = new Set([
  '/xauusd.json',
  '/news.json',
  '/feed-health.json',
  '/ai-history.json',
  '/ai-learning.json',
  '/ai-learning-candidate.json',
  '/ai-model-governance.json',
  '/ai-ml-brain.json',
  '/ai-ml-candidate.json',
  '/ai-ml-governance.json',
  '/ai-shadow-journal.json',
  '/ai-outcome-journal.json',
  '/ai-selfplay.json',
  '/ai-thresholds.json',
  '/ai-counterfactual.json',
  '/ai-autopsy.json'
]);

function localCacheKey(request){
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return request;
  url.search='';
  return url.toString();
}

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE)
      .then(cache=>cache.addAll(SHELL))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    for(const key of await caches.keys()){
      if(key!==CACHE)await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;

  event.respondWith((async()=>{
    const url=new URL(event.request.url);
    const sameOrigin=url.origin===self.location.origin;
    const isDynamic=sameOrigin && DYNAMIC.has(url.pathname.endsWith('/') ? url.pathname.slice(0,-1) : url.pathname);

    try{
      // Network-first for everything, and especially strict no-store for data/model artifacts.
      const response=await fetch(event.request,{cache:isDynamic?'no-store':'no-cache'});
      if(response.ok&&sameOrigin){
        const cache=await caches.open(CACHE);
        await cache.put(localCacheKey(event.request),response.clone());
      }
      return response;
    }catch(_){
      const cached=await caches.match(localCacheKey(event.request));
      if(cached)return cached;
      if(event.request.mode==='navigate')return caches.match('./index.html');
      return Response.error();
    }
  })());
});
