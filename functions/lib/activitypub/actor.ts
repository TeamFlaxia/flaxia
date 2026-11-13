/// <reference types="@cloudflare/workers-types" />

import { AS2_CONTEXT, SECURITY_CONTEXT } from './context.ts';

/**
 * URLs and documents that identify a local actor.
 *
 * Flaxia publishes actors under `/api/actors/:username` and keeps
 * `/actors/:username` as a permanent redirect for older peers. Every helper
 * here therefore knows both spellings, otherwise a peer that echoes back the
 * canonical `/api/actors/...` URL would never resolve to a local account.
 */

/** Canonical actor URL. */
export function actorUrl(baseUrl: string, username: string): string {
  return `${baseUrl}/api/actors/${encodeURIComponent(username)}`;
}

/** Key identifier of the actor's RSA key. */
export function actorKeyId(baseUrl: string, username: string): string {
  return `${actorUrl(baseUrl, username)}#main-key`;
}

/** Inbox of a single actor. */
export function actorInboxUrl(baseUrl: string, username: string): string {
  return `${actorUrl(baseUrl, username)}/inbox`;
}

/** Shared inbox every actor of this instance delivers to. */
export function sharedInboxUrl(baseUrl: string): string {
  return `${baseUrl}/api/inbox`;
}

/** Collection URLs of an actor. */
export function actorCollectionUrls(
  baseUrl: string,
  username: string,
): {
  followers: string;
  following: string;
  liked: string;
  featured: string;
  outbox: string;
  inbox: string;
} {
  const actor = actorUrl(baseUrl, username);
  return {
    followers: `${actor}/followers`,
    following: `${actor}/following`,
    liked: `${actor}/liked`,
    featured: `${actor}/featured`,
    outbox: `${actor}/outbox`,
    inbox: `${actor}/inbox`,
  };
}

/** Canonical URL of a post as a federated Note. */
export function noteUrl(baseUrl: string, postId: string): string {
  return `${baseUrl}/notes/${encodeURIComponent(postId)}`;
}

/** Profile page of a local account. */
export function profileUrl(baseUrl: string, username: string): string {
  return `${baseUrl}/users/${encodeURIComponent(username)}`;
}

/**
 * Extract the local username an ActivityPub URL points at.
 *
 * Only URLs that really live on this instance count: the origin must match
 * exactly, and the path must be one of the two actor spellings. A look-alike
 * such as `https://flaxia.app@evil.example/actors/victim` has a different
 * origin and is rejected, and a remote instance may never address a local
 * account through a path we do not serve.
 */
export function localActorUsername(value: unknown, baseUrl: string): string | null {
  if (typeof value !== 'string') return null;
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(value);
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.origin !== base.origin) return null;
  const match = parsed.pathname.match(/^\/(?:api\/)?actors\/([^/]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * Extract the local username a profile URL points at.
 *
 * A mention of a local account is published with the URL of its profile
 * page, so the mentioned account has to be resolved from that URL. Remote
 * mentions carry the URL of the remote actor and are ignored here.
 */
export function localProfileUsername(value: unknown, baseUrl: string): string | null {
  if (typeof value !== 'string') return null;
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(value);
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.origin !== base.origin) return null;
  const match = parsed.pathname.match(/^\/(?:api\/)?users\/([^/]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * Parse a WebFinger `resource` parameter.
 *
 * Peers use both `acct:user@domain` and the URL form
 * (`https://domain/users/user` or `https://domain/@user`). Only resources
 * that address this instance and this instance's users are accepted.
 */
export function parseWebfingerResource(resource: string, baseUrl: string): { username: string } | null {
  const base = new URL(baseUrl);
  const trimmed = resource.trim();

  const acct = trimmed.match(/^acct:([^@]+)@(.+)$/i);
  if (acct) {
    const [, username, domain] = acct;
    if (!username) return null;
    // The port is not part of the identity of an instance: a local instance
    // is reached as `user@localhost:8788`.
    const host = domain
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .split(':')[0];
    if (host !== base.hostname.toLowerCase()) return null;
    return { username };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.origin !== base.origin) return null;
  const path = parsed.pathname.replace(/\/+$/, '');
  const userMatch = path.match(/^\/(?:api\/)?(?:users|actors)\/([^/]+)$/);
  if (!userMatch) return null;
  return { username: safeDecode(userMatch[1]) };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface ActorUser {
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_key: string | null;
  created_at?: string | null;
}

export interface ActorDocumentInput {
  baseUrl: string;
  user: ActorUser;
  publicKeyPem: string;
}

/**
 * Build the ActivityPub actor document.
 *
 * The document carries every property a peer needs to federate with this
 * account: the collections, the shared inbox, the key and the flags that tell
 * Mastodon and GoToSocial that the account is public and auto-approved.
 */
export function buildActorDocument({ baseUrl, user, publicKeyPem }: ActorDocumentInput): Record<string, unknown> {
  const actor = actorUrl(baseUrl, user.username);
  const collections = actorCollectionUrls(baseUrl, user.username);

  const document: Record<string, unknown> = {
    '@context': [AS2_CONTEXT, SECURITY_CONTEXT],
    id: actor,
    type: 'Person',
    preferredUsername: user.username,
    name: user.display_name || user.username,
    summary: user.bio || '',
    url: profileUrl(baseUrl, user.username),
    inbox: collections.inbox,
    outbox: collections.outbox,
    followers: collections.followers,
    following: collections.following,
    liked: collections.liked,
    featured: collections.featured,
    manuallyApprovesFollowers: false,
    discoverable: true,
    indexable: true,
    published: user.created_at || undefined,
    endpoints: {
      sharedInbox: sharedInboxUrl(baseUrl),
    },
    publicKey: {
      id: actorKeyId(baseUrl, user.username),
      owner: actor,
      publicKeyPem,
    },
  };

  if (user.avatar_key) {
    document.icon = {
      type: 'Image',
      mediaType: 'image/jpeg',
      url: `${baseUrl}/api/images/${user.avatar_key}`,
    };
  }

  return document;
}
