const CACHE = 'kage-core-v49-persistent-brain-4901';

const SHELL = [
  './',
  './index.html',

  './manifest.webmanifest',

  './kage-v40-full.css',
  './kage-v43-clarity.css',
  './kage-v44-premium.css',
  './kage-v45-overrides.css',
  './kage-v46-realtime-lite.css',

  // V49 PERSISTENT BRAIN + V48 TELEGRAM / SIGNAL
  './kage-persistence-v49.js',
  './kage-signal-engine.js',
  './kage-telegram-client.js',
  './telegram-config.js'
];

self.addEventListener('install', event => {
  self.skipWaiting();

  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache =>
        Promise.allSettled(
          SHELL.map(url =>
            cache.add(url)
          )
        )
      )
  );
});


self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {

      const keys =
        await caches.keys();

      await Promise.all(
        keys
          .filter(key =>
            key !== CACHE
          )
          .map(key =>
            caches.delete(key)
          )
      );

      await self.clients.claim();

    })()
  );
});


self.addEventListener('fetch', event => {

  const request =
    event.request;

  if (
    request.method !== 'GET'
  ) {
    return;
  }

  const url =
    new URL(
      request.url
    );

  // ==========================================
  // API / CLOUDFLARE
  // ห้าม cache
  // ==========================================

  if (
    url.hostname.endsWith(
      '.workers.dev'
    )
  ) {
    event.respondWith(
      fetch(request, {
        cache: 'no-store'
      })
    );

    return;
  }

  // ==========================================
  // HTML
  // NETWORK FIRST
  // เพื่อให้ได้ App ล่าสุด
  // ==========================================

  if (
    request.mode === 'navigate'
  ) {

    event.respondWith(
      (async () => {

        try {

          const response =
            await fetch(
              request,
              {
                cache:
                  'no-store'
              }
            );

          if (
            response &&
            response.ok
          ) {

            const cache =
              await caches.open(
                CACHE
              );

            cache.put(
              './index.html',
              response.clone()
            );
          }

          return response;

        } catch (_) {

          return (
            await caches.match(
              './index.html'
            )
          ) || Response.error();

        }

      })()
    );

    return;
  }

  // ==========================================
  // JS สำคัญของ Signal
  // NETWORK FIRST
  // ==========================================

  if (
    url.pathname.endsWith(
      '/kage-persistence-v49.js'
    ) ||
    url.pathname.endsWith(
      '/kage-signal-engine.js'
    ) ||
    url.pathname.endsWith(
      '/kage-telegram-client.js'
    ) ||
    url.pathname.endsWith(
      '/telegram-config.js'
    )
  ) {

    event.respondWith(
      (async () => {

        try {

          const response =
            await fetch(
              request,
              {
                cache:
                  'no-store'
              }
            );

          if (
            response &&
            response.ok
          ) {

            const cache =
              await caches.open(
                CACHE
              );

            cache.put(
              request,
              response.clone()
            );
          }

          return response;

        } catch (_) {

          return (
            await caches.match(
              request
            )
          ) || Response.error();

        }

      })()
    );

    return;
  }

  // ==========================================
  // STATIC FILES
  // CACHE FIRST + UPDATE
  // ==========================================

  event.respondWith(
    (async () => {

      const cached =
        await caches.match(
          request
        );

      const networkPromise =
        fetch(request)
          .then(async response => {

            if (
              response &&
              response.ok
            ) {

              const cache =
                await caches.open(
                  CACHE
                );

              cache.put(
                request,
                response.clone()
              );
            }

            return response;

          })
          .catch(() =>
            null
          );

      if (cached) {

        event.waitUntil(
          networkPromise
        );

        return cached;
      }

      return (
        await networkPromise
      ) || Response.error();

    })()
  );
});
