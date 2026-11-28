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

/** Compact/relative spellings peers use for the same collection. */
const PUBLIC_ALIASES = new Set([PUBLIC_COLLECTION, 'Public', 'as:Public']);

/**
 * True when an audience entry names the Public collection.
 *
 * ActivityStreams audience fields may hold a string, a Link/Object with `id`
 * or `href`, or an array of those. All three shapes (and the three common
 * spellings of Public) must be treated the same, otherwise a peer can make a
 * private Note look local-only by changing its representation.
 */
export function isPublicAddress(value: unknown): boolean {
  if (typeof value === 'string') return PUBLIC_ALIASES.has(value.trim());
  if (Array.isArray(value)) return value.some(isPublicAddress);
  if (value && typeof value === 'object') {
    const entry = value as { id?: unknown; href?: unknown };
    return isPublicAddress(entry.id) || isPublicAddress(entry.href);
  }
  return false;
}

/** Extract string addresses from string/Object/Link audience entries. */
export function audienceEntries(values: unknown): string[] {
  const entries: unknown[] = Array.isArray(values) ? values : values === null || values === undefined ? [] : [values];
  const found = new Set<string>();
  for (const entry of entries) {
    if (typeof entry === 'string') {
      found.add(entry);
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as { id?: unknown; href?: unknown };
    if (typeof record.id === 'string') found.add(record.id);
    if (typeof record.href === 'string') found.add(record.href);
  }
  return [...found];
}

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
