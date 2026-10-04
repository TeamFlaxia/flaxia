import type { Context } from 'hono';
import { Hono } from 'hono';
import { isAdmin } from '../../../src/lib/admin';
import type { AttachmentKind } from '../../lib/attachments';
import { parseAttachmentKey } from '../../lib/attachments';
import { validateImageDimensions } from '../../lib/image-dimensions';
import { checkRateLimit, getClientIp } from '../../lib/rate-limit';
import { submitFileScans } from '../../lib/scan/clamav';
import { isKeyBlocked } from '../../lib/scan/db';
import { runInBackground, scanUploadSync } from '../../lib/scan/index';
import {
  allowedOrigins,
  detectMimeType,
  getBaseOrigin,
  handleRangeRequest,
  isAllowedImageMime,
  MEDIA_SECURITY_HEADERS,
  requireAuth,
} from '../helpers';
import type { Bindings, Variables } from '../types';

const media = new Hono<{ Bindings: Bindings; Variables: Variables }>();

type MediaContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * Legacy DM media keys (`dm/...`) are no longer served — the direct-message
 * feature has been removed. Keys flagged by an async scan verdict (ClamAV /
 * blocklist callback) are also withheld: the verdict writes a KV marker, so
 * this costs one KV read on top of the rate-limit read already on this path.
 */
async function canAccessMediaKey(c: MediaContext, key: string): Promise<boolean> {
  if (key.startsWith('dm/')) return false;
  if (await isKeyBlocked(c.env.CACHE, key, c.env.DB)) return false;
  return true;
}

/**
 * Moderation is not optional for media: a hidden or unpublished post must not
 * keep serving its payload to everyone. The owner and admins keep access so
 * review, edits and restoration still work.
 */
async function postMediaAllowed(c: MediaContext, postId: string): Promise<boolean> {
  const row = (await c.env.DB.prepare('SELECT user_id, hidden, status FROM posts WHERE id = ?')
    .bind(postId)
    .first()) as { user_id: string; hidden: number; status: string } | null;
  if (!row) return true; // key without a post row: keep the previous behavior
  if (!row.hidden && row.status === 'published') return true;
  const viewer = c.get('user');
  if (!viewer) return false;
  return viewer.id === row.user_id || isAdmin(c.env, viewer.username);
}

/**
 * Same moderation rule as postMediaAllowed for routes addressed by media key
 * instead of post id (legacy gif/payload/swf/thumbnail keys). Attachment keys
 * and avatar/header keys have no posts row and stay unaffected.
 */
async function postKeyMediaAllowed(c: MediaContext, key: string): Promise<boolean> {
  const row = (await c.env.DB.prepare(
    `SELECT user_id, hidden, status FROM posts
     WHERE gif_key = ? OR payload_key = ? OR swf_key = ? OR thumbnail_key = ?
     LIMIT 1`,
  )
    .bind(key, key, key, key)
    .first()) as { user_id: string; hidden: number; status: string } | null;
  if (!row) return true;
  if (!row.hidden && row.status === 'published') return true;
  const viewer = c.get('user');
  if (!viewer) return false;
  return viewer.id === row.user_id || isAdmin(c.env, viewer.username);
}

/**
 * Cache-Control for media responses. Kept short so an async scan verdict or a
 * moderation hide lands quickly; the previous 24h/1y windows could serve a
 * blocked file long after the KV/D1 verdict was written.
 */
const MEDIA_CACHE_CONTROL = 'public, max-age=300, s-maxage=300';

/**
 * Does a detected MIME type belong in an attachment slot of this kind?
 *
 * Exhaustive over AttachmentKind on purpose: the previous nested ternary
 * defaulted to the video check, so a new kind would have silently accepted
 * (or rejected) the wrong files instead of failing the type check.
 */
