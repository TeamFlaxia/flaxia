/**
 * KV-based rate limiter for media endpoints.
 *
 * Uses Cloudflare KV to track request counts per IP.
 * Falls through (allows request) if KV is unavailable.
 */

export interface RateLimitConfig {
  /** Maximum requests allowed within the window */
  maxRequests: number;
  /** Time window in seconds */
  windowSeconds: number;
  /** Whether a KV outage should be rejected instead of silently bypassed. */
  failureMode?: 'open' | 'closed';
}

export class RateLimitUnavailableError extends Error {
  constructor() {
    super('Rate-limit storage unavailable');
    this.name = 'RateLimitUnavailableError';
  }
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxRequests: 100,
  windowSeconds: 60,
};

/**
 * Check rate limit for a given key (typically IP address).
 * Returns true if the request is allowed, false if rate-limited.
 */
export async function checkRateLimit(
  kv: KVNamespace | undefined,
  key: string,
  config: RateLimitConfig = DEFAULT_CONFIG,
): Promise<boolean> {
  if (!kv) {
    if (config.failureMode === 'closed') throw new RateLimitUnavailableError();
    return true;
  }

  const now = Math.floor(Date.now() / 1000);
  const windowKey = `rl:${key}:${Math.floor(now / config.windowSeconds)}`;

  try {
    const current = await kv.get(windowKey);
    const count = current ? Number.parseInt(current, 10) : 0;

    if (count >= config.maxRequests) {
      return false;
    }

    await kv.put(windowKey, String(count + 1), {
      expirationTtl: config.windowSeconds * 2, // Expire after 2 windows
    });

    return true;
  } catch (error) {
    if (config.failureMode === 'closed') {
      console.error('Rate-limit KV read/write failed', error);
      throw new RateLimitUnavailableError();
    }
    return true;
  }
}

/**
 * Get client IP from request headers.
 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    request.headers.get('X-Real-IP') ||
    'unknown'
  );
}
