// Loaded inside a MapLibre WebWorker via maplibre.importScriptInWorkers().
// MapLibre tile requests run in the worker, so the `flaxia-tiles://` protocol
// must be registered here as well as on the main thread (src/components/MapsPage.ts).
// It uses its own scheme (not flaxia://) so tiles can never collide with the
// native auth deep link flaxia://auth/callback registered at OS level.
//
// This file must stay standalone: it is shipped as-is (no bundling), so
// it cannot import src/lib/maps/cache.ts. Keep the cache name below in
// sync with TILE_CACHE_NAME in cache.ts (200MB / 7d LRU lives there and
// is shared through the same Cache Storage + IndexedDB metadata).
const CACHE_NAME = 'flaxia-tiles-v1';
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TILE_ORIGINS = ['https://tiles.openfreemap.org/planet/', 'https://tiles.openfreemap.org/tiles/'];
const MAX_CONCURRENT_REVALIDATIONS = 4;
const REVALIDATE_COOLDOWN_MS = 60_000;

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
      tx.oncomplete = () => {
        db.close();
        resolve(undefined);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // IndexedDB is unavailable in some workers; the tile payload is unaffected.
  }
}

async function metaGetAll() {
  try {
    const db = await openMetaDb();
    const records = await new Promise((resolve, reject) => {
      const req = db.transaction('tiles', 'readonly').objectStore('tiles').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return records;
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
      tx.oncomplete = () => {
        db.close();
        resolve(undefined);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
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

let activeRevalidations = 0;
const lastRevalidatedAt = new Map();
const inFlight = new Map();

async function revalidateInBackground(url, cache, etag) {
  const now = Date.now();
  const last = lastRevalidatedAt.get(url) || 0;
  if (now - last < REVALIDATE_COOLDOWN_MS || activeRevalidations >= MAX_CONCURRENT_REVALIDATIONS) return;
  lastRevalidatedAt.set(url, now);
  activeRevalidations++;
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
  } finally {
    activeRevalidations--;
  }
}

async function fetchAndStoreTile(url, cache, signal) {
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

async function handleTileFetch(url, signal) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);
  if (cached) {
    const storedAt = Number(cached.headers.get('X-Stored-At'));
    if (Number.isFinite(storedAt) && storedAt > 0 && Date.now() - storedAt > MAX_AGE_MS) {
      try {
        return await fetchAndStoreTile(url, cache, signal);
      } catch {
        const stale = await cached.arrayBuffer();
        return stale;
      }
    }
    const buf = await cached.arrayBuffer();
    const etag = cached.headers.get('ETag');
    await metaTouch(url, buf.byteLength, etag).catch(() => undefined);
    void revalidateInBackground(url, cache, etag).catch(() => undefined);
    return buf;
  }
  const pending = inFlight.get(url);
  if (pending) return pending;
  const task = fetchAndStoreTile(url, cache, signal).finally(() => {
    inFlight.delete(url);
  });
  inFlight.set(url, task);
  return task;
}

self.addProtocol('flaxia-tiles', async (params, abortController) => {
  const url = params.url.slice('flaxia-tiles://'.length);
  if (!isTileUrl(url)) throw new Error('Unsupported tile URL');
  const data = await handleTileFetch(url, abortController.signal);
  return { data };
});
