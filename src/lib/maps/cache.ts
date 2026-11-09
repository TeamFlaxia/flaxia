export const TILE_CACHE_NAME = 'flaxia-tiles-v1';
export const TILE_CACHE_MAX_BYTES = 200 * 1024 * 1024;
export const TILE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function metaGetAll(): Promise<TileCacheMeta[]> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('tiles', 'readonly').objectStore('tiles').getAll();
    req.onsuccess = () => resolve((req.result as TileCacheMeta[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

async function metaDelete(url: string): Promise<void> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tiles', 'readwrite');
    tx.objectStore('tiles').delete(url);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function metaClear(): Promise<void> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tiles', 'readwrite');
    tx.objectStore('tiles').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function evictIfNeeded(cache: Cache): Promise<void> {
  const metas = await metaGetAll();
  const now = Date.now();
  const pruned = metas.filter((m) => now - m.storedAt < TILE_CACHE_MAX_AGE_MS);
  for (const m of metas) {
    if (!pruned.includes(m)) {
      await cache.delete(m.url);
      await metaDelete(m.url);
    }
  }
  let total = pruned.reduce((sum, m) => sum + m.size, 0);
  if (total <= TILE_CACHE_MAX_BYTES) return;
  const sorted = [...pruned].sort((a, b) => a.lastAccess - b.lastAccess);
  for (const m of sorted) {
    if (total <= TILE_CACHE_MAX_BYTES) break;
    const deleted = await cache.delete(m.url);
    if (deleted) {
      await metaDelete(m.url);
      total -= m.size;
    }
  }
  const estimate = await navigator.storage?.estimate?.();
  if (estimate && estimate.quota && estimate.usage) {
    if (estimate.usage > estimate.quota * 0.8 && total > 0) {
      const metas2 = await metaGetAll();
      const sorted2 = [...metas2].sort((a, b) => a.lastAccess - b.lastAccess);
      for (const m of sorted2.slice(0, Math.ceil(sorted2.length / 2))) {
        await cache.delete(m.url);
        await metaDelete(m.url);
      }
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

export async function handleTileFetch(
  url: string,
  signal?: AbortSignal,
  onEvent?: (kind: 'hit' | 'miss' | 'offline', url: string) => void,
): Promise<ArrayBuffer> {
  const cache = await caches.open(TILE_CACHE_NAME);
  const cached = await cache.match(url);
  if (cached) {
    const buf = await cached.arrayBuffer();
    const etag = cached.headers.get('ETag');
    void metaPut({
      url,
      size: buf.byteLength,
      lastAccess: Date.now(),
      etag,
      storedAt: Date.now(),
    });
    onEvent?.('hit', url);
    const revalidateHeaders: Record<string, string> = { Accept: 'application/vnd.mapbox-vector-tile' };
    if (etag) revalidateHeaders['If-None-Match'] = etag;
    fetch(url, { mode: 'cors', headers: revalidateHeaders, signal })
      .then(async (res) => {
        if (res.status === 304) return;
        if (!res.ok) return;
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
        await metaPut({
          url,
          size: body.byteLength,
          lastAccess: Date.now(),
          etag: res.headers.get('ETag'),
          storedAt: Date.now(),
        });
        await evictIfNeeded(cache);
      })
      .catch(() => undefined);
    return buf;
  }
  try {
    const res = await fetch(url, {
      mode: 'cors',
      headers: { Accept: 'application/vnd.mapbox-vector-tile' },
      signal,
    });
    if (!res.ok) throw new Error(`tile ${res.status}`);
    const body = await res.arrayBuffer();
    onEvent?.('miss', url);
    await cache
      .put(
        url,
        new Response(body, {
          headers: {
            'Content-Type': 'application/vnd.mapbox-vector-tile',
            ETag: res.headers.get('ETag') ?? '',
            'X-Stored-At': String(Date.now()),
          },
        }),
      )
      .then(async () => {
        await metaPut({
          url,
          size: body.byteLength,
          lastAccess: Date.now(),
          etag: res.headers.get('ETag'),
          storedAt: Date.now(),
        });
        await evictIfNeeded(cache);
      })
      .catch(async () => {
        const metas = await metaGetAll();
        const sorted = [...metas].sort((a, b) => a.lastAccess - b.lastAccess);
        for (const m of sorted.slice(0, Math.ceil(sorted.length / 2))) {
          await cache.delete(m.url);
          await metaDelete(m.url);
        }
      });
    return body;
  } catch (error) {
    onEvent?.('offline', url);
    throw error;
  }
}
