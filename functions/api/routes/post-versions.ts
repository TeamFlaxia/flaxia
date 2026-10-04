import { Hono } from 'hono';
import { extractFileFromZip, extractZipToR2 } from '../../../src/lib/wvfs-zip-server';
import { requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const postVersions = new Hono<{ Bindings: Bindings; Variables: Variables }>();

export async function extractGameDescription(
  bucket: R2Bucket,
  db: D1Database,
  payloadKey: string,
  postId: string,
): Promise<void> {
  try {
    const result = await extractFileFromZip(bucket, payloadKey, 'index.html');
    if (!result) return;
    const decoder = new TextDecoder('utf-8');
    const html = decoder.decode(result.data);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    const contentMatch = (attrValue: string): string => {
      const escaped = attrValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const patterns = [
        new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escaped}["']`, 'i'),
        new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escaped}["']`, 'i'),
      ];
      for (const pattern of patterns) {
        const m = html.match(pattern);
        if (m && m[1].trim()) return m[1].trim();
      }
      return '';
    };

    const metaDesc =
      contentMatch('description') || contentMatch('og:description') || contentMatch('twitter:description');
    const gameDescription = metaDesc || title || '';
    if (gameDescription) {
      const cleaned = gameDescription
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned) {
        await db
          .prepare('UPDATE posts SET game_description = ? WHERE id = ?')
          .bind(cleaned.slice(0, 500), postId)
          .run();
      }
    }
  } catch (e) {
    console.error(`Failed to extract game description for post ${postId}:`, e);
  }
}
// GET /api/posts/:id/versions - list archived versions of a game (public)
postVersions.get('/posts/:id/versions', async (c) => {
  try {
    const postId = c.req.param('id');
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const { results } = (await c.env.DB.prepare(
      'SELECT id, version_number, changelog, thumbnail_key, created_at FROM game_versions WHERE post_id = ? ORDER BY version_number DESC',
    )
      .bind(postId)
      .all()) as {
      results: Array<{
        id: string;
        version_number: number;
        changelog: string | null;
        thumbnail_key: string | null;
        created_at: string;
      }>;
    };

    const versions = results.map((r) => ({
      id: r.id,
      versionNumber: r.version_number,
      changelog: r.changelog || null,
      thumbnailKey: r.thumbnail_key || null,
      createdAt: r.created_at,
    }));

    return c.json({ versions });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('List game versions error:', error);
    return c.json({ error: 'Failed to list versions', details: err.message }, 500);
  }
});

// POST /api/posts/:id/versions/prepare - reserve an upload slot for a new version (owner only)
postVersions.post('/posts/:id/versions/prepare', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const postId = c.req.param('id');
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const post = (await c.env.DB.prepare('SELECT id, user_id, payload_key, status FROM posts WHERE id = ?')
      .bind(postId)
      .first()) as { id: string; user_id: string; payload_key: string | null; status: string } | null;

    if (!post) return c.json({ error: 'Post not found' }, 404);
    if (post.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
    if (post.status !== 'published') return c.json({ error: 'Post is not published' }, 400);
    if (
      !post.payload_key ||
      !(
        post.payload_key.startsWith('zip/') ||
        post.payload_key.startsWith('html/') ||
        post.payload_key.startsWith('versions/')
      )
    ) {
      return c.json({ error: 'Only ZIP/HTML5 games can be versioned' }, 400);
    }

    const versionId = crypto.randomUUID();
    const storageKey = `versions/${postId}/${versionId}.zip`;
    const origin = new URL(c.req.url).origin;
    const uploadUrl = `${origin}/api/upload/${storageKey}`;

    return c.json({ postId, versionId, zipUploadUrl: uploadUrl, zipKey: storageKey });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Prepare game version error:', error);
    return c.json({ error: 'Failed to prepare version', details: err.message }, 500);
  }
});