function mimeMatchesAttachmentKind(kind: AttachmentKind, mime: string): boolean {
  switch (kind) {
    case 'image':
      return isAllowedImageMime(mime);
    case 'audio':
      // .webm uploads are stored as video/webm or audio/webm depending on the
      // client's content type, so both containers are valid in an audio slot.
      return mime.startsWith('audio/') || mime === 'video/webm' || mime === 'video/mp4';
    case 'video':
      return mime.startsWith('video/');
    case 'document':
      return true;
  }
}

/**
 * Pick a Content-Type that is actually in the requested media class.
 *
 * The stored R2 metadata is attacker-influenced (the uploader chooses the
 * declared type and, for document slots, any sniffed type passes), so the
 * audio/video proxies must never echo an executable type such as text/html
 * back to the browser. Unknown stored types fall back to the key extension;
 * when neither says "audio" (or "video") the route refuses to serve.
 */
function safeMediaContentType(key: string, stored: string | undefined, family: 'audio' | 'video'): string | null {
  const prefix = `${family}/`;
  if (stored && stored.startsWith(prefix)) return stored;
  const extension = key.split('.').pop()?.toLowerCase() ?? '';
  const byExtension: Record<'audio' | 'video', Record<string, string>> = {
    audio: { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', webm: 'audio/webm' },
    video: { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' },
  };
  return byExtension[family][extension] ?? null;
}

// PUT /api/upload/:key — direct file upload endpoint (requires auth + ownership of pending post)
media.put('/upload/*', requireAuth, async (c) => {
  try {
    const user = c.get('user')!;
    const key = c.req.path.replace('/api/upload/', '');
    const declaredContentType = c.req.header('content-type');
    const contentLength = c.req.header('content-length');

    if (!key) {
      return c.json({ error: 'Missing file key' }, 400);
    }

    // Keys are path-shaped: reject traversal and unexpected characters
    // before they reach ownership checks or R2.
    if (key.includes('..') || key.includes('\\') || !/^[A-Za-z0-9_./-]+$/.test(key) || key.length > 256) {
      return c.json({ error: 'Invalid key' }, 400);
    }

    // Byte ingest is the most expensive path per request: throttle uploads
    // per user as well as per IP (GET paths are IP-throttled already).
    // Local dev and the test server are exempt: the integration suite uploads
    // dozens of fixtures from a single IP.
    const isLocalEnv = c.env.ENVIRONMENT === 'test' || (c.env.BASE_URL ?? '').startsWith('http://localhost');
    if (!isLocalEnv) {
      const uploadIp = getClientIp(c.req.raw);
      if (
        !(await checkRateLimit(c.env.CACHE, `upload:user:${user.id}`, { maxRequests: 20, windowSeconds: 60 })) ||
        !(await checkRateLimit(c.env.CACHE, `upload:ip:${uploadIp}`, { maxRequests: 60, windowSeconds: 60 }))
      ) {
        return c.json({ error: 'Rate limit exceeded' }, 429);
      }
    }

    // Check file size limit (25MB = 25 * 1024 * 1024 bytes)
    const maxSize = 25 * 1024 * 1024;
    if (contentLength && Number(contentLength) > maxSize) {
      return c.json({ error: 'File too large. Maximum size is 25MB' }, 413);
    }

    // Multi-media attachment keys: gif|audio|video/{postId}/{position}{ext}
    const attachment = parseAttachmentKey(key);

    // Verify the user owns a pending or published post with this storage key
    // For published posts, extract the postId from the key path to verify ownership
    const ownedPost = (await c.env.DB.prepare(
      'SELECT id FROM posts WHERE user_id = ? AND (gif_key = ? OR payload_key = ? OR swf_key = ?) AND status = ?',
    )
      .bind(user.id, key, key, key, 'pending')
      .first()) as { id: string } | null;

    if (!ownedPost) {
      if (attachment) {
        // Multi-media attachment keys: gif|audio|video/{postId}/{position}{ext}.
        // The row is only written at commit time, so ownership is verified
        // against the post itself (pending during upload, published on edit).
        const attachmentPost = (await c.env.DB.prepare(
          'SELECT id FROM posts WHERE id = ? AND user_id = ? AND status IN (?, ?)',
        )
          .bind(attachment.postId, user.id, 'pending', 'published')
          .first()) as { id: string } | null;
        if (!attachmentPost) {
          return c.json({ error: 'No post found for this key' }, 403);
        }
      } else if (key.startsWith('versions/')) {
        // Versioned game uploads live under versions/<postId>/<versionId>.zip
        // (#86). The tail is not free-form: prepare mints UUID version ids,
        // so anything else is an orphan-storage write and is rejected.
        const parts = key.split('/');
        const postId = parts[1];
        const tail = parts[2];
        if (!postId || parts.length !== 3 || !/^[0-9a-fA-F-]{36}\.zip$/.test(tail || '')) {
          return c.json({ error: 'Invalid key' }, 400);
        }
        const publishedPost = (await c.env.DB.prepare(
          'SELECT id FROM posts WHERE id = ? AND user_id = ? AND status = ?',
        )
          .bind(postId, user.id, 'published')
          .first()) as { id: string } | null;
        if (!publishedPost) {
          return c.json({ error: 'No published post found for this key' }, 403);
        }
      } else {
        // Check if user owns a published post (for editing attachments)
        const slashIndex = key.indexOf('/');
        if (slashIndex !== -1) {
          const afterSlash = key.substring(slashIndex + 1);
          const keyPostId = afterSlash.split('.')[0];
          if (keyPostId) {
            const publishedPost = (await c.env.DB.prepare(
              'SELECT id FROM posts WHERE id = ? AND user_id = ? AND status = ?',
            )
              .bind(keyPostId, user.id, 'published')
              .first()) as { id: string } | null;
            if (!publishedPost) {
              return c.json({ error: 'No pending post found for this key' }, 403);
            }
          } else {
            return c.json({ error: 'Invalid key' }, 400);
          }
        } else {
          return c.json({ error: 'Invalid key' }, 400);
        }
      }
    }

    // Get the file data from request body
    const fileData = await c.req.arrayBuffer();

    // Double-check file size after reading
    if (fileData.byteLength > maxSize) {
      return c.json({ error: 'File too large. Maximum size is 25MB' }, 413);
    }

    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    // Validate magic bytes against declared content type. Document formats can
    // use browser MIME values that differ from their container signature (for
    // example, office files are ZIP containers), and unknown formats have no
    // signature to compare. Their extension, magic-byte, and blocklist checks
    // still run below.
    const sniffedMime = detectMimeType(fileData);
    const isDocumentAttachment = attachment?.kind === 'document';
    const detectedMime = sniffedMime ?? (isDocumentAttachment ? 'application/octet-stream' : null);
    if (!detectedMime) {
      return c.json({ error: 'Unrecognized file format. Magic bytes do not match any allowed type.' }, 400);
    }
    // Disallow SVG disguised as other types (SVG has no unique magic bytes, would fail detection above)
    if (
      !isAllowedImageMime(detectedMime) &&
      !detectedMime.startsWith('audio/') &&
      !detectedMime.startsWith('video/') &&
      detectedMime !== 'application/pdf' &&
      detectedMime !== 'application/octet-stream' &&
      detectedMime !== 'application/zip' &&
      detectedMime !== 'application/x-shockwave-flash' &&
      detectedMime !== 'text/html'
    ) {
      return c.json({ error: 'File type not allowed' }, 400);
    }
    // PDFs live only in a multi-media document slot (docs/{postId}/{n}.pdf).
    // The legacy gif/payload/swf keys feed other renderers and are never
    // served by /api/documents, so bytes stored there would be unreachable,
    // and this route is the only place that can tell what the file actually
    // is — the key and the declared Content-Type both come from the client.
    if (detectedMime === 'application/pdf' && attachment?.kind !== 'document') {
      return c.json({ error: 'PDF files are only allowed as document attachments' }, 400);
    }
    // Sanity check: declared content-type should be consistent (relaxed for zip/swf which may use generic types)
    // — replaced by the full scan pipeline below, which checks the declared
    // type, the key extension, the features and the blocklist in one place.

    // Multi-media attachment slots only accept media of the declared kind.
    // This rejects html/swf/zip masquerading in gif|audio|video|docs keys.
    if (attachment) {
      const kindMatches = mimeMatchesAttachmentKind(attachment.kind, detectedMime);
      if (!kindMatches) {
        return c.json({ error: 'File type does not match attachment type' }, 400);
      }
    }

    // Reject oversized images to prevent renderer OOM crashes when decoded in the browser
    const dimError = validateImageDimensions(fileData, detectedMime);
    if (dimError) {
      return c.json({ error: dimError }, 413);
    }

    // Steps 2-4 of the file scanning pipeline: masquerade checks, feature
    // extraction and the synchronous blocklist match. A hit never reaches R2.
    const verdict = await scanUploadSync(c.env.DB, {
      bytes: fileData,
      declaredType: isDocumentAttachment ? undefined : declaredContentType,
      name: key,
      r2Key: key,
      detectedMime,
    });
    if (!verdict.ok) {
      return c.json({ error: verdict.error, code: verdict.code }, verdict.status);
    }

    // Upload to R2 with detected content type
    await c.env.BUCKET.put(key, fileData, {
      httpMetadata: {
        contentType: detectedMime,
      },
    });

    // Step 1 (ClamAV) runs after the response; a later hit blocks serving.
    runInBackground(c, () => submitFileScans(c.env.DB, c.env, key, detectedMime, fileData));

    return c.json({ success: true, key });
  } catch (error: unknown) {
    console.error('Upload error:', error);
    return c.json({ error: 'Upload failed' }, 500);
  }
});

// GET /api/images/* - proxy images from R2
media.get('/images/*', async (c) => {
  try {
    const key = c.req.path.replace('/api/images/', '');

    if (!key) {
      return c.json({ error: 'Missing image key' }, 400);
    }

    if (!(await canAccessMediaKey(c, key))) {
      return c.json({ error: 'Image not found' }, 404);
    }

    if (c.env.DB && !(await postKeyMediaAllowed(c, key))) {
      return c.json({ error: 'Image not found' }, 404);
    }

    // Rate limit: 100 requests per minute per IP
    const clientIp = getClientIp(c.req.raw);
    if (!(await checkRateLimit(c.env.CACHE, `img:${clientIp}`, { maxRequests: 100, windowSeconds: 60 }))) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    // Get object from R2
    const object = await c.env.BUCKET.get(key);

    if (!object) {
      // Special handling for default-avatar
      if (key === 'default-avatar') {
        const defaultAvatarSvg = `<svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
          <circle cx="20" cy="20" r="20" fill="#e5e7eb"/>
          <circle cx="20" cy="15" r="6" fill="#9ca3af"/>
          <ellipse cx="20" cy="32" rx="10" ry="6" fill="#9ca3af"/>
        </svg>`;

        return new Response(defaultAvatarSvg, {
          headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': MEDIA_CACHE_CONTROL,
            'Access-Control-Allow-Origin': 'https://flaxia.app',
            ...MEDIA_SECURITY_HEADERS,
          },
        });
      }

      return c.json({ error: 'Image not found' }, 404);
    }

    // Never serve a non-image R2 key from the image proxy. A user-uploaded
    // HTML/SVG document returned inline here would run on the main origin.
    const contentType = object.httpMetadata?.contentType || 'image/jpeg';
    if (!isAllowedImageMime(contentType)) {
      return c.json({ error: 'Image not found' }, 404);
    }

    // Return the image with proper headers
    return new Response(object.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': MEDIA_CACHE_CONTROL,
        'Access-Control-Allow-Origin': 'https://flaxia.app',
        'Content-Disposition': 'inline',
        ...MEDIA_SECURITY_HEADERS,
      },
    });
  } catch (error: unknown) {
    console.error('Image proxy error:', error);
    return c.json({ error: 'Failed to fetch image' }, 500);
  }
});

