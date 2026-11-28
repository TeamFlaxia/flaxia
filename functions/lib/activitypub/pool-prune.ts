import type { Db } from '../ports/index.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function prunePool(env: { DB: Db }, olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * DAY_MS).toISOString();
  // Only rows the pool created are eligible. Notes received from actors a
  // local user follows (and any local replies to them) are not pool content,
  // even though they look remote in the posts table. Date the cutoff from the
  // last discovery, not the post: refreshing a popular old post must keep it.
  const stalePoolPost = `posts.ap_object_id IS NOT NULL AND posts.user_id = ''
    AND EXISTS (SELECT 1 FROM ap_pool_metrics pm WHERE pm.post_id = posts.id AND pm.fetched_at < ?)`;
  // Capture the ids before deleting metrics: the marker itself lives there.
  const stale = await env.DB.prepare(`SELECT posts.id FROM posts WHERE ${stalePoolPost}`)
    .bind(cutoff)
    .all<{ id: string }>();
  const ids = (stale.results ?? []).map((row) => row.id);
  const orphanMetrics = env.DB.prepare('DELETE FROM ap_pool_metrics WHERE post_id NOT IN (SELECT id FROM posts)');
  if (ids.length === 0) {
    const [orphans] = await env.DB.batch([orphanMetrics]);
    return (orphans as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0;
  }
  // A single JSON bind avoids D1's bind-parameter limit on a large prune.
  const idList = JSON.stringify(ids);
  const results = await env.DB.batch([
    orphanMetrics,
    // All three self-references are plain REFERENCES with no ON DELETE action:
    // a local reply may point at the stale post through root_id even when its
    // parent survives, and a local post may quote it. Detach every reference
    // or the DELETE below trips a foreign key and rolls back the whole batch.
    env.DB.prepare(
      `UPDATE posts SET parent_id = NULL, root_id = NULL
       WHERE parent_id IN (SELECT value FROM json_each(?)) OR root_id IN (SELECT value FROM json_each(?))`,
    ).bind(idList, idList),
    env.DB.prepare(
      'UPDATE posts SET quoted_post_id = NULL WHERE quoted_post_id IN (SELECT value FROM json_each(?))',
    ).bind(idList),
    env.DB.prepare('DELETE FROM ap_pool_metrics WHERE post_id IN (SELECT value FROM json_each(?))').bind(idList),
    env.DB.prepare('DELETE FROM posts WHERE id IN (SELECT value FROM json_each(?))').bind(idList),
  ]);
  const changes = (index: number): number =>
    (results[index] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0;
  return changes(0) + changes(3) + changes(4);
}
