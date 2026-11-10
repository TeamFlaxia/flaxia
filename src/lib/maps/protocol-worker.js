// Loaded inside a MapLibre WebWorker via maplibre.importScriptInWorkers().
// MapLibre tile requests run in the worker, so the `flaxia://` protocol
// must be registered here as well as on the main thread (src/components/MapsPage.ts).
//
// This file must stay standalone: it is shipped as-is (no bundling), so
// it cannot import src/lib/maps/cache.ts. Keep the cache name below in
// sync with TILE_CACHE_NAME in cache.ts (200MB / 7d LRU lives there and
// is shared through the same Cache Storage + IndexedDB metadata).
const CACHE_NAME = 'flaxia-tiles-v1';
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TILE_ORIGINS = ['https://tiles.openfreemap.org/planet/', 'https://tiles.openfreemap.org/tiles/'];

function isTileUrl(url) {
  return TILE_ORIGINS.some((origin) => url.startsWith(origin));
}

function openMetaDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('flaxia-tiles-meta', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tiles')) {
        const store = db.createObjectStore('tiles', { keyPath: 'url' });
        store.createIndex('lastAccess', 'lastAccess');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function metaTouch(url, size, etag) {
  try {
    const db = await openMetaDb();
    const existing = await new Promise((resolve, reject) => {
      const req = db.transaction('tiles', 'readonly').objectStore('tiles').get(url);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    const meta = {
      url,
      size,
      lastAccess: Date.now(),
      etag,
      storedAt: existing ? existing.storedAt : Date.now(),
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction('tiles', 'readwrite');
      tx.objectStore('tiles').put(meta);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // IndexedDB is unavailable in some workers; the tile payload is unaffected.
  }
}

async function metaGetAll() {
  try {
    const db = await openMetaDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction('tiles', 'readonly').objectStore('tiles').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function metaDelete(url) {
  try {
    const db = await openMetaDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('tiles', 'readwrite');
      tx.objectStore('tiles').delete(url);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Metadata is best-effort; never fail a tile response over it.
  }
}

async function evictIfNeeded(cache) {
  try {
    const metas = await metaGetAll();
    const now = Date.now();
    const expired = metas.filter((m) => now - m.storedAt >= MAX_AGE_MS);
    for (const m of expired) {
      await cache.delete(m.url);
      await metaDelete(m.url);
    }
    const alive = metas.filter((m) => !expired.includes(m));
    let total = alive.reduce((sum, m) => sum + m.size, 0);
    if (total <= MAX_BYTES) return;
    const sorted = [...alive].sort((a, b) => a.lastAccess - b.lastAccess);
    for (const m of sorted) {
      if (total <= MAX_BYTES) break;
      const deleted = await cache.delete(m.url);
      if (deleted) {
        await metaDelete(m.url);
        total -= m.size;
      }
    }
  } catch {
    // Eviction is best-effort; the tile has already been stored.
  }
}

async function revalidateInBackground(url, cache, etag) {
  try {
    const headers = { Accept: 'application/vnd.mapbox-vector-tile' };
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetch(url, { mode: 'cors', headers });
    if (res.status === 304 || !res.ok) return;
    const body = await res.arrayBuffer();
    await cache.put(
      url,
      new Response(body, {
        headers: {
          'Content-Type': 'application/vnd.mapbox-vector-tile',
          ETag: res.headers.get('ETag') || '',
          'X-Stored-At': String(Date.now()),
        },
      }),
    );
    await metaTouch(url, body.byteLength, res.headers.get('ETag') || null);
    await evictIfNeeded(cache);
  } catch {
    // Best-effort; the cached copy has already been returned to the map.
  }
}

async function handleTileFetch(url, signal) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);
  if (cached) {
    const buf = await cached.arrayBuffer();
    const etag = cached.headers.get('ETag');
    await metaTouch(url, buf.byteLength, etag).catch(() => undefined);
    void revalidateInBackground(url, cache, etag).catch(() => undefined);
    return buf;
  }
  const res = await fetch(url, {
    mode: 'cors',
    headers: { Accept: 'application/vnd.mapbox-vector-tile' },
    signal,
  });
  if (!res.ok) throw new Error('tile ' + res.status);
  const body = await res.arrayBuffer();
  try {
    await cache.put(
      url,
      new Response(body, {
        headers: {
          'Content-Type': 'application/vnd.mapbox-vector-tile',
          ETag: res.headers.get('ETag') || '',
          'X-Stored-At': String(Date.now()),
        },
      }),
    );
    await metaTouch(url, body.byteLength, res.headers.get('ETag') || null);
    await evictIfNeeded(cache);
  } catch {
    // Cache storage failure must not break the visible tile.
  }
  return body;
}

self.addProtocol('flaxia', async (params, abortController) => {
  const url = params.url.slice('flaxia://'.length);
  if (!isTileUrl(url)) throw new Error('Unsupported tile URL');
  const data = await handleTileFetch(url, abortController.signal);
  return { data };
});
