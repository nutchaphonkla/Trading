const CACHE='onemonth-os-v25-2-stable-ai';
const SHELL=['./manifest.webmanifest','./icon-180.png','./icon-192.png','./icon-512.png'];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);

  // Critical: always try newest HTML first so an old broken boot screen cannot be pinned by SW.
  if(event.request.mode==='navigate'||url.pathname.endsWith('/index.html')){
    event.respondWith(
      fetch(event.request,{cache:'no-store'})
        .then(res=>{
          if(res&&res.ok){
            const copy=res.clone();
            caches.open(CACHE).then(c=>c.put('./index.html',copy));
          }
          return res;
        })
        .catch(()=>caches.match('./index.html').then(r=>r||caches.match('./')))
    );
    return;
  }

  if(url.pathname.endsWith('/xauusd.json')||url.pathname.endsWith('/news.json')){
    event.respondWith(
      fetch(event.request,{cache:'no-store'})
        .then(res=>{
          if(res&&res.ok){
            const copy=res.clone();caches.open(CACHE).then(c=>c.put(event.request,copy));
          }
          return res;
        })
        .catch(()=>caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached=>cached||fetch(event.request).then(res=>{
      if(res&&res.ok){
        const copy=res.clone();caches.open(CACHE).then(c=>c.put(event.request,copy));
      }
      return res;
    }))
  );
});
