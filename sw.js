const CACHE='onemonth-os-v25-4';
const STATIC=['./manifest.webmanifest','./icon-180.png','./icon-192.png','./icon-512.png'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys()
    .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const u=new URL(e.request.url);
  if(e.request.mode==='navigate'||u.pathname.endsWith('.html')){
    e.respondWith(fetch(e.request,{cache:'no-store'}).catch(()=>caches.match(e.request)));
    return;
  }
  if(u.pathname.endsWith('/xauusd.json')||u.pathname.endsWith('/news.json')){
    e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{
      if(r&&r.ok){const cp=r.clone();caches.open(CACHE).then(c=>c.put(e.request,cp))}
      return r;
    }).catch(()=>caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request).then(r=>{
    if(r&&r.ok){const cp=r.clone();caches.open(CACHE).then(c=>c.put(e.request,cp))}
    return r;
  })));
});