// POST /api/posts/:id/versions/commit - finalize a newly uploaded version (owner only)
postVersions.post('/posts/:id/versions/commit', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const postId = c.req.param('id')!;
    if (!c.env.DB || !c.env.BUCKET) return c.json({ error: 'Database/Storage not available' }, 500);

    const body = (await c.req.json()) as { versionId?: string; changelog?: string };
    if (!body.versionId) return c.json({ error: 'versionId is required' }, 400);

    const post = (await c.env.DB.prepare('SELECT id, user_id, payload_key, status, created_at FROM posts WHERE id = ?')
      .bind(postId)
      .first()) as {
      id: string;
      user_id: string;
      payload_key: string | null;
      status: string;
      created_at: string;
    } | null;

    if (!post || post.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
    if (post.status !== 'published') return c.json({ error: 'Post is not published' }, 400);

    const newKey = `versions/${postId}/${body.versionId}.zip`;
    const head = await c.env.BUCKET.head(newKey);
    if (!head) return c.json({ error: 'Uploaded file not found' }, 400);

    const maxRow = (await c.env.DB.prepare('SELECT MAX(version_number) as m FROM game_versions WHERE post_id = ?')
      .bind(postId)
      .first()) as { m: number | null } | null;
    const max = maxRow?.m ?? 0;

    const now = new Date().toISOString();
    const changelog = typeof body.changelog === 'string' ? body.changelog.trim().slice(0, 2000) || null : null;

    // Archive the original release as v1 the first time a game is versioned,
    // so players can still roll back to it after an update.
    const archiveOriginal = max === 0 && !!post.payload_key && post.payload_key !== newKey;
    if (archiveOriginal) {
      await c.env.DB.prepare(
        'INSERT INTO game_versions (id, post_id, version_number, payload_key, thumbnail_key, changelog, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(crypto.randomUUID(), postId, 1, post.payload_key, null, null, user.id, post.created_at)
        .run();
    }

    // When the original was archived as v1, the new release becomes v2.
    const newVersionNumber = archiveOriginal ? 2 : max + 1;
    await c.env.DB.prepare(
      'INSERT INTO game_versions (id, post_id, version_number, payload_key, thumbnail_key, changelog, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(body.versionId, postId, newVersionNumber, newKey, null, changelog, user.id, now)
      .run();

    await c.env.DB.prepare('UPDATE posts SET payload_key = ?, edited_at = ?, created_at = ? WHERE id = ?')
      .bind(newKey, now, now, postId)
      .run();

    const execCtx = (c as unknown as { executionCtx?: { waitUntil: (p: Promise<unknown>) => void } }).executionCtx;
    if (execCtx?.waitUntil) {
      const bucket = c.env.BUCKET;
      const db = c.env.DB;
      const versionId = body.versionId ?? null;
      if (bucket && db) {
        execCtx.waitUntil(
          (async () => {
            try {
              // Clear old extraction manifests so the new version's files
              // overwrite the stale ones instead of being silently skipped.
              await Promise.all([
                bucket.delete(`wvfs/${postId}/.wvfs-manifest`),
                versionId ? bucket.delete(`wvfs/${postId}/${versionId}/.wvfs-manifest`) : Promise.resolve(),
              ]);

              // Extract to the default (non-versioned) path so the latest version
              // serves from the plain /api/wvfs-zip/<postId> URL, and to the
              // versioned path so ?v=<id> also resolves to it.
              await extractZipToR2(bucket, newKey, postId);
              if (versionId) {
                await extractZipToR2(bucket, newKey, postId, versionId);
              }
            } catch (e) {
              console.error('Background ZIP extraction failed for version:', e);
            }
            try {
              await extractGameDescription(bucket, db, newKey, postId);
            } catch (e) {
              console.error('Background game description extraction failed:', e);
            }
          })(),
        );
      }
    }

    return c.json({ ok: true, versionId: body.versionId, versionNumber: newVersionNumber });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Commit game version error:', error);
    return c.json({ error: 'Failed to commit version', details: err.message }, 500);
  }
});

export default postVersions;
