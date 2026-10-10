// A pending post may own R2 objects at attachment keys which are not recorded
// on its DB row until commit. Reap both those prefixes and legacy single-file
// keys before removing the row, otherwise uploaded bytes become orphans.
export async function reapStalePendingPosts(env: { DB: D1Database; BUCKET?: R2Bucket }): Promise<number> {
  if (!env.DB || !env.BUCKET) {
    // Never discard the only inventory of a pending upload when R2 cleanup
    // cannot run. Retaining the DB row allows the next cron to retry safely.
    return 0;
  }

  const rows =
    (
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
    ).results ?? [];

  let reaped = 0;
  for (const row of rows) {
    try {
      const keys = new Set(
        [row.gif_key, row.payload_key, row.swf_key, row.thumbnail_key].filter(
          (key): key is string => typeof key === 'string' && key.length > 0,
        ),
      );
      // Include all image/audio/video/document slots even if commit never
      // persisted a post_attachments row.
      for (const prefix of ['gif', 'audio', 'video', 'docs']) {
        let cursor: string | undefined;
        do {
          const page = await env.BUCKET.list({ prefix: `${prefix}/${row.id}/`, cursor });
          for (const object of page.objects) keys.add(object.key);
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      }
      // R2 accepts up to 1000 keys per bulk delete call.
      const allKeys = [...keys];
      for (let i = 0; i < allKeys.length; i += 1000) {
        await env.BUCKET.delete(allKeys.slice(i, i + 1000));
      }
      const deleted = await env.DB.prepare("DELETE FROM posts WHERE id = ? AND status = 'pending'").bind(row.id).run();
      if (deleted.meta.changes > 0) reaped++;
    } catch (error) {
      // Leave the row for a retry; a failed cleanup must not leak R2 bytes.
      console.error('Failed to reap pending post', row.id, error);
    }
  }
  return reaped;
}
