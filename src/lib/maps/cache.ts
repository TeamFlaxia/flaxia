export const TILE_CACHE_NAME = 'flaxia-tiles-v1';
export const TILE_CACHE_MAX_BYTES = 200 * 1024 * 1024;
export const TILE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// The Liberty style serves vector tiles from /planet/; /tiles/ is kept for
// older style revisions. Raster layers stay on the browser HTTP cache.
export const TILE_ORIGINS = ['https://tiles.openfreemap.org/planet/', 'https://tiles.openfreemap.org/tiles/'] as const;

// Tile URLs use their own scheme so they can never collide with the native
// auth deep link (flaxia://auth/callback) that the apps register at OS level.
const TILE_SCHEME = 'flaxia-tiles://';

export function isTileUrl(url: string): boolean {
  return TILE_ORIGINS.some((origin) => url.startsWith(origin));
}

export function rewriteTileUrl(url: string): string | null {
  return isTileUrl(url) ? `${TILE_SCHEME}${url}` : null;
}

export function unwrapTileUrl(url: string): string | null {
  if (!url.startsWith(TILE_SCHEME)) return null;
  const inner = url.slice(TILE_SCHEME.length);
  return isTileUrl(inner) ? inner : null;
}

export interface TileCacheMeta {
  url: string;
  size: number;
  lastAccess: number;
  etag: string | null;
  storedAt: number;
}

