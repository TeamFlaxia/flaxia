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
