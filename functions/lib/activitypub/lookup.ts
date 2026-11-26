/**
 * Cross-instance handle lookup.
 *
 * A handle is the only user input accepted here. It is validated before a URL
 * is built, so a caller can never make this module fetch an arbitrary URL; the
 * WebFinger and actor requests then go through the shared SSRF-safe federation
 * fetcher, which validates every redirect hop again.
 */

import {
  type FederationEnv,
  type FetchOptions,
  fetchFederationDocument,
  isPrivatePeerAllowed,
  type RemoteActor,
  resolveRemoteActor,
} from './fetch.ts';

/**
 * `@user@domain`, with or without the leading `@`.
 *
 * The domain must be a real DNS name with an alphabetic TLD: no ports, paths,
 * userinfo or extra `@` characters, and no IP literals. The federation test
 * peer (which uses a host:port) is handled by `lookupRemoteHandleAt`, which is
 * only reachable from the trusted follow endpoints.
 */
export const REMOTE_HANDLE_PATTERN = /^@?([A-Za-z0-9_]{1,30})@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})$/;

export interface RemoteHandle {
  username: string;
  domain: string;
}

/** Validate and split a remote handle. Returns null instead of throwing. */
export function parseRemoteHandle(handle: string): RemoteHandle | null {
  if (typeof handle !== 'string') return null;
  const match = REMOTE_HANDLE_PATTERN.exec(handle.trim());
  if (!match) return null;
  return { username: match[1], domain: match[2].toLowerCase() };
}

/**
 * Slightly wider domain validation for the follow endpoints.
 *
 * They already accepted `host:port` for the private federation peer, so this
 * keeps that behavior while still refusing paths, userinfo and URL schemes.
 */
function normalizeLookupDomain(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!value || value.length > 253) return null;
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(value)) return null;
  if (value.includes('..')) return null;
  try {
    const url = new URL(`https://${value}`);
    return `${url.protocol}//${url.host}` === `https://${value}` ? value : null;
  } catch {
    return null;
  }
}

interface WebFingerLink {
  rel?: unknown;
  href?: unknown;
  type?: unknown;
}

/**
 * Look up a username on the instance named by `domain`.
 *
 * Only the validated domain is used to build the WebFinger URL. The actor URL
 * comes from the WebFinger document and is resolved with the same-origin,
 * SSRF-checked fetcher. Any failure (DNS, TLS, bad JSON, redirects into private
 * networks, a missing actor) becomes null so no raw fetch error reaches the
 * client.
 */
export async function lookupRemoteHandleAt(
  username: string,
  domain: string,
  env: FederationEnv,
  options: FetchOptions = {},
): Promise<RemoteActor | null> {
  const normalizedDomain = normalizeLookupDomain(domain);
  if (!normalizedDomain || !/^[A-Za-z0-9_]{1,30}$/.test(username)) return null;

  try {
    let hostname: string;
    try {
      hostname = new URL(`https://${normalizedDomain}`).hostname;
    } catch {
      return null;
    }

    const origins = [`https://${normalizedDomain}`];
    if (isPrivatePeerAllowed(env, hostname)) origins.push(`http://${normalizedDomain}`);

    let webfinger: Record<string, unknown> | null = null;
    for (const origin of origins) {
      const url = `${origin}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${username}@${normalizedDomain}`)}`;
      const response = await fetchFederationDocument(url, env, {
        ...options,
        headers: { Accept: 'application/jrd+json, application/json', ...options.headers },
      });
      if (!response?.ok) continue;
      try {
        const document = (await response.json()) as Record<string, unknown>;
        if (document && typeof document === 'object') {
          webfinger = document;
          break;
        }
      } catch {}
    }
    if (!webfinger) return null;

    const links = Array.isArray(webfinger.links) ? (webfinger.links as WebFingerLink[]) : [];
    const selfLinks = links.filter((link) => link?.rel === 'self' && typeof link.href === 'string' && link.href);
    // Prefer an ActivityPub self link when an instance publishes several.
    selfLinks.sort((a, b) => {
      const aType = typeof a.type === 'string' ? a.type : '';
      const bType = typeof b.type === 'string' ? b.type : '';
      return Number(bType.includes('activity+json')) - Number(aType.includes('activity+json'));
    });

    for (const link of selfLinks) {
      let actorUrl: URL;
      try {
        actorUrl = new URL(link.href as string);
      } catch {
        continue;
      }
      if (actorUrl.protocol !== 'https:' && actorUrl.protocol !== 'http:') continue;
      const actor = await resolveRemoteActor(actorUrl.toString(), env, options);
      if (actor) return actor;
    }
    return null;
  } catch {
    return null;
  }
}

/** Look up a validated `@user@domain` handle. Never throws. */
export async function lookupRemoteHandle(
  handle: string,
  env: FederationEnv,
  options: FetchOptions = {},
): Promise<RemoteActor | null> {
  const parsed = parseRemoteHandle(handle);
  if (!parsed) return null;
  return lookupRemoteHandleAt(parsed.username, parsed.domain, env, options);
}

/** Small DTO returned by the lookup endpoint; no raw actor document leaks. */
export interface RemoteLookupResult {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  actorUrl: string;
  domain: string;
}

function safeIconUrl(raw: string | null, actorUrl: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, actorUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function toRemoteLookupDto(actor: RemoteActor): RemoteLookupResult {
  const username = actor.preferredUsername || actor.actorUrl.split('/').filter(Boolean).pop() || 'unknown';
  return {
    handle: `@${username}@${actor.domain}`,
    displayName: actor.displayName || actor.preferredUsername || null,
    avatarUrl: safeIconUrl(actor.iconUrl, actor.actorUrl),
    actorUrl: actor.actorUrl,
    domain: actor.domain,
  };
}

/** Deterministic KV key for a handle lookup. */
export function remoteLookupCacheKey(handle: string): string {
  const parsed = parseRemoteHandle(handle);
  const normalized = parsed ? `${parsed.username.toLowerCase()}@${parsed.domain}` : handle.trim().toLowerCase();
  return `remote:lookup:${normalized}`;
}

/** Deterministic rate-limit key for a caller (signed-in user or IP). */
export function remoteLookupRateLimitKey(identity: string): string {
  return `remote:lookup:rl:${identity}`;
}

const REMOTE_LOOKUP_CACHE_TTL_SECONDS = 300;

/**
 * Cache wrapper used by the lookup endpoint. Successful lookups are cached;
 * failures are not, so a temporarily offline instance can be retried.
 */
export async function lookupRemoteHandleCached(
  handle: string,
  env: FederationEnv,
  options: FetchOptions = {},
): Promise<RemoteActor | null> {
  if (!parseRemoteHandle(handle)) return null;
  const key = remoteLookupCacheKey(handle);
  try {
    const raw = await env.CACHE?.get(key);
    if (raw) {
      const cached = JSON.parse(raw) as RemoteActor | null;
      if (cached && typeof cached.actorUrl === 'string' && typeof cached.domain === 'string') return cached;
    }
  } catch {
    // A broken cache must not turn into a broken lookup.
  }

  const actor = await lookupRemoteHandle(handle, env, options);
  if (actor) {
    try {
      await env.CACHE?.put(key, JSON.stringify(actor), { expirationTtl: REMOTE_LOOKUP_CACHE_TTL_SECONDS });
    } catch {
      // The fresh result is still usable without a cache write.
    }
  }
  return actor;
}
