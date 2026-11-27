// Resolve an archived game release to its R2 payload key.
//
// A version id is only a lookup key: never interpolate user input into an R2
// object name. Invalid or unknown ids are reported as "not found" by callers.
const VERSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type VersionKeyResult = { ok: true; key: string | null } | { ok: false; status: 404 | 500 };

// Structural type: the adapter boundary owns the concrete database type.
interface VersionDb {
  prepare(query: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null> };
  };
}

export async function resolveVersionPayloadKey(
  db: VersionDb | undefined,
  postId: string,
  versionId: string | undefined,
): Promise<VersionKeyResult> {
  if (!versionId) return { ok: true, key: null };
  if (!VERSION_ID_PATTERN.test(versionId)) return { ok: false, status: 404 };
  if (!db) return { ok: false, status: 500 };
  const version = await db
    .prepare('SELECT payload_key FROM game_versions WHERE post_id = ? AND id = ?')
    .bind(postId, versionId)
    .first<{ payload_key: string }>();
  if (!version || typeof version.payload_key !== 'string') return { ok: false, status: 404 };
  return { ok: true, key: version.payload_key };
}

/**
 * Latest release key for a versioned game. `posts.payload_key` is the
 * canonical pointer maintained by the version-commit route; callers that used
 * to fall straight back to `zip/<postId>.zip` were serving the initial upload
 * forever after the first update.
 */
export async function resolveLatestGamePayloadKey(db: VersionDb | undefined, postId: string): Promise<string | null> {
  if (!db) return null;
  const row = await db
    .prepare('SELECT payload_key FROM posts WHERE id = ?')
    .bind(postId)
    .first<{ payload_key: string }>();
  const key = row?.payload_key;
  if (!key || typeof key !== 'string') return null;
  const escapedPostId = postId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^versions/${escapedPostId}/[A-Za-z0-9_-]{1,128}\\.zip$`).test(key) ? key : null;
}
