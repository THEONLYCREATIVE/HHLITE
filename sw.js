/**
 * Service Worker - Expiry Tracker v5.2.0
 * Provides offline support and caching
 */

const CACHE_NAME = 'expiry-tracker-v5.2.0';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Outfit:wght@300;400;500;600;700&display=swap'
];

// Install
self.addEventListener('install', (e) => {
  console.log('[SW] Installing...');
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Caching assets');
        return cache.addAll(ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate
self.addEventListener('activate', (e) => {
  console.log('[SW] Activating...');
  e.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Removing old cache:', key);
            return caches.delete(key);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch
self.addEventListener('fetch', (e) => {
  // Skip non-GET requests
  if (e.request.method !== 'GET') return;

  // Skip API calls (don't cache them)
  if (e.request.url.includes('brocade.io') ||
      e.request.url.includes('openfoodfacts.org') ||
      e.request.url.includes('upcitemdb.com')) {
    return;
  }

  e.respondWith(
    caches.match(e.request)
      .then(cached => {
        if (cached) {
          return cached;
        }

        return fetch(e.request)
          .then(response => {
            // Don't cache non-successful responses
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }

            // Clone and cache
            const responseToCache = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => cache.put(e.request, responseToCache));

            return response;
          })
          .catch(() => {
            // Offline fallback for navigation
            if (e.request.mode === 'navigate') {
              return caches.match('./index.html');
            }
          });
      })
  );
});