// GET /api/audio/* - proxy audio files from R2
media.get('/audio/*', async (c) => {
  try {
    const key = c.req.path.replace('/api/audio/', '');

    if (!key) {
      return c.json({ error: 'Missing audio key' }, 400);
    }

    if (!(await canAccessMediaKey(c, key))) {
      return c.json({ error: 'Audio not found' }, 404);
    }

    if (c.env.DB && !(await postKeyMediaAllowed(c, key))) {
      return c.json({ error: 'Audio not found' }, 404);
    }

    // Rate limit: 60 requests per minute per IP
    const clientIp = getClientIp(c.req.raw);
    if (!(await checkRateLimit(c.env.CACHE, `aud:${clientIp}`, { maxRequests: 60, windowSeconds: 60 }))) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    const object = await c.env.BUCKET.get(key);

    if (!object) {
      return c.json({ error: 'Audio not found' }, 404);
    }

    const contentType = safeMediaContentType(key, object.httpMetadata?.contentType, 'audio');
    if (!contentType) {
      return c.json({ error: 'Audio not found' }, 404);
    }

    return handleRangeRequest(c, key, object, contentType);
  } catch (error: unknown) {
    console.error('Audio proxy error:', error);
    return c.json({ error: 'Failed to fetch audio' }, 500);
  }
});

