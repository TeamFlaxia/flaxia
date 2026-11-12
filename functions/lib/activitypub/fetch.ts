/// <reference types="@cloudflare/workers-types" />

import { checkUrlForSsrf, SsrfError } from '../url-guard.ts';
import { importPrivateKey } from './crypto.ts';

/**
 * Network access for ActivityPub.
 *
 * Every request to a remote instance goes through the shared SSRF guard: only
 * public http(s) targets are allowed and every redirect hop is validated
 * again. The one exception is a federation test peer that runs next to this
 * instance (a container on the same machine); it is reachable only through an
 * explicit allow list that is ignored outside of test and development.
 */

/** The user agent the instance sends to the other instances. */
export const USER_AGENT = 'Flaxia/1.0 (+https://flaxia.app)';

export interface FederationEnv {
  BASE_URL?: string;
  /** Deployment environment. Private peers are only allowed in test/development. */
  ENVIRONMENT?: string;
  /** Comma separated list of host names that may be private. Test/development only. */
  AP_ALLOWED_PRIVATE_PEERS?: string;
  /**
   * Deliver the activities without the queue. The local development server
   * has no queue consumer. The binding does not exist in production.
   */
  AP_DIRECT_DELIVERY?: string;
  CACHE?: KVNamespace;
}

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Sign the request with the actor key (authorized fetch). */
  privateKeyPem?: string;
  keyId?: string;
  /**
   * Reject a redirect that leaves the origin of the requested document.
   * Actor and key documents use this: an open redirect on a public host must
   * not be able to serve another origin's key for this actor.
   */
  sameOrigin?: boolean;
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
  const host = hostWithoutPort(hostname);
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/** The host of a URL without its port. */
function hostWithoutPort(hostname: string): string {
  const raw = hostname.toLowerCase();
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(1, end) : raw;
  }
  return raw.split(':')[0];
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

  const initialOrigin = current.origin;
  const headers: Record<string, string> = {
    Accept: 'application/activity+json, application/ld+json',
    // Some instances refuse a request without a user agent.
    'User-Agent': USER_AGENT,
    ...(options.headers ?? {}),
  };

  // A peer that runs in secure mode only answers a request that is signed.
  // The date of the signature and the date of the request are the same, so
  // the signature stays valid when the request is sent.
  if (options.privateKeyPem && options.keyId) {
    const date = new Date().toUTCString();
    const signingString = [
      `(request-target): get ${current.pathname}${current.search}`,
      `host: ${current.host}`,
      `date: ${date}`,
    ].join('\n');
    const signature = await signWithKey(options.privateKeyPem, signingString);
    headers.Date = date;
    headers.Signature = `keyId="${options.keyId}",algorithm="rsa-sha256",headers="(request-target) host date",signature="${signature}"`;
  }

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

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (options.sameOrigin && current.origin !== initialOrigin) {
        console.error(`Blocked cross-origin ActivityPub redirect: ${initialOrigin} -> ${current.origin}`);
        return null;
      }
      return response;
    }

    const location = response.headers.get('Location');
    if (!location) return response;
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return null;
    }
    if (options.sameOrigin && next.origin !== initialOrigin) {
      console.error(`Blocked cross-origin ActivityPub redirect: ${initialOrigin} -> ${next.origin}`);
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

/** Sign a string with the private key of an actor. */
async function signWithKey(privateKeyPem: string, signingString: string): Promise<string> {
  const key = await importPrivateKey(privateKeyPem);
  const encoder = new TextEncoder();
  const signatureBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signingString));
  return btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
}

interface ExtractedKey {
  pem: string;
  owner: string | null;
  id: string | null;
}

const stringField = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

