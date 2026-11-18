/// <reference types="@cloudflare/workers-types" />

import type { RemoteActor } from './fetch.ts';

/**
 * Remember a resolved remote actor document.
 *
 * Cached actors are what the feed decorator uses to show a display name and
 * avatar, and what `/api/remote/actors/:domain/:username` uses to resolve a
 * profile. Importing an outbox has to populate this row even though no
 * delivery went through the inbox.
 */
export async function cacheRemoteActor(db: D1Database, actor: RemoteActor): Promise<void> {
  await db
    .prepare(`
      INSERT INTO ap_actors (actor_url, inbox_url, shared_inbox_url, public_key_pem, preferred_username, display_name, icon_url, domain, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(actor_url) DO UPDATE SET
        inbox_url = excluded.inbox_url,
        shared_inbox_url = excluded.shared_inbox_url,
        public_key_pem = excluded.public_key_pem,
        preferred_username = excluded.preferred_username,
        display_name = excluded.display_name,
        icon_url = excluded.icon_url,
        domain = excluded.domain,
        fetched_at = excluded.fetched_at
    `)
    .bind(
      actor.actorUrl,
      actor.inbox,
      actor.sharedInbox,
      actor.publicKeyPem,
      actor.preferredUsername,
      actor.displayName,
      actor.iconUrl,
      actor.domain,
    )
    .run();
}
