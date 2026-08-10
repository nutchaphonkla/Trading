const CACHE='kage-core-v46-realtime-lite-4601-shell';

const SHELL=[
  './index.html','./manifest.webmanifest','./kage-v40-full.css','./kage-v41-monochrome.css',
  './kage-v42-adaptive.css','./kage-v43-clarity.css','./adaptive-ai-v42.js',
  './icon-32.png','./icon-64.png','./icon-180.png','./icon-192.png','./icon-512.png',
  './assets/kage-app-icon-v42.png','./assets/kage-anime-avatar-v41.webp','./assets/kage-anime-hero-v41.webp'
];

const DYNAMIC=new Set([
  '/xauusd.json','/news.json','/feed-health.json','/ai-history.json','/ai-learning.json',
  '/ai-learning-candidate.json','/ai-model-governance.json','/ai-ml-brain.json',
  '/ai-ml-candidate.json','/ai-ml-governance.json','/ai-shadow-journal.json',
  '/ai-outcome-journal.json','/ai-selfplay.json','/ai-thresholds.json','/ai-counterfactual.json','/ai-autopsy.json'
]);

function cacheKey(request){
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return request;
  url.search='';
  return url.toString();
}

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    for(const key of await caches.keys())if(key!==CACHE)await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  const sameOrigin=url.origin===self.location.origin;
  if(!sameOrigin)return; // MT5/Cloudflare direct requests bypass SW completely.
  const path=url.pathname.endsWith('/')?url.pathname.slice(0,-1):url.pathname;
  const dynamic=DYNAMIC.has(path);

  event.respondWith((async()=>{
    const key=cacheKey(event.request);
    const cache=await caches.open(CACHE);

    if(dynamic){
      // Data/model artifacts: network-first so decisions never use a silently stale pack.
      try{
        const response=await fetch(event.request,{cache:'no-store'});
        if(response.ok)await cache.put(key,response.clone());
        return response;
      }catch(_){
        const cached=await cache.match(key);
        return cached||Response.error();
      }
    }

    // Static shell: stale-while-revalidate. Instant PWA navigation with one background request.
    const cached=await cache.match(key);
    const refresh=fetch(event.request,{cache:'no-cache'}).then(async response=>{
      if(response.ok)await cache.put(key,response.clone());
      return response;
    }).catch(()=>null);
    if(cached){event.waitUntil(refresh);return cached}
    const response=await refresh;
    if(response)return response;
    if(event.request.mode==='navigate')return cache.match('./index.html');
    return Response.error();
  })());
});
