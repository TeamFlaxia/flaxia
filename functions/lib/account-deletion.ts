interface PostRowWithKeys {
  id: string;
  gif_key: string | null;
  payload_key: string | null;
  swf_key: string | null;
  thumbnail_key: string | null;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function chunkIds(ids: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/**
 * Deletes a user account along with all related data: posts (and their reply
 * trees), notifications, follows, profiles, and the associated files stored in R2.
 *
 * The deletes run in a single D1 batch so they succeed atomically, and child
 * rows are removed before their FK parents to avoid constraint violations.
 */
export async function deleteAccount(
  env: Env,
  userId: string,
  authOperationHash?: string,
  direct = false,
  forceLinked = false,
): Promise<void> {
  const db = env.DB;
  const deletionJobs = direct ? 'flaxia_direct_deletion_jobs' : 'flaxia_auth_deletion_jobs';

  // Collect the user's own posts plus every post in their reply trees. Deleting
  // the whole tree avoids orphaned parent_id/root_id references.
  const treeRows = await db
    .prepare(
      `WITH RECURSIVE tree(id, gif_key, payload_key, swf_key, thumbnail_key) AS (
         SELECT id, gif_key, payload_key, swf_key, thumbnail_key
         FROM posts WHERE user_id = ?
         UNION ALL
         SELECT p.id, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key
         FROM posts p JOIN tree t ON p.parent_id = t.id
       )
       SELECT id, gif_key, payload_key, swf_key, thumbnail_key FROM tree`,
    )
    .bind(userId)
    .all<PostRowWithKeys>();

  const postIds = (treeRows.results || []).map((r: PostRowWithKeys) => r.id);

  // Pre-built statements for the atomic batch
  const statements: D1PreparedStatement[] = [];
  // Read profile keys inside the write transaction so concurrent profile
  // updates cannot leave a newly attached object behind.
  for (const column of ['avatar_key', 'header_key'] as const) {
    statements.push(
      db
        .prepare(`INSERT OR IGNORE INTO profile_media_deletion_outbox (object_key)
      SELECT u.${column} FROM users u WHERE u.id = ? AND u.${column} IS NOT NULL AND u.${column} <> ''
      AND NOT EXISTS (SELECT 1 FROM users other WHERE other.id != u.id AND (other.avatar_key = u.${column} OR other.header_key = u.${column}))`)
        .bind(userId),
    );
  }
  if (authOperationHash) {
    // A missing approved job produces NULL and aborts the entire transaction.
    statements.push(
      db
        .prepare(
          `INSERT INTO flaxia_auth_deletion_receipts (operation_hash, completed_at) VALUES ((SELECT operation_hash FROM ${deletionJobs} WHERE operation_hash = ? AND user_id = ? AND state = 'approved'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(operation_hash) DO NOTHING`,
        )
        .bind(authOperationHash, userId),
    );
  }

  // An unfinished email change reserves the address and its guard would abort
  // the user delete. The Auth identity is already gone in coordinated flows,
  // so the reservation cannot be completed and must be released here.
  statements.push(db.prepare('DELETE FROM flaxia_direct_email_changes WHERE user_id = ?').bind(userId));

  // Admin deletion happens after the Auth account is gone, so every local
  // transition row is meaningless and its guard must be cleared before the
  // user or vault rows are touched. Coordinated (self-service) deletion keeps
  // its receipt protocol and is expected to be free of active transition rows.
  if (forceLinked) {
    statements.push(
      db.prepare('DELETE FROM flaxia_auth_purge_in_progress WHERE user_id = ?').bind(userId),
      db.prepare('DELETE FROM flaxia_auth_provisioning WHERE user_id = ?').bind(userId),
      db.prepare('DELETE FROM flaxia_auth_credential_jobs WHERE user_id = ?').bind(userId),
      db.prepare('DELETE FROM flaxia_direct_vault_changes WHERE user_id = ?').bind(userId),
      db.prepare('DELETE FROM flaxia_auth_deletion_jobs WHERE user_id = ?').bind(userId),
      db.prepare('DELETE FROM flaxia_direct_deletion_jobs WHERE user_id = ?').bind(userId),
      db.prepare('DELETE FROM flaxia_auth_links WHERE user_id = ?').bind(userId),
    );
  }

  // --- Row-level data that directly references the user ---
  statements.push(db.prepare('DELETE FROM ap_following WHERE local_user_id = ?').bind(userId));
  statements.push(db.prepare('DELETE FROM follows WHERE follower_id = ? OR followee_id = ?').bind(userId, userId));

  // --- Notifications / interactions ---
  statements.push(db.prepare('DELETE FROM notifications WHERE user_id = ? OR actor_id = ?').bind(userId, userId));
  statements.push(db.prepare('DELETE FROM freshs WHERE user_id = ?').bind(userId));
  statements.push(db.prepare('DELETE FROM reports WHERE user_id = ?').bind(userId));
  statements.push(db.prepare('DELETE FROM bookmarks WHERE user_id = ?').bind(userId));
  statements.push(db.prepare('DELETE FROM likes WHERE user_id = ?').bind(userId));
  statements.push(db.prepare('DELETE FROM shares WHERE user_id = ?').bind(userId));
  statements.push(db.prepare('DELETE FROM poll_votes WHERE user_id = ?').bind(userId));
  statements.push(db.prepare('DELETE FROM counter_notifications WHERE user_id = ?').bind(userId));

  // --- Sessions, devices, push subscriptions ---
  statements.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId));
  // device_tokens was removed in migration 0035 (Web Push replaced FCM).
  statements.push(db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(userId));

  // --- Personal vault: wrapped key material and ciphertext only (docs/e2ee.md) ---
  statements.push(db.prepare('DELETE FROM vault_items WHERE user_id = ?').bind(userId));
  statements.push(db.prepare('DELETE FROM device_keys WHERE user_id = ?').bind(userId));
  statements.push(db.prepare('DELETE FROM vault_keys WHERE user_id = ?').bind(userId));

  // --- User preference / recommender state ---
  statements.push(db.prepare('DELETE FROM user_profiles WHERE user_id = ?').bind(userId));
  statements.push(db.prepare('DELETE FROM bandit_state WHERE user_id = ?').bind(userId));
  statements.push(db.prepare('DELETE FROM user_game_plays WHERE user_id = ?').bind(userId));
  statements.push(db.prepare('DELETE FROM arcade_events WHERE user_id = ?').bind(userId));

  // Messaging and calls were removed by migration 0089; no related rows remain
  // to clean up when deleting a user.

  // --- Billing + custom stamps: bare FKs to users (#131) ---
  statements.push(db.prepare('DELETE FROM transactions WHERE user_id = ?').bind(userId));
  statements.push(db.prepare('DELETE FROM subscriptions WHERE user_id = ?').bind(userId));
  statements.push(db.prepare('DELETE FROM custom_stamps WHERE user_id = ?').bind(userId));

  // --- Multiplayer ---
  statements.push(db.prepare('DELETE FROM multiplayer_room_participants WHERE user_id = ?').bind(userId));
  statements.push(db.prepare('DELETE FROM multiplayer_scores WHERE user_id = ?').bind(userId));
  statements.push(
    db.prepare('DELETE FROM multiplayer_invites WHERE from_user_id = ? OR to_user_id = ?').bind(userId, userId),
  );
  statements.push(db.prepare('DELETE FROM multiplayer_rooms WHERE host_id = ?').bind(userId));

  // --- Post-related tables (no FK cascade to posts) ---
  for (const ids of chunkIds(postIds, 400)) {
    const ph = placeholders(ids.length);
    statements.push(db.prepare(`DELETE FROM post_embeddings WHERE post_id IN (${ph})`).bind(...ids));
    statements.push(db.prepare(`DELETE FROM admin_alerts WHERE post_id IN (${ph})`).bind(...ids));
    statements.push(db.prepare(`DELETE FROM arcade_events WHERE post_id IN (${ph})`).bind(...ids));
    statements.push(db.prepare(`DELETE FROM reports WHERE post_id IN (${ph})`).bind(...ids));
    statements.push(db.prepare(`DELETE FROM notifications WHERE post_id IN (${ph})`).bind(...ids));
  }

  // --- The user's posts are intentionally PRESERVED (public content survives
  // account deletion). Only the user row and personal data are removed. ---

  // The receipt, guard removal and final deletion commit together. If the
  // response is lost, the opaque operation token can safely be retried.
  if (authOperationHash) {
    statements.push(
      db
        .prepare(
          `DELETE FROM flaxia_auth_provisioning WHERE user_id = ? AND EXISTS (SELECT 1 FROM ${deletionJobs} WHERE operation_hash = ? AND user_id = ? AND state = 'approved')`,
        )
        .bind(userId, authOperationHash, userId),
    );
    statements.push(
      db
        .prepare(
          `DELETE FROM flaxia_auth_links WHERE user_id = ? AND EXISTS (SELECT 1 FROM ${deletionJobs} WHERE operation_hash = ? AND user_id = ? AND state = 'approved')`,
        )
        .bind(userId, authOperationHash, userId),
    );
    statements.push(
      db
        .prepare(`DELETE FROM ${deletionJobs} WHERE operation_hash = ? AND user_id = ? AND state = 'approved'`)
        .bind(authOperationHash, userId),
    );
    statements.push(
      db
        .prepare(
          'DELETE FROM users WHERE id = ? AND EXISTS (SELECT 1 FROM flaxia_auth_deletion_receipts WHERE operation_hash = ?)',
        )
        .bind(userId, authOperationHash),
    );
  } else {
    statements.push(db.prepare('DELETE FROM users WHERE id = ?').bind(userId));
  }

  await db.batch(statements);

  // The durable outbox is drained by the scheduled worker. A single claimed
  // deletion at a time prevents a late duplicate R2 delete from removing a
  // newly reused content-addressed key.
}