// GET /api/video/* - proxy video files from R2
media.get('/video/*', async (c) => {
  try {
    const key = c.req.path.replace('/api/video/', '');

    if (!key) {
      return c.json({ error: 'Missing video key' }, 400);
    }

    if (!(await canAccessMediaKey(c, key))) {
      return c.json({ error: 'Video not found' }, 404);
    }

    if (c.env.DB && !(await postKeyMediaAllowed(c, key))) {
      return c.json({ error: 'Video not found' }, 404);
    }

    // Rate limit: 30 requests per minute per IP
    const clientIp = getClientIp(c.req.raw);
    if (!(await checkRateLimit(c.env.CACHE, `vid:${clientIp}`, { maxRequests: 30, windowSeconds: 60 }))) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    const object = await c.env.BUCKET.get(key);

    if (!object) {
      return c.json({ error: 'Video not found' }, 404);
    }

    const contentType = safeMediaContentType(key, object.httpMetadata?.contentType, 'video');
    if (!contentType) {
      return c.json({ error: 'Video not found' }, 404);
    }

    return handleRangeRequest(c, key, object, contentType);
  } catch (error: unknown) {
    console.error('Video proxy error:', error);
    return c.json({ error: 'Failed to fetch video' }, 500);
  }
});

// GET /api/documents/* - download file attachments from R2
//
// Content-Disposition forces downloads, keeping arbitrary uploaded formats
// away from the main origin's document renderer.
//
// Framing stays denied (X-Frame-Options: DENY from MEDIA_SECURITY_HEADERS):
// the timeline opens documents as top-level tabs, and a PDF framed inside a
// sandboxed iframe would be blocked by the browser anyway (the spec forbids
// plugin content — which includes PDFs — in sandboxed frames, whatwg/html#6946).
media.get('/documents/*', async (c) => {
  try {
    const key = c.req.path.replace('/api/documents/', '');

    if (!key) {
      return c.json({ error: 'Missing document key' }, 400);
    }

    // Only keys the server itself minted for a document slot are servable here.
    if (parseAttachmentKey(key)?.kind !== 'document') {
      return c.json({ error: 'Document not found' }, 404);
    }

    if (!(await canAccessMediaKey(c, key))) {
      return c.json({ error: 'Document not found' }, 404);
    }

    if (c.env.DB && !(await postKeyMediaAllowed(c, key))) {
      return c.json({ error: 'Document not found' }, 404);
    }

    // Rate limit: 60 requests per minute per IP
    const clientIp = getClientIp(c.req.raw);
    if (!(await checkRateLimit(c.env.CACHE, `doc:${clientIp}`, { maxRequests: 60, windowSeconds: 60 }))) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    const object = await c.env.BUCKET.get(key);

    if (!object) {
      return c.json({ error: 'Document not found' }, 404);
    }

    // Preserve inline PDF viewing and partial-content support. Other document
    // attachments always download as opaque bytes.
    if (key.toLowerCase().endsWith('.pdf')) {
      return handleRangeRequest(c, key, object, 'application/pdf');
    }

    return new Response(object.body, {
      headers: {
        ...MEDIA_SECURITY_HEADERS,
        'Content-Type': 'application/octet-stream',
        'Cache-Control': MEDIA_CACHE_CONTROL,
        // Must win over MEDIA_SECURITY_HEADERS' inline default: arbitrary
        // document bytes are always a download.
        'Content-Disposition': `attachment; filename="${key.split('/').pop() || 'download.bin'}"`,
      },
    });
  } catch (error: unknown) {
    console.error('Document proxy error:', error);
    return c.json({ error: 'Failed to fetch document' }, 500);
  }
});

