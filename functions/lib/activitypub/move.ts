import { audienceEntries } from './context.ts';
import { type FederationEnv, fetchFederationDocument } from './fetch.ts';
import { actorSignOptions } from './keys.ts';

type MoveEnv = FederationEnv & { DB: D1Database; BASE_URL: string };

function objectOf(activity: Record<string, unknown>): Record<string, unknown> | null {
  const object = activity.object;
  if (typeof object === 'string') return { id: object };
  if (typeof object === 'object' && object !== null) return object as Record<string, unknown>;
  return null;
}

/** Compare actor URLs without a trailing slash or fragment. */
function canonicalActorUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

/** True when the target actor document acknowledges the old identity. */
function targetBackReferencesSource(document: Record<string, unknown>, source: string): boolean {
  const expected = canonicalActorUrl(source);
  for (const field of ['movedFrom', 'alsoKnownAs']) {
    for (const value of audienceEntries(document[field])) {
      if (canonicalActorUrl(value) === expected) return true;
    }
  }
  return false;
}

export async function handleMove(
  env: MoveEnv,
  activity: Record<string, unknown>,
  actorId: string,
  username: string,
): Promise<void> {
  const object = objectOf(activity);
  // Mastodon emits `target`; other peers use `movedTo` on the object.
  const movedTo =
    typeof activity.target === 'string' ? activity.target : typeof object?.movedTo === 'string' ? object.movedTo : null;
  if (!movedTo) return;
  if (typeof object?.id === 'string' && object.id !== actorId) return;
  let target: URL;
  try {
    target = new URL(movedTo);
    new URL(actorId);
  } catch {
    return;
  }
  // The target may live on another instance (Mastodon moves are cross-instance),
  // but it must be a public web URL. The SSRF guard below validates every hop
  // and `sameOrigin` prevents a redirect from serving another origin's actor.
  if (!['http:', 'https:'].includes(target.protocol)) return;

  const response = await fetchFederationDocument(movedTo, env, {
    sameOrigin: true,
    ...(await actorSignOptions(env.DB, env.BASE_URL, username)),
  });
  if (!response?.ok) return;
  let document: Record<string, unknown>;
  try {
    document = (await response.json()) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return;
  // The document must be the target actor itself, not just something hosted
  // on the same origin (a multi-user instance can have many actors).
  const documentId = typeof document.id === 'string' ? document.id : null;
  if (documentId && canonicalActorUrl(documentId) !== canonicalActorUrl(movedTo)) return;
  if (!targetBackReferencesSource(document, actorId)) {
    console.error('Ignoring Move whose target does not reference the source actor:', actorId, '->', movedTo);
    return;
  }

  await env.DB.prepare(
    `UPDATE ap_actors SET moved_to = ?, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE actor_url = ?`,
  )
    .bind(movedTo, actorId)
    .run();
  console.log('Remote actor moved:', actorId, '->', movedTo);
}
