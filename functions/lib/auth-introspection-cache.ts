// Short-lived in-isolate cache for Auth grant introspection. Kept in its own
// module so flaxia-auth.ts stays under the file-size ratchet and the cache can
// be unit-tested independently.
export type AuthIdentity = { user_id: string; expires_at: string };

type CachedIntrospection = { identity: AuthIdentity; cachedAt: number };
type AuthEnv = { AUTH_SERVICE?: object };

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TTL_MS = 30_000;
const MAX_ENTRIES = 512;
const cache = new WeakMap<object, Map<string, CachedIntrospection>>();

async function grantKey(grant: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(grant)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function scope(env: AuthEnv): Map<string, CachedIntrospection> | null {
  const service = env.AUTH_SERVICE;
  if (!service) return null;
  let entries = cache.get(service);
  if (!entries) {
    entries = new Map();
    cache.set(service, entries);
  }
  return entries;
}

export function readIntrospection(env: AuthEnv, key: string, now: number): AuthIdentity | null {
  const entries = env.AUTH_SERVICE ? cache.get(env.AUTH_SERVICE) : undefined;
  const hit = entries?.get(key);
  if (!hit) return null;
  if (now - hit.cachedAt >= TTL_MS || Date.parse(hit.identity.expires_at) <= now) {
    entries?.delete(key);
    return null;
  }
  return hit.identity;
}

export async function writeIntrospection(env: AuthEnv, key: string, identity: AuthIdentity): Promise<void> {
  const entries = scope(env);
  if (!entries) return;
  entries.delete(key);
  entries.set(key, { identity, cachedAt: Date.now() });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export async function introspectionKey(grant: string): Promise<string> {
  return grantKey(grant);
}

// Revoke immediately forgets the cached answer for that grant in this isolate.
export async function forgetIntrospection(env: AuthEnv, grant: string): Promise<void> {
  if (!TOKEN.test(grant) || !env.AUTH_SERVICE) return;
  cache.get(env.AUTH_SERVICE)?.delete(await grantKey(grant));
}

// Bulk revocation / account deletion cannot enumerate every grant from here,
// so drop the whole issuer's cache to avoid a stale success surviving its TTL.
export function forgetAllIntrospection(env: AuthEnv): void {
  if (!env.AUTH_SERVICE) return;
  cache.get(env.AUTH_SERVICE)?.clear();
}