// GET /api/zip/:postId - serve ZIP files from R2 (supports zip/ and dm/ prefixes)
media.get('/zip/:postId', async (c) => {
  try {
    const postId = c.req.param('postId');

    if (!postId) {
      return c.json({ error: 'Missing post ID' }, 400);
    }

    // Rate limit: 60 requests per minute per IP
    const clientIp = getClientIp(c.req.raw);
    if (!(await checkRateLimit(c.env.CACHE, `zip:${clientIp}`, { maxRequests: 60, windowSeconds: 60 }))) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    const publicKey = `zip/${postId}.zip`;

    if (!(await canAccessMediaKey(c, publicKey))) {
      return c.json({ error: 'ZIP not found' }, 404);
    }

    if (c.env.DB && !(await postMediaAllowed(c, postId))) {
      return c.json({ error: 'ZIP not found' }, 404);
    }

    const object = await c.env.BUCKET.get(publicKey);

    if (!object) {
      return c.json({ error: 'ZIP not found' }, 404);
    }

    // Return the ZIP with proper headers (validate origin)
    const zipOrigin = c.req.header('Origin') || '';
    const zipAllowed = allowedOrigins.has(zipOrigin) || zipOrigin === getBaseOrigin(c);
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(object.size),
        'Cache-Control': 'public, max-age=300, s-maxage=300',
        'Access-Control-Allow-Origin': zipAllowed ? zipOrigin : 'https://flaxia.app',
        'Access-Control-Allow-Credentials': 'true',
        ...MEDIA_SECURITY_HEADERS,
      },
    });
  } catch (error: unknown) {
    console.error('ZIP proxy error:', error);
    return c.json({ error: 'Failed to fetch ZIP' }, 500);
  }
});