function openMetaDb(): Promise<IDBDatabase> {
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

async function metaPut(meta: TileCacheMeta): Promise<void> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tiles', 'readwrite');
    tx.objectStore('tiles').put(meta);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function metaGet(url: string): Promise<TileCacheMeta | null> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('tiles', 'readonly').objectStore('tiles').get(url);
    req.onsuccess = () => {
      db.close();
      resolve((req.result as TileCacheMeta | undefined) ?? null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

async function metaGetAll(): Promise<TileCacheMeta[]> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('tiles', 'readonly').objectStore('tiles').getAll();
    req.onsuccess = () => {
      db.close();
      resolve((req.result as TileCacheMeta[]) ?? []);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

async function metaTouch(url: string, size: number, etag: string | null): Promise<void> {
  const existing = await metaGet(url);
  await metaPut({
    url,
    size,
    lastAccess: Date.now(),
    etag,
    storedAt: existing?.storedAt ?? Date.now(),
  });
}

async function metaDelete(url: string): Promise<void> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tiles', 'readwrite');
    tx.objectStore('tiles').delete(url);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function metaClear(): Promise<void> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tiles', 'readwrite');
    tx.objectStore('tiles').clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function evictIfNeeded(cache: Cache): Promise<void> {
  const metas = await metaGetAll();
  const now = Date.now();
  const expired = metas.filter((m) => now - m.storedAt >= TILE_CACHE_MAX_AGE_MS);
  for (const m of expired) {
    await cache.delete(m.url);
    await metaDelete(m.url);
  }
  const alive = metas.filter((m) => !expired.includes(m));
  let total = alive.reduce((sum, m) => sum + m.size, 0);
  if (total <= TILE_CACHE_MAX_BYTES) return;
  const sorted = [...alive].sort((a, b) => a.lastAccess - b.lastAccess);
  for (const m of sorted) {
    if (total <= TILE_CACHE_MAX_BYTES) break;
    const deleted = await cache.delete(m.url);
    if (deleted) {
      await metaDelete(m.url);
      total -= m.size;
    }
  }
}

export async function getTileCacheStats(): Promise<{ count: number; bytes: number }> {
  const metas = await metaGetAll();
  return { count: metas.length, bytes: metas.reduce((sum, m) => sum + m.size, 0) };
}

export async function clearTileCache(): Promise<void> {
  const cache = await caches.open(TILE_CACHE_NAME);
  const keys = await cache.keys();
  for (const key of keys) {
    await cache.delete(key);
  }
  await metaClear();
}

export async function requestStoragePersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    return false;
  }
  return false;
}

const inFlight = new Map<string, Promise<ArrayBuffer>>();
// Background revalidation is bounded: each cache hit used to fire one fetch,
// one Cache.put and one full eviction scan, so panning across cached tiles
// saturated the radio/IDB and could push other requests past their budgets.
const MAX_CONCURRENT_REVALIDATIONS = 4;
const REVALIDATE_COOLDOWN_MS = 60_000;
let activeRevalidations = 0;
const lastRevalidatedAt = new Map<string, number>();

async function revalidateInBackground(url: string, cache: Cache, etag: string | null): Promise<void> {
  const now = Date.now();
  const last = lastRevalidatedAt.get(url) ?? 0;
  if (now - last < REVALIDATE_COOLDOWN_MS || activeRevalidations >= MAX_CONCURRENT_REVALIDATIONS) return;
  lastRevalidatedAt.set(url, now);
  activeRevalidations++;
  try {
    const headers: Record<string, string> = { Accept: 'application/vnd.mapbox-vector-tile' };
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetch(url, { mode: 'cors', headers });
    if (res.status === 304 || !res.ok) return;
    const body = await res.arrayBuffer();
    await cache.put(
      url,
      new Response(body, {
        headers: {
          'Content-Type': 'application/vnd.mapbox-vector-tile',
          ETag: res.headers.get('ETag') ?? '',
          'X-Stored-At': String(Date.now()),
        },
      }),
    );
    await metaTouch(url, body.byteLength, res.headers.get('ETag') ?? null);
    await evictIfNeeded(cache);
  } catch {
    // Background revalidation is best-effort; the cached copy is already returned.
  } finally {
    activeRevalidations--;
  }
}

async function fetchAndStoreTile(
  url: string,
  cache: Cache,
  signal?: AbortSignal,
  onEvent?: (kind: 'hit' | 'miss' | 'offline', url: string) => void,
): Promise<ArrayBuffer> {
  try {
    const res = await fetch(url, {
      mode: 'cors',
      headers: { Accept: 'application/vnd.mapbox-vector-tile' },
      signal,
    });
    if (!res.ok) throw new Error(`tile ${res.status}`);
    const body = await res.arrayBuffer();
    onEvent?.('miss', url);
    try {
      await cache.put(
        url,
        new Response(body, {
          headers: {
            'Content-Type': 'application/vnd.mapbox-vector-tile',
            ETag: res.headers.get('ETag') ?? '',
            'X-Stored-At': String(Date.now()),
          },
        }),
      );
      await metaTouch(url, body.byteLength, res.headers.get('ETag') ?? null);
      await evictIfNeeded(cache);
    } catch {
      // Cache storage may be full or unavailable; the fetched tile is still returned.
      const metas = await metaGetAll().catch(() => [] as TileCacheMeta[]);
      const sorted = [...metas].sort((a, b) => a.lastAccess - b.lastAccess);
      for (const m of sorted.slice(0, Math.ceil(sorted.length / 2))) {
        await cache.delete(m.url).catch(() => false);
        await metaDelete(m.url).catch(() => undefined);
      }
    }
    return body;
  } catch (error) {
    onEvent?.('offline', url);
    throw error;
  }
}

export async function handleTileFetch(
  url: string,
  signal?: AbortSignal,
  onEvent?: (kind: 'hit' | 'miss' | 'offline', url: string) => void,
): Promise<ArrayBuffer> {
  const cache = await caches.open(TILE_CACHE_NAME);
  const cached = await cache.match(url);
  if (cached) {
    // Expired tiles are refreshed from the network; the stale copy is only
    // served when that refresh itself fails.
    const storedAt = Number(cached.headers.get('X-Stored-At'));
    if (Number.isFinite(storedAt) && storedAt > 0 && Date.now() - storedAt > TILE_CACHE_MAX_AGE_MS) {
      try {
        return await fetchAndStoreTile(url, cache, signal, onEvent);
      } catch {
        const stale = await cached.arrayBuffer();
        onEvent?.('hit', url);
        return stale;
      }
    }
    const buf = await cached.arrayBuffer();
    const etag = cached.headers.get('ETag');
    await metaTouch(url, buf.byteLength, etag).catch(() => undefined);
    onEvent?.('hit', url);
    void revalidateInBackground(url, cache, etag);
    return buf;
  }
  const pending = inFlight.get(url);
  if (pending) return pending;
  const task = fetchAndStoreTile(url, cache, signal, onEvent).finally(() => {
    inFlight.delete(url);
  });
  inFlight.set(url, task);
  return task;
}
