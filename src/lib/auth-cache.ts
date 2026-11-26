import { clearSessionUser } from './svelte/session.ts';

let cachedMe: Record<string, unknown> | null = null;
let cachePromise: Promise<Record<string, unknown> | null> | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds
let cacheGeneration = 0;

export async function getMe(): Promise<Record<string, unknown> | null> {
  const now = Date.now();

  // キャッシュが有効期限内ならキャッシュを返す
  if (cachedMe && now - cacheTimestamp < CACHE_TTL) {
    return cachedMe;
  }

  // 既にfetch中なら同じPromiseを返す（重複リクエスト防止）
  if (cachePromise) return cachePromise;
  const generation = cacheGeneration;

  // A stalled auth worker must never hold the whole app hostage: the layout
  // no longer awaits this, but a bounded request still releases its consumers.
  cachePromise = fetch('/api/me', { credentials: 'include', signal: AbortSignal.timeout(8000) })
    .then(async (r) => {
      if (generation !== cacheGeneration) return cachedMe;
      if (!r.ok) {
        // Only an explicit 401 proves the session is gone. A 5xx or a gateway
        // error is transient and must not sign out a known user.
        if (r.status === 401) clearMeCache();
        return cachedMe;
      }
      const data = (await r.json()) as Record<string, unknown>;
      if (generation !== cacheGeneration) return cachedMe;
      cachedMe = data;
      cacheTimestamp = now;
      return data;
    })
    .catch(() => {
      // A network error is not a sign-out either: keep the last known user.
      return cachedMe;
    })
    .finally(() => {
      if (generation === cacheGeneration) cachePromise = null;
    }) as Promise<Record<string, unknown> | null>;

  return cachePromise;
}

export function clearMeCache() {
  cacheGeneration++;
  cachedMe = null;
  cachePromise = null;
  cacheTimestamp = 0;
  clearSessionUser();
}

export function updateMeCache(data: Record<string, unknown>) {
  cacheGeneration++;
  cachePromise = null;
  cachedMe = data;
  cacheTimestamp = Date.now();
}
