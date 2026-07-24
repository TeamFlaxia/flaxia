let cachedMe: Record<string, unknown> | null = null;
let cachePromise: Promise<Record<string, unknown> | null> | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

export async function getMe(): Promise<Record<string, unknown> | null> {
  const now = Date.now();

  // キャッシュが有効期限内ならキャッシュを返す
  if (cachedMe && now - cacheTimestamp < CACHE_TTL) {
    return cachedMe;
  }

  // 既にfetch中なら同じPromiseを返す（重複リクエスト防止）
  if (cachePromise) return cachePromise;

  cachePromise = fetch('/api/me', { credentials: 'include' })
    .then((r) => {
      if (r.ok) return r.json() as Promise<Record<string, unknown>>;
      if (r.status === 401) {
        clearMeCache();
        return null;
      }
      return null;
    })
    .then((data: unknown) => {
      cachedMe = data as Record<string, unknown> | null;
      cacheTimestamp = now;
      cachePromise = null;
      return data;
    })
    .catch(() => {
      cachePromise = null;
      return null;
    }) as Promise<Record<string, unknown> | null>;

  return cachePromise;
}

export function clearMeCache() {
  cachedMe = null;
  cachePromise = null;
  cacheTimestamp = 0;
}

export function updateMeCache(data: Record<string, unknown>) {
  cachedMe = data;
  cacheTimestamp = Date.now();
}
