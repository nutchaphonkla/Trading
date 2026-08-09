const CACHE='kage-core-v42-adaptive-shell';
const SHELL=[
  './index.html',
  './manifest.webmanifest',
  './kage-v40-full.css',
  './kage-v41-monochrome.css',
  './kage-v42-adaptive.css',
  './adaptive-ai-v42.js',
  './icon-32.png',
  './icon-64.png',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './assets/kage-app-icon-v42.png',
  './assets/kage-anime-avatar-v41.webp',
  './assets/kage-anime-hero-v41.webp',
  './xauusd.json',
  './news.json',
  './ai-history.json',
  './ai-learning.json',
  './ai-model-governance.json',
  './ai-ml-brain.json'
];

function localCacheKey(request){
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return request;
  url.search='';
  return url.toString();
}

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    for(const key of await caches.keys())if(key!==CACHE)await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  event.respondWith((async()=>{
    try{
      const response=await fetch(event.request,{cache:'no-store'});
      if(response.ok&&new URL(event.request.url).origin===self.location.origin){
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
