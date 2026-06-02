export interface RateLimitConfig {
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetIn: number;
}

export async function checkRateLimit(kv: KVNamespace, config: RateLimitConfig): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const windowKey = `${config.key}:${Math.floor(now / config.windowSeconds)}`;

  const current = await kv.get(windowKey);
  const count = current ? parseInt(current) : 0;
  const resetIn = config.windowSeconds - (now % config.windowSeconds);

  if (count >= config.limit) {
    return { allowed: false, remaining: 0, resetIn };
  }

  await kv.put(windowKey, String(count + 1), {
    expirationTtl: config.windowSeconds * 2,
  });

  return {
    allowed: true,
    remaining: config.limit - count - 1,
    resetIn,
  };
}

export function rateLimitResponse(
  c: { json: (body: unknown, status: number, headers?: Record<string, string>) => Response },
  resetIn: number,
  limit: number,
) {
  return c.json({ error: 'Too many requests', retryAfter: resetIn }, 429, {
    'Retry-After': String(resetIn),
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': '0',
    'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + resetIn),
  });
}
