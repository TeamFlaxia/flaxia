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
export async function deleteAccount(env: Env, userId: string): Promise<void> {
  const db = env.DB;

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

  // Collect R2 keys for deferred deletion after the DB transaction commits.
  // Posts (and their attachments) are intentionally kept so public content
  // survives account deletion; only the avatar is removed.
  const fileKeys = new Set<string>();

  const userRow = await db.prepare('SELECT avatar_key FROM users WHERE id = ?').bind(userId).first<{
    avatar_key: string | null;
  }>();
  if (userRow?.avatar_key) fileKeys.add(userRow.avatar_key);

  // Pre-built statements for the atomic batch
  const statements: D1PreparedStatement[] = [];

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

  // --- The user row itself (last: everything above references it) ---
  statements.push(db.prepare('DELETE FROM users WHERE id = ?').bind(userId));

  await db.batch(statements);

  // Best-effort R2 cleanup after the DB transaction has committed
  if (env.BUCKET && fileKeys.size > 0) {
    const keys = Array.from(fileKeys);
    for (const key of keys) {
      try {
        await env.BUCKET.delete(key);
      } catch (error: unknown) {
        console.error(`Failed to delete R2 object ${key}:`, error);
      }
    }
  }
}
