/* OneMonth OS V33 - installable, intentionally no runtime cache */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>{event.waitUntil((async()=>{if('caches' in self){for(const k of await caches.keys())await caches.delete(k)}await self.clients.claim()})())});
