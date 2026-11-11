/// <reference types="@cloudflare/workers-types" />

import { checkUrlForSsrf, SsrfError } from '../url-guard.ts';

/**
 * Network access for ActivityPub.
 *
 * Every request to a remote instance goes through the shared SSRF guard: only
 * public http(s) targets are allowed and every redirect hop is validated
 * again. The one exception is a federation test peer that runs next to this
 * instance (a container on the same machine); it is reachable only through an
 * explicit allow list that is ignored outside of test and development.
 */

export interface FederationEnv {
  BASE_URL?: string;
  /** Deployment environment. Private peers are only allowed in test/development. */
  ENVIRONMENT?: string;
  /** Comma separated list of host names that may be private. Test/development only. */
  AP_ALLOWED_PRIVATE_PEERS?: string;
  CACHE?: KVNamespace;
}

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Sign the request with the actor key (authorized fetch). */
  privateKeyPem?: string;
  keyId?: string;
}

/** Environments in which a private federation peer may be contacted. */
const PRIVATE_PEER_ENVIRONMENTS = new Set(['test', 'development']);

/**
 * True when the given host may be contacted even though it is private.
 *
 * The allow list is deliberately inert in production: an operator that sets
 * the variable on the production deployment gets no effect at all.
 */
export function isPrivatePeerAllowed(env: FederationEnv, hostname: string): boolean {
  const environment = (env.ENVIRONMENT ?? '').toLowerCase();
  if (!PRIVATE_PEER_ENVIRONMENTS.has(environment)) return false;
  const allowed = (env.AP_ALLOWED_PRIVATE_PEERS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return false;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

function isAllowlisted(url: URL, env: FederationEnv): boolean {
  return isPrivatePeerAllowed(env, url.hostname);
}

/**
 * Fetch a remote document, following redirects manually.
 *
 * Allow listed private peers are accepted, but a redirect may only lead to
 * another allow listed host: a public host that redirects into the private
 * network is still blocked.
 */
export async function fetchFederationDocument(
  rawUrl: string,
  env: FederationEnv,
  options: FetchOptions = {},
): Promise<Response | null> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  let current: URL;
  try {
    current = new URL(rawUrl);
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new SsrfError('Unsupported protocol');
  } catch {
    return null;
  }

  const headers: Record<string, string> = {
    Accept: 'application/activity+json, application/ld+json',
    ...(options.headers ?? {}),
  };

  for (let hop = 0; hop <= 5; hop++) {
    if (!isAllowlisted(current, env)) {
      const reason = checkUrlForSsrf(current);
      if (reason) {
        console.error(`Blocked ActivityPub request: ${reason}`);
        return null;
      }
    }

    let response: Response;
    try {
      response = await fetch(current.toString(), {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return null;
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get('Location');
    if (!location) return response;
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return null;
    }
    if (!isAllowlisted(next, env)) {
      const reason = checkUrlForSsrf(next);
      if (reason) {
        console.error(`Blocked ActivityPub redirect: ${reason}`);
        return null;
      }
    }
    current = next;
  }

  return null;
}

/**
 * Fetch an ActivityPub document and parse it as JSON.
 */
export async function fetchActivityPubJson(
  url: string,
  env: FederationEnv,
  options: FetchOptions = {},
): Promise<Record<string, unknown> | null> {
  const response = await fetchFederationDocument(url, env, options);
  if (!response || !response.ok) return null;
  try {
    const document = (await response.json()) as Record<string, unknown>;
    return document && typeof document === 'object' ? document : null;
  } catch {
    return null;
  }
}

function extractPublicKeyPem(document: Record<string, unknown> | null): string | null {
  if (!document) return null;
  const key = document.publicKey;
  if (typeof key === 'object' && key !== null) {
    const pem = (key as { publicKeyPem?: unknown }).publicKeyPem;
    if (typeof pem === 'string' && pem.includes('BEGIN PUBLIC KEY')) return pem;
  }
  const pem = document.publicKeyPem;
  if (typeof pem === 'string' && pem.includes('BEGIN PUBLIC KEY')) return pem;
  return null;
}

/**
 * Resolve the public key of a remote actor.
 *
 * The `keyId` of the signature is the authoritative reference: a peer may host
 * its key on a different document than the actor. The key is only fetched
 * from the actor's own origin, otherwise a key from another instance could
 * vouch for this actor.
 *
 * When the key document cannot be resolved the actor document is used as a
 * fallback, which is what most implementations publish.
 */
export async function resolveActorPublicKey(
  actorUrl: string,
  env: FederationEnv,
  keyId?: string,
  options: FetchOptions = {},
): Promise<string | null> {
  let actorOrigin: string;
  try {
    actorOrigin = new URL(actorUrl).origin;
  } catch {
    return null;
  }

  if (keyId) {
    try {
      const keyUrl = new URL(keyId);
      keyUrl.hash = '';
      if (keyUrl.origin === actorOrigin) {
        const document = await fetchActivityPubJson(keyUrl.toString(), env, options);
        const pem = extractPublicKeyPem(document);
        if (pem) return pem;
      }
    } catch {
      // fall through to the actor document
    }
  }

  const actorDocument = await fetchActivityPubJson(actorUrl, env, options);
  return extractPublicKeyPem(actorDocument);
}

/**
 * Fetch the public key of an actor.
 *
 * Kept for the call sites that only have an actor URL; the returned PEM is
 * the one advertised in the actor document.
 */
export async function fetchActorPublicKey(
  actorUrl: string,
  env: FederationEnv,
  options: FetchOptions = {},
): Promise<string | null> {
  const document = await fetchActivityPubJson(actorUrl, env, options);
  return extractPublicKeyPem(document);
}

/**
 * Read the inbox of a remote actor.
 *
 * Only the inbox that lives on the actor's own origin is accepted: an actor
 * document must not be able to redirect signed deliveries into an intranet.
 */
export function normalizeRemoteInbox(
  actorUrl: string,
  inboxUrl: unknown,
  env: FederationEnv,
): { inbox: string; sharedInbox: string | null } | null {
  let actorOrigin: string;
  try {
    actorOrigin = new URL(actorUrl).origin;
  } catch {
    return null;
  }
  if (typeof inboxUrl !== 'string' || !inboxUrl) return null;
  let inbox: URL;
  try {
    inbox = new URL(inboxUrl);
  } catch {
    return null;
  }
  if (inbox.origin !== actorOrigin) return null;
  if (!isAllowlisted(inbox, env) && checkUrlForSsrf(inbox)) return null;
  return { inbox: inbox.toString(), sharedInbox: null };
}

export interface RemoteActor {
  actorUrl: string;
  inbox: string;
  sharedInbox: string | null;
  publicKeyPem: string | null;
  preferredUsername: string | null;
  displayName: string | null;
  iconUrl: string | null;
  domain: string;
}

/**
 * Fetch and normalise a remote actor document.
 *
 * Everything a delivery needs is taken from the document itself, but each
 * URL is validated against the actor's origin first.
 */
export async function resolveRemoteActor(
  actorUrl: string,
  env: FederationEnv,
  options: FetchOptions = {},
): Promise<RemoteActor | null> {
  const document = await fetchActivityPubJson(actorUrl, env, options);
  if (!document) return null;

  const inbox = normalizeRemoteInbox(actorUrl, document.inbox, env);
  if (!inbox) return null;

  let sharedInbox: string | null = null;
  const endpoints = document.endpoints;
  if (typeof endpoints === 'object' && endpoints !== null) {
    const advertised = (endpoints as { sharedInbox?: unknown }).sharedInbox;
    const normalized = normalizeRemoteInbox(actorUrl, advertised, env);
    if (normalized) sharedInbox = normalized.inbox;
  }

  const icon = document.icon;
  const iconUrl =
    typeof icon === 'object' && icon !== null && typeof (icon as { url?: unknown }).url === 'string'
      ? (icon as { url: string }).url
      : typeof icon === 'string'
        ? icon
        : null;

  let domain = '';
  try {
    domain = new URL(actorUrl).hostname;
  } catch {
    domain = '';
  }

  return {
    actorUrl,
    inbox: inbox.inbox,
    sharedInbox,
    publicKeyPem: extractPublicKeyPem(document),
    preferredUsername: typeof document.preferredUsername === 'string' ? document.preferredUsername : null,
    displayName: typeof document.name === 'string' ? document.name : null,
    iconUrl,
    domain,
  };
}