function extractPublicKey(document: Record<string, unknown> | null): ExtractedKey | null {
  if (!document) return null;
  const key = document.publicKey;
  if (typeof key === 'object' && key !== null && !Array.isArray(key)) {
    const record = key as Record<string, unknown>;
    const pem = stringField(record.publicKeyPem);
    if (pem && pem.includes('BEGIN PUBLIC KEY')) {
      return {
        pem,
        owner:
          stringField(record.owner) ??
          stringField(record.controller) ??
          stringField(document.owner) ??
          stringField(document.controller),
        id: stringField(record.id) ?? stringField(document.id),
      };
    }
  }
  const pem = stringField(document.publicKeyPem);
  if (pem && pem.includes('BEGIN PUBLIC KEY')) {
    return {
      pem,
      owner: stringField(document.owner) ?? stringField(document.controller),
      id: stringField(document.id),
    };
  }
  return null;
}

/** Compare two actor URLs without a trailing slash or fragment. */
const canonicalActorUrl = (value: string): string => {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
};

/**
 * Resolve the public key of a remote actor.
 *
 * The `keyId` of the signature is the authoritative reference: a peer may host
 * its key on a different document than the actor. The key is only fetched
 * from the actor's own origin (and a redirect may not leave it), otherwise a
 * key from another instance could vouch for this actor.
 *
 * A same-origin key is not enough: a user of a multi-user instance could
 * otherwise sign as another user of that instance. When the key document
 * names an `owner`, it has to be this actor. A separate key document without
 * an owner is only accepted when the actor document advertises the same key.
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

  let unverified: ExtractedKey | null = null;
  if (keyId) {
    try {
      const keyUrl = new URL(keyId);
      keyUrl.hash = '';
      if (keyUrl.origin === actorOrigin) {
        const document = await fetchActivityPubJson(keyUrl.toString(), env, { ...options, sameOrigin: true });
        const key = extractPublicKey(document);
        if (key?.owner) {
          return canonicalActorUrl(key.owner) === canonicalActorUrl(actorUrl) ? key.pem : null;
        }
        if (key) {
          // The keyId pointed at the actor document itself, so this is the
          // document we would fetch for the fallback anyway.
          if (canonicalActorUrl(keyUrl.toString()) === canonicalActorUrl(actorUrl)) {
            const documentId = stringField(document?.id);
            if (documentId && canonicalActorUrl(documentId) !== canonicalActorUrl(actorUrl)) return null;
            return key.pem;
          }
          unverified = key;
        }
      }
    } catch {
      // fall through to the actor document
    }
  }

  const actorDocument = await fetchActivityPubJson(actorUrl, env, { ...options, sameOrigin: true });
  const actorDocumentId = stringField(actorDocument?.id);
  if (actorDocumentId && canonicalActorUrl(actorDocumentId) !== canonicalActorUrl(actorUrl)) return null;
  const actorKey = extractPublicKey(actorDocument);
  if (!actorKey) return null;
  if (actorKey.owner && canonicalActorUrl(actorKey.owner) !== canonicalActorUrl(actorUrl)) {
    return null;
  }
  if (keyId && actorKey.id) {
    const expected = canonicalActorUrl(keyId.split('#')[0] ?? '');
    if (canonicalActorUrl(actorKey.id.split('#')[0] ?? '') !== expected) return null;
  }
  // A key hosted on its own document with no owner is only trusted when the
  // actor document publishes the exact same key.
  if (unverified && unverified.pem !== actorKey.pem) return null;
  return actorKey.pem;
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
  const document = await fetchActivityPubJson(actorUrl, env, { ...options, sameOrigin: true });
  return extractPublicKey(document)?.pem ?? null;
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
  const document = await fetchActivityPubJson(actorUrl, env, { ...options, sameOrigin: true });
  if (!document) return null;
  const documentId = stringField(document.id);
  if (documentId && canonicalActorUrl(documentId) !== canonicalActorUrl(actorUrl)) return null;

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
    publicKeyPem: extractPublicKey(document)?.pem ?? null,
    preferredUsername: typeof document.preferredUsername === 'string' ? document.preferredUsername : null,
    displayName: typeof document.name === 'string' ? document.name : null,
    iconUrl,
    domain,
  };
}
