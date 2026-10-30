type MediaEnv = { DB: D1Database; BUCKET?: R2Bucket };

// Scheduled Worker invocations have a bounded execution lifetime. Waiting a
// full day before reclaiming a crashed claim is far longer than that lifetime,
// so an old invocation cannot delete a key after the claim is released.
export async function reapProfileMedia(env: MediaEnv): Promise<number> {
  if (!env.BUCKET) throw new Error('Profile media bucket unavailable');
  await env.DB.prepare(
    "UPDATE profile_media_deletion_outbox SET claim_token = NULL, claimed_at = NULL WHERE claim_token IS NOT NULL AND claimed_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')",
  ).run();
  const rows = await env.DB.prepare(
    'SELECT object_key FROM profile_media_deletion_outbox WHERE claim_token IS NULL ORDER BY last_checked, object_key LIMIT 20',
  ).all<{ object_key: string }>();
  let deleted = 0;
  for (const row of rows.results ?? []) {
    const token = crypto.randomUUID();
    const claim = await env.DB.prepare(
      "UPDATE profile_media_deletion_outbox SET claim_token = ?, claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE object_key = ? AND claim_token IS NULL",
    )
      .bind(token, row.object_key)
      .run();
    if (claim.meta.changes !== 1) continue;
    try {
      await env.BUCKET.delete(row.object_key);
      await env.DB.prepare('DELETE FROM profile_media_deletion_outbox WHERE object_key = ? AND claim_token = ?')
        .bind(row.object_key, token)
        .run();
      deleted++;
    } catch {
      await env.DB.prepare(
        "UPDATE profile_media_deletion_outbox SET claim_token = NULL, claimed_at = NULL, last_checked = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE object_key = ? AND claim_token = ?",
      )
        .bind(row.object_key, token)
        .run();
    }
  }
  return deleted;
}
