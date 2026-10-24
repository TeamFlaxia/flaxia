import type { Context } from 'hono';
import { isKeyBlocked } from '../../functions/lib/scan/db.ts';
import { createWvfsGameUrl } from './wvfs-game-url.ts';

type Bindings = { BUCKET: R2Bucket; DB: D1Database; CACHE?: KVNamespace };
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BYTES = 25 * 1024 * 1024;

/** Public posts only. Never cache an authorization/publication decision. */
export async function servePublicLoader<E extends { Bindings: Bindings }>(c: Context<E>): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  const postId = c.req.param('postId');
  const requestedVersion = c.req.query('v');
  if (!postId || !ID.test(postId) || (requestedVersion !== undefined && !ID.test(requestedVersion))) {
    return c.text('Not found', 404);
  }
  try {
    const post = await c.env.DB.prepare('SELECT payload_key, hidden, status FROM posts WHERE id = ?')
      .bind(postId)
      .first<{ payload_key: string; hidden: number; status: string }>();
    if (!post || post.hidden || post.status !== 'published') return c.text('Not found', 404);
    let key = post.payload_key;
    let version = requestedVersion;
    if (version) {
      const row = await c.env.DB.prepare('SELECT payload_key FROM game_versions WHERE post_id = ? AND id = ?')
        .bind(postId, version)
        .first<{ payload_key: string }>();
      if (!row) return c.text('Not found', 404);
      key = row.payload_key;
    }
    const match = key?.match(new RegExp(`^versions/${postId}/([A-Za-z0-9_-]{1,128})\\.zip$`));
    if (match) {
      if (version && version !== match[1]) return c.text('Not found', 404);
      version = match[1];
    } else if (![`zip/${postId}.zip`, `payload/${postId}.zip`, `html/${postId}.html`].includes(key) || version)
      return c.text('Not found', 404);
    const format = key.endsWith('.html') ? 'html' : 'zip';
    if (await isKeyBlocked(c.env.CACHE, key, c.env.DB)) return c.text('Not found', 404);
    const object = await c.env.BUCKET.head(key);
    if (!object) return c.text('Not found', 404);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(['public-v1', postId, version, key, object.etag])),
    );
    const revision = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const url = new URL(c.req.url);
    if (url.pathname.endsWith('/archive')) {
      if (c.req.query('revision') !== revision) return c.text('Game changed; restart the loader', 409);
      if (object.size > MAX_BYTES) return c.text('Archive too large for local cache', 413);
      const archive = await c.env.BUCKET.get(key, { onlyIf: { etagMatches: object.etag } });
      if (!archive || !('body' in archive) || !archive.body) return c.text('Game changed; restart the loader', 409);
      return new Response(archive.body, {
        headers: {
          // Downloads are data, never executable HTML on the authenticated origin.
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment',
          'Content-Security-Policy': "sandbox; default-src 'none'",
          'Content-Length': String(archive.size),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    const archiveUrl = new URL(`/api/game-loader/${postId}/archive`, url);
    archiveUrl.searchParams.set('revision', revision);
    if (version) archiveUrl.searchParams.set('v', version);
    return c.json({
      postId,
      revision,
      format,
      cacheable: object.size <= MAX_BYTES,
      wvfsUrl: createWvfsGameUrl(url.origin, postId, { versionId: version }),
      archiveUrl: archiveUrl.href,
    });
  } catch (error) {
    console.warn('Public loader lookup failed:', error);
    return c.text('Game lookup unavailable', 503);
  }
}