// GET /api/wvfs-zip/:postId/* - redirect to sandbox.flaxia.app
media.get('/wvfs-zip/:postId/*', (c) => {
  return c.redirect(`https://sandbox.flaxia.app${c.req.path}`, 301);
});

// GET /api/thumbnail/:id - serve thumbnail images from R2 (posts)
media.get('/thumbnail/:id', async (c) => {
  try {
    const postId = c.req.param('id');

    if (!postId) {
      return c.json({ error: 'Missing post ID' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    // First try to get from posts table
    let post = (await c.env.DB.prepare('SELECT thumbnail_key, user_id, hidden, status FROM posts WHERE id = ?')
      .bind(postId)
      .first()) as Record<string, unknown> | null;
    const isPostRow = Boolean(post && post.thumbnail_key);

    // If not found in posts, try ads table
    if (!post || !post.thumbnail_key) {
      const ad = (await c.env.DB.prepare('SELECT thumbnail_key FROM ads WHERE id = ?').bind(postId).first()) as Record<
        string,
        unknown
      > | null;

      if (!ad || !ad.thumbnail_key) {
        return c.json({ error: 'Thumbnail not found' }, 404);
      }

      post = ad;
    }

    // Hidden or unpublished posts keep their thumbnail for owner/admins only.
    if (isPostRow && post && (post.hidden || post.status !== 'published')) {
      const viewer = c.get('user');
      const allowed = viewer !== null && (viewer.id === String(post.user_id) || isAdmin(c.env, viewer.username));
      if (!allowed) {
        return c.json({ error: 'Thumbnail not found' }, 404);
      }
    }

    // Get thumbnail object from R2
    const thumbKey = post.thumbnail_key as string;
    if (await isKeyBlocked(c.env.CACHE, thumbKey, c.env.DB)) {
      return c.json({ error: 'Thumbnail not found' }, 404);
    }
    const object = await c.env.BUCKET.get(thumbKey);

    if (!object) {
      return c.json({ error: 'Thumbnail file not found' }, 404);
    }

    // Determine content type based on file extension
    let contentType = 'image/jpeg'; // default
    const key = thumbKey;
    const extension = key.split('.').pop()?.toLowerCase();

    switch (extension) {
      case 'jpg':
      case 'jpeg':
        contentType = 'image/jpeg';
        break;
      case 'png':
        contentType = 'image/png';
        break;
      case 'gif':
        contentType = 'image/gif';
        break;
    }

    // Stream the thumbnail with proper headers
    return new Response(object.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': MEDIA_CACHE_CONTROL,
        'Access-Control-Allow-Origin': 'https://flaxia.app',
        ...MEDIA_SECURITY_HEADERS,
      },
    });
  } catch (error: unknown) {
    console.error('Thumbnail proxy error:', error);
    return c.json({ error: 'Failed to fetch thumbnail' }, 500);
  }
});

// GET /api/swf/:postId - serve SWF files from R2
media.get('/swf/:postId', async (c) => {
  try {
    const postId = c.req.param('postId');

    if (!postId) {
      return c.json({ error: 'Missing post ID' }, 400);
    }

    // Rate limit: 60 requests per minute per IP
    const clientIp = getClientIp(c.req.raw);
    if (!(await checkRateLimit(c.env.CACHE, `swf:${clientIp}`, { maxRequests: 60, windowSeconds: 60 }))) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    // SWF key
    const publicKey = `swf/${postId}.swf`;

    if (!(await canAccessMediaKey(c, publicKey))) {
      return c.json({ error: 'SWF not found' }, 404);
    }

    if (c.env.DB && !(await postMediaAllowed(c, postId))) {
      return c.json({ error: 'SWF not found' }, 404);
    }

    const object = await c.env.BUCKET.get(publicKey);

    if (!object) {
      return c.json({ error: 'SWF not found' }, 404);
    }

    // Return the SWF with proper headers (validate origin)
    const swfOrigin = c.req.header('Origin') || '';
    const swfAllowed = allowedOrigins.has(swfOrigin) || swfOrigin === getBaseOrigin(c);
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/x-shockwave-flash',
        'Content-Length': String(object.size),
        'Cache-Control': 'public, max-age=300, s-maxage=300',
        'Access-Control-Allow-Origin': swfAllowed ? swfOrigin : 'https://flaxia.app',
        'Access-Control-Allow-Credentials': 'true',
        ...MEDIA_SECURITY_HEADERS,
      },
    });
  } catch (error: unknown) {
    console.error('SWF proxy error:', error);
    return c.json({ error: 'Failed to fetch SWF' }, 500);
  }
});

export default media;
