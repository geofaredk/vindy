// Vindy service worker: makes the app installable and lets the interface open offline.
// Weather data (/api/*) always comes from the network so it is never stale; the app shell
// is network-first (a new deploy shows up on the next load) with the cache as fallback.
const VERSION = 'vindy-v9';
const SHELL = `${VERSION}-shell`;
const TILES = `${VERSION}-coast`;
const PRECACHE = [
  '/', '/css/app.css', '/manifest.webmanifest',
  '/js/app.js', '/js/coast-layer.js', '/js/export.js', '/js/field.js', '/js/forecast.js', '/js/layers.js', '/js/lcc.js',
  '/js/places.js', '/js/satellite.js', '/js/weather-layer.js',
  '/vendor/leaflet/leaflet.css', '/vendor/leaflet/leaflet.js',
  '/img/vindy-light.svg', '/img/icons/icon-192.png', '/img/icons/apple-touch-icon.png',
  '/data/coast.json', '/data/coast/index.json',
];
const NETWORK_TIMEOUT = 4000;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (!key.startsWith(VERSION)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Every app URL (/overview/56.10,11.00,7, /radar, …) is the same page.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, SHELL, '/'));
    return;
  }
  // High-resolution coastline tiles never change between deploys.
  if (url.pathname.startsWith('/data/coast/')) {
    event.respondWith(cacheFirst(req, TILES));
    return;
  }
  event.respondWith(networkFirst(req, SHELL));
});

async function networkFirst(req, cacheName, cacheKey = req) {
  const cache = await caches.open(cacheName);
  try {
    const res = await withTimeout(fetch(req), NETWORK_TIMEOUT);
    if (res.ok) cache.put(cacheKey, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(cacheKey, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
