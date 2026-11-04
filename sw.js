/* SiteForge ERP service worker.
 *
 * Strategy
 *   navigation      -> network-first, cached shell as offline fallback
 *   same-origin GET -> stale-while-revalidate (fast, self-healing)
 *   pinned CDN GET  -> cache-first (SheetJS / supabase-js are version-pinned URLs)
 *   everything else -> straight to network (Supabase REST/auth/realtime is NEVER cached)
 *
 * Bump VERSION whenever index.html, scripts/app.js, module scripts or styles/main.css
 * change in a way that must invalidate the shell cache. Old caches are pruned on activate.
 */
'use strict';

var VERSION = 'v29.6.0-1';
var CACHE = 'forgesite-' + VERSION;

var CORE = [
  './',
  './index.html',
  './styles/main.css',
  './scripts/app.js',
  './scripts/modules/payment-requests.js',
  './scripts/modules/finance-statements.js',
  './scripts/modules/payslips.js',
  './scripts/modules/workflow-upgrades.js',
  './site.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

var CDN_HOSTS = ['cdn.sheetjs.com', 'cdn.jsdelivr.net', 'unpkg.com'];
var CDN_ASSETS = [
  'https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    var cache = await caches.open(CACHE);
    // Individual failures must not abort the whole install.
    await Promise.allSettled(CORE.map(function (url) {
      return cache.add(new Request(url, { cache: 'reload' }));
    }));
    // CDN libraries: fetch with CORS (both hosts send ACAO:*) so Cache.add's
    // 2xx-only requirement is met. An opaque/non-CORS response cannot use add().
    await Promise.allSettled(CDN_ASSETS.map(async function (url) {
      try {
        var response = await fetch(new Request(url, { mode: 'cors', credentials: 'omit' }));
        if (response && (response.ok || response.type === 'opaque')) await cache.put(url, response);
      } catch (err) {
        /* Offline or blocked at install time: cacheFirst() will populate it on first use. */
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.map(function (key) {
      if (key !== CACHE && key.indexOf('forgesite-') === 0) return caches.delete(key);
      return null;
    }));
    await self.clients.claim();
  })());
});

function isPinnedCdn(url) {
  return CDN_HOSTS.indexOf(url.hostname) !== -1;
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return; // never cache or replay mutations

  var url;
  try { url = new URL(request.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (isPinnedCdn(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  // Supabase API, auth, realtime, OCR workers: always live network, never cached.
});

async function networkFirst(request) {
  var cache = await caches.open(CACHE);
  try {
    var fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    var cached = await cache.match(request, { ignoreVary: true });
    if (!cached) cached = await cache.match('./index.html');
    if (!cached) cached = await cache.match('./');
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  var cache = await caches.open(CACHE);
  var cached = await cache.match(request, { ignoreVary: true });
  var network = fetch(request).then(function (response) {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(function () { return null; });
  if (cached) return cached;
  var fresh = await network;
  return fresh || Response.error();
}

async function cacheFirst(request) {
  var cache = await caches.open(CACHE);
  var cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  var response = await fetch(request);
  if (response && (response.ok || response.type === 'opaque')) {
    cache.put(request, response.clone());
  }
  return response;
}
