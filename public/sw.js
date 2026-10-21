const CACHE_NAME = 'flaxia-v2';
const OFFLINE_FALLBACK = '/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(['/offline']).catch(() => {
        /* non-critical */
      });
    }),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    }),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // API requests: network-only (no cache)
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Static assets with hash in filename: cache-first
  if (
    url.pathname.startsWith('/assets/') &&
    (url.pathname.match(/-[a-zA-Z0-9]{8}\./) || url.pathname.endsWith('.css'))
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Same-origin navigations: network-first
  if (request.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
    return;
  }
});

async function cacheFirst(request) {
  try {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    return fallbackResponse(request);
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return fallbackResponse(request);
  }
}

async function fallbackResponse(request) {
  const cached = await caches.match(OFFLINE_FALLBACK);
  if (cached) return cached;
  return new Response(request.mode === 'navigate' ? 'Offline' : '', {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  });
}

self.addEventListener('push', (event) => {
  const data = event.data?.json();
  if (!data) return;

  const title = data.title || 'Flaxia';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/' },
    vibrate: [200, 100, 200],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

function safeNavigateUrl(raw) {
  // #105: notification payloads must never drive openWindow/location to a
  // javascript: URL or an off-origin page. Same-origin https or app-relative
  // paths only; everything else falls back to the home route.
  try {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return '/';
    const parsed = new URL(raw, self.location.origin);
    if (parsed.origin !== self.location.origin) return '/';
    if (!['http:', 'https:'].includes(parsed.protocol)) return '/';
    return parsed.pathname + parsed.search + parsed.hash || '/';
  } catch {
    return '/';
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeNavigateUrl(event.notification.data?.url);
  event.waitUntil(clients.openWindow(url));
});
