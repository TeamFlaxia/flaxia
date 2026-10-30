import { stripPostColors } from '../../src/lib/post-colors.ts';

/** SHA-256 of the exact text sent for embedding, also signed into the callback URL. */
export async function postTextSha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Enrich all post types, including text-only and image posts, with actual indexing completion. */
export async function enrichPostsWithAiIndex<T extends { id: string }>(posts: T[], db: D1Database): Promise<void> {
  for (const post of posts) (post as Record<string, unknown>).ai_indexed = false;
  if (!posts.length) return;
  try {
    const result = await db
      .prepare(`
      SELECT p.id, p.text, e.source_sha
      FROM posts p JOIN post_embeddings e ON e.post_id = p.id
      WHERE p.id IN (${posts.map(() => '?').join(',')})
    `)
      .bind(...posts.map((post) => post.id))
      .all<{ id: string; text: string; source_sha: string | null }>();
    const indexed = new Set<string>();
    await Promise.all(
      (result.results ?? []).map(async (row) => {
        if (
          typeof row.text === 'string' &&
          row.source_sha &&
          row.source_sha === (await postTextSha(stripPostColors(row.text)))
        ) {
          indexed.add(row.id);
        }
      }),
    );
    for (const post of posts) (post as Record<string, unknown>).ai_indexed = indexed.has(post.id);
  } catch (error) {
    console.error('Failed to enrich AI index status:', error);
  }
}
