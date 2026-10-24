import { isImageKey } from './crowd.ts';

interface ReviewPost {
  id: string;
  attachments?: Array<{ r2_key: string; kind: string }>;
}

interface ReviewRow {
  id: string;
  gif_key: string | null;
  payload_key: string | null;
  swf_key: string | null;
  hashtags: string | null;
  media_key: string | null;
  status: string | null;
  task_id: string | null;
  ai_passed: number | null;
  content_sha: string | null;
  sha256: string | null;
  file_status: string | null;
}

/** A badge vouches only for all current supported images, with a recorded successful verdict. */
export async function enrichPostsWithAiCheck<T extends ReviewPost>(posts: T[], db: D1Database): Promise<void> {
  for (const post of posts) (post as Record<string, unknown>).ai_checked = false;
  if (!posts.length) return;
  try {
    const result = await db
      .prepare(`
      SELECT p.id, p.gif_key, p.payload_key, p.swf_key, p.hashtags,
        s.media_key, s.status, s.task_id, s.ai_passed, s.content_sha,
        f.sha256, f.status AS file_status
      FROM posts p
      LEFT JOIN post_nsfw_scans s ON s.post_id = p.id
      LEFT JOIN file_scans f ON f.r2_key = s.media_key
      WHERE p.id IN (${posts.map(() => '?').join(',')})
    `)
      .bind(...posts.map((post) => post.id))
      .all<ReviewRow>();
    const byPost = new Map<string, ReviewRow[]>();
    for (const row of result.results ?? []) {
      const rows = byPost.get(row.id) ?? [];
      rows.push(row);
      byPost.set(row.id, rows);
    }
    for (const post of posts) {
      const rows = byPost.get(post.id) ?? [];
      const info = rows[0];
      if (!info || info.payload_key || info.swf_key) continue;
      if (info.gif_key && !isImageKey(info.gif_key)) continue;
      if (post.attachments?.some((a) => a.kind !== 'image' || !isImageKey(a.r2_key))) continue;
      const tags: unknown = JSON.parse(info.hashtags || '[]');
      if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string' || /^(nsfw|r18)$/i.test(t))) continue;
      const keys = new Set([...(info.gif_key ? [info.gif_key] : []), ...(post.attachments ?? []).map((a) => a.r2_key)]);
      if (!keys.size) continue;
      const passed = [...keys].every((key) =>
        rows.some(
          (row) =>
            row.media_key === key &&
            row.status === 'done' &&
            row.ai_passed === 1 &&
            row.task_id &&
            row.content_sha &&
            row.content_sha === row.sha256 &&
            row.file_status === 'clean',
        ),
      );
      (post as Record<string, unknown>).ai_checked = passed;
    }
  } catch (error) {
    // An unavailable table or pre-migration database must never produce a badge.
    console.error('Failed to enrich AI review status:', error);
  }
}
