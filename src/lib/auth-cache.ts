let cachedMe: any = null;
let cachePromise: Promise<any> | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

export async function getMe(): Promise<any> {
  const now = Date.now();

  // キャッシュが有効期限内ならキャッシュを返す
  if (cachedMe && now - cacheTimestamp < CACHE_TTL) {
    return cachedMe;
  }

  // 既にfetch中なら同じPromiseを返す（重複リクエスト防止）
  if (cachePromise) return cachePromise;

  cachePromise = fetch('/api/me', { credentials: 'include' })
    .then((r) => {
      if (r.ok) return r.json();
      if (r.status === 401) {
        // 認証失敗時はキャッシュをクリア
        clearMeCache();
        return null;
      }
      return null;
    })
    .then((data) => {
      cachedMe = data;
      cacheTimestamp = now;
      cachePromise = null;
      return data;
    })
    .catch(() => {
      cachePromise = null;
      return null;
    });

  return cachePromise;
}

export function clearMeCache() {
  cachedMe = null;
  cachePromise = null;
  cacheTimestamp = 0;
}

export function updateMeCache(data: any) {
  cachedMe = data;
  cacheTimestamp = Date.now();
}
