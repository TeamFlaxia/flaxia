/**
 * Client-side media token management.
 *
 * Fetches signed tokens from the server and appends them to media URLs.
 * Tokens are cached per key and automatically refreshed before expiry.
 */

type MediaType = 'image' | 'audio' | 'video' | 'swf' | 'zip';

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();
const pendingFetches = new Map<string, Promise<string>>();

// Refresh tokens 60 seconds before expiry
const REFRESH_BUFFER_MS = 60 * 1000;

// TTL in milliseconds (must match server-side values)
const TOKEN_TTL_MS: Record<MediaType, number> = {
  image: 300 * 1000,
  audio: 1800 * 1000,
  video: 1800 * 1000,
  swf: 3600 * 1000,
  zip: 3600 * 1000,
};

function getCacheKey(type: MediaType, key: string): string {
  return `${type}:${key}`;
}

function isTokenValid(entry: TokenCacheEntry): boolean {
  return Date.now() < entry.expiresAt - REFRESH_BUFFER_MS;
}

async function fetchToken(type: MediaType, key: string): Promise<string | null> {
  try {
    const response = await fetch(`/api/media-token/${type}/${encodeURIComponent(key)}`, {
      credentials: 'include',
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { token: string; expiresIn: number };
    return data.token;
  } catch {
    return null;
  }
}

/**
 * Get a signed media URL for the given key.
 * Returns the original URL if token fetching fails (graceful degradation).
 */
export async function getSignedMediaUrl(type: MediaType, key: string): Promise<string> {
  const cacheKey = getCacheKey(type, key);

  // Check cache
  const cached = tokenCache.get(cacheKey);
  if (cached && isTokenValid(cached)) {
    return buildUrl(type, key, cached.token);
  }

  // Deduplicate in-flight requests
  const pending = pendingFetches.get(cacheKey);
  if (pending) return pending;

  const fetchPromise = fetchToken(type, key)
    .then((token) => {
      pendingFetches.delete(cacheKey);
      if (!token) return buildUrl(type, key, null);
      tokenCache.set(cacheKey, {
        token,
        expiresAt: Date.now() + TOKEN_TTL_MS[type],
      });
      return buildUrl(type, key, token);
    })
    .catch(() => {
      pendingFetches.delete(cacheKey);
      return buildUrl(type, key, null);
    });

  pendingFetches.set(cacheKey, fetchPromise);
  return fetchPromise;
}

/**
 * Get multiple signed media URLs at once (batch mode).
 * More efficient than calling getSignedMediaUrl multiple times.
 */
export async function getSignedMediaUrls(items: Array<{ type: MediaType; key: string }>): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const toFetch: Array<{ type: MediaType; key: string }> = [];

  // Check cache first
  for (const item of items) {
    const cacheKey = getCacheKey(item.type, item.key);
    const cached = tokenCache.get(cacheKey);
    if (cached && isTokenValid(cached)) {
      results.set(item.key, buildUrl(item.type, item.key, cached.token));
    } else {
      toFetch.push(item);
    }
  }

  // Batch fetch remaining tokens
  if (toFetch.length > 0) {
    try {
      const response = await fetch('/api/media-token/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ items: toFetch }),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          items: Array<{ key: string; token: string; expiresIn: number }>;
        };

        for (const item of data.items) {
          const original = toFetch.find((t) => t.key === item.key);
          if (original) {
            tokenCache.set(getCacheKey(original.type, item.key), {
              token: item.token,
              expiresAt: Date.now() + item.expiresIn * 1000,
            });
            results.set(item.key, buildUrl(original.type, item.key, item.token));
          }
        }
      }
    } catch {
      // Graceful degradation
    }

    // Fill in any missing URLs with unsigned fallbacks
    for (const item of toFetch) {
      if (!results.has(item.key)) {
        results.set(item.key, buildUrl(item.type, item.key, null));
      }
    }
  }

  return results;
}

/**
 * Invalidate cached tokens for a specific key or all tokens.
 */
export function invalidateMediaTokens(key?: string): void {
  if (key) {
    for (const cacheKey of tokenCache.keys()) {
      if (cacheKey.endsWith(`:${key}`)) {
        tokenCache.delete(cacheKey);
        pendingFetches.delete(cacheKey);
      }
    }
  } else {
    tokenCache.clear();
    pendingFetches.clear();
  }
}

function buildUrl(type: MediaType, key: string, token: string | null): string {
  const basePaths: Record<MediaType, string> = {
    image: '/api/images/',
    audio: '/api/audio/',
    video: '/api/video/',
    swf: '/api/swf/',
    zip: '/api/zip/',
  };

  const path = `${basePaths[type]}${key}`;
  if (!token) return path;
  return `${path}?token=${encodeURIComponent(token)}&_=${Date.now()}`;
}
