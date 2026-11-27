// Existing games predate posts.game_title. Extract their index.html <title>
// in small batches so Arcade titles change without a manual admin request.
import { extractGameDescription } from './game-metadata.ts';

const BATCH_SIZE = 25;
const CACHE_KINDS = ['recent', 'trending'] as const;
const CACHE_LIMITS = [3, 10, 20, 30, 50, 120, 200];

export async function backfillGameTitles(db: D1Database, bucket: R2Bucket, cache?: KVNamespace): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT id, payload_key FROM posts
       WHERE game_title IS NULL AND payload_key IS NOT NULL
         AND (lower(payload_key) LIKE '%.zip' OR lower(payload_key) LIKE '%.html')
         AND status = 'published' AND hidden = 0 AND parent_id IS NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(BATCH_SIZE)
    .all<{ id: string; payload_key: string }>();
  if (!results.length) return 0;

  for (const row of results) {
    await extractGameDescription(bucket, db, row.payload_key, row.id);
  }
  console.log(`Backfilled HTML titles for ${results.length} games`);

  // The feed's first page is KV-cached for 300s; refresh it so cards update.
  if (cache) {
    await Promise.all(
      CACHE_KINDS.flatMap((kind) => CACHE_LIMITS.map((limit) => cache.delete(`games:${kind}:${limit}:first`))),
    );
  }
  return results.length;
}
