/// <reference types="@cloudflare/workers-types" />

/**
 * JSON-LD context and media type constants for ActivityPub.
 *
 * Every document we publish uses the same two contexts: ActivityStreams for
 * the object model and the security vocabulary for `publicKey`. Peers that
 * only understand plain ActivityStreams ignore the second entry.
 */
export const AS2_CONTEXT = 'https://www.w3.org/ns/activitystreams';
export const SECURITY_CONTEXT = 'https://w3id.org/security/v1';

/** The canonical "public" collection every federated timeline understands. */
export const PUBLIC_COLLECTION = 'https://www.w3.org/ns/activitystreams#Public';

/** Media type used for actors, activities and collections. */
export const ACTIVITY_JSON = 'application/activity+json';

/** Alternative media type some peers ask for explicitly. */
export const LD_JSON = 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

/** The context array used by actors (needs the security vocabulary). */
export function actorContext(): string[] {
  return [AS2_CONTEXT, SECURITY_CONTEXT];
}

/** The context array used by activities and objects. */
export function activityContext(): string[] {
  return [AS2_CONTEXT];
}

/**
 * Pick the media type to answer with.
 *
 * Peers send `Accept: application/activity+json, application/ld+json` (both
 * Mastodon and GoToSocial do). Answering with the activity+json profile keeps
 * the payload readable for implementations that only parse JSON-LD, so the
 * ld+json profile is only used when the peer explicitly asks for it.
 */
export function activityContentType(accept: string | null | undefined): string {
  const header = (accept ?? '').toLowerCase();
  if (!header.includes('application/ld+json') && header.includes('application/activity+json')) {
    return ACTIVITY_JSON;
  }
  if (header.includes('application/ld+json') && !header.includes('application/activity+json')) {
    return LD_JSON;
  }
  return ACTIVITY_JSON;
}
