// Service worker for OCR & PDF to Text
// Strategy:
//  - App shell (this HTML page, manifest, icons): cache-first, falls back to network.
//  - Everything else (CDN scripts, Tesseract language data, pdf.js worker): 
//    runtime cache-first. First use requires internet to download the OCR
//    engine + chosen language model (~2-15MB depending on language); every
//    use after that works fully offline, including on airplane mode.

const SHELL_CACHE = 'ocr-tool-shell-v4';
const RUNTIME_CACHE = 'ocr-tool-runtime-v4';

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache =>
        // Cache each file independently instead of using addAll — addAll is
        // all-or-nothing, so if even one file 404s, NONE of the shell gets
        // cached, silently breaking offline mode. This way, one bad file
        // can't take the rest down with it.
        Promise.allSettled(
          SHELL_FILES.map(file =>
            cache.add(file).catch(err => console.warn('Could not precache', file, err))
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    // App shell: NETWORK-FIRST. Always prefer the live page when online so
    // a stale or broken cached version (e.g. from an earlier deploy) can
    // never get "stuck" — it self-heals the moment the network is available.
    // Falls back to cache only when there's genuinely no connection.
    event.respondWith(
      fetch(req).then(networkResp => {
        if (networkResp && networkResp.status === 200) {
          const clone = networkResp.clone();
          caches.open(SHELL_CACHE).then(cache => cache.put(req, clone));
        }
        return networkResp;
      }).catch(() => caches.match(req))
    );
  } else {
    // Cross-origin (CDN): runtime cache-first so the OCR engine, pdf.js,
    // and downloaded language data survive offline after first load.
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(cache =>
        cache.match(req).then(cached => {
          if (cached) return cached;
          return fetch(req).then(networkResp => {
            // Cache opaque (no-cors) and normal successful responses alike.
            if (networkResp && (networkResp.status === 200 || networkResp.type === 'opaque')) {
              cache.put(req, networkResp.clone());
            }
            return networkResp;
          }).catch(() => {
            // Nothing cached and no network — let it fail naturally;
            // the app's own error banner will explain what happened.
            return Promise.reject(new Error('offline-and-not-cached'));
          });
        })
      )
    );
  }
});
