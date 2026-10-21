// Reap abandoned uploads: `prepare` mints a `pending` post row (and an R2
// object) that only `commit` publishes. Users who never commit would
// otherwise bloat D1 and R2 without bound. The daily cron calls this.
export async function reapStalePendingPosts(env: { DB: D1Database; BUCKET?: R2Bucket }): Promise<number> {
  if (!env.DB) return 0;
  // created_at is stored as ISO-8601 (toISOString), while datetime('now')
  // renders 'YYYY-MM-DD HH:MM:SS' — the two never compare correctly as
  // strings. Format the cutoff as ISO too so lexicographic order works.
  const rows = (
    await env.DB.prepare(
      `SELECT id, gif_key, payload_key, swf_key, thumbnail_key FROM posts
       WHERE status = 'pending' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours') LIMIT 100`,
    ).all<{
      id: string;
      gif_key: string | null;
      payload_key: string | null;
      swf_key: string | null;
      thumbnail_key: string | null;
    }>()
  ).results;
  if (!rows || rows.length === 0) return 0;

  // Best-effort R2 cleanup first; the DB delete below is what guarantees the
  // row can never be committed afterwards (commit requires status='pending').
  if (env.BUCKET) {
    const keys = rows.flatMap((r) => [r.gif_key, r.payload_key, r.swf_key, r.thumbnail_key]);
    await Promise.all(
      [...new Set(keys.filter((k): k is string => typeof k === 'string' && k.length > 0))].map((k) =>
        env.BUCKET!.delete(k).catch(() => {}),
      ),
    );
  }
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  await env.DB.prepare(`DELETE FROM posts WHERE id IN (${placeholders}) AND status = 'pending'`)
    .bind(...ids)
    .run();
  return ids.length;
}
