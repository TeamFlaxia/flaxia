import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AttachmentKind } from '../../lib/attachments';
import { parseAttachmentKey } from '../../lib/attachments';
import { validateImageDimensions } from '../../lib/image-dimensions';
import { checkRateLimit, getClientIp } from '../../lib/rate-limit';
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
 * feature has been removed. All other media keys are public and always allowed.
 */
async function canAccessMediaKey(_c: MediaContext, key: string): Promise<boolean> {
  if (key.startsWith('dm/')) return false;
  return true;
}

/**
 * Cache-Control for media responses.
 * CDN cacheable (`public` + `s-maxage`) since media keys are content-hash
 * based and do not require a signed token.
 */
const MEDIA_CACHE_CONTROL = 'public, max-age=86400, s-maxage=86400';

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
      return mime === 'application/pdf';
  }
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
        const postId = key.split('/')[1];
        if (!postId) return c.json({ error: 'Invalid key' }, 400);
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

    // Validate magic bytes against declared content type
    const detectedMime = detectMimeType(fileData);
    if (!detectedMime) {
      return c.json({ error: 'Unrecognized file format. Magic bytes do not match any allowed type.' }, 400);
    }
    // Disallow SVG disguised as other types (SVG has no unique magic bytes, would fail detection above)
    if (
      !isAllowedImageMime(detectedMime) &&
      !detectedMime.startsWith('audio/') &&
      !detectedMime.startsWith('video/') &&
      detectedMime !== 'application/pdf' &&
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
    if (declaredContentType && detectedMime.startsWith('image/') && !declaredContentType.startsWith('image/')) {
      return c.json({ error: 'Declared Content-Type does not match actual file content' }, 400);
    }

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

    // Upload to R2 with detected content type
    await c.env.BUCKET.put(key, fileData, {
      httpMetadata: {
        contentType: detectedMime,
      },
    });

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

    // Get content type from object metadata or default to image/jpeg
    const contentType = object.httpMetadata?.contentType || 'image/jpeg';

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

    let contentType = object.httpMetadata?.contentType;
    if (!contentType) {
      const extension = key.split('.').pop()?.toLowerCase();
      switch (extension) {
        case 'mp3':
          contentType = 'audio/mpeg';
          break;
        case 'wav':
          contentType = 'audio/wav';
          break;
        case 'ogg':
          contentType = 'audio/ogg';
          break;
        case 'm4a':
          contentType = 'audio/mp4';
          break;
        case 'webm':
          contentType = 'audio/webm';
          break;
        default:
          contentType = 'audio/mpeg';
      }
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

    let contentType = object.httpMetadata?.contentType;
    if (!contentType) {
      const extension = key.split('.').pop()?.toLowerCase();
      switch (extension) {
        case 'mp4':
          contentType = 'video/mp4';
          break;
        case 'webm':
          contentType = 'video/webm';
          break;
        case 'mov':
          contentType = 'video/quicktime';
          break;
        default:
          contentType = 'video/mp4';
      }
    }

    return handleRangeRequest(c, key, object, contentType);
  } catch (error: unknown) {
    console.error('Video proxy error:', error);
    return c.json({ error: 'Failed to fetch video' }, 500);
  }
});

// GET /api/documents/* - proxy PDF attachments from R2
//
// Content-Type is forced to application/pdf so the browser's built-in viewer
// takes over when the link is opened in a new tab. Forcing it means the key
// must be validated first, so a png/swf/html key requested through this route
// can never be served as a PDF.
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

    return handleRangeRequest(c, key, object, 'application/pdf');
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
        'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable',
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
    let post = await c.env.DB.prepare('SELECT thumbnail_key FROM posts WHERE id = ?').bind(postId).first();

    // If not found in posts, try ads table
    if (!post || !post.thumbnail_key) {
      const ad = await c.env.DB.prepare('SELECT thumbnail_key FROM ads WHERE id = ?').bind(postId).first();

      if (!ad || !ad.thumbnail_key) {
        return c.json({ error: 'Thumbnail not found' }, 404);
      }

      post = ad;
    }

    // Get thumbnail object from R2
    const object = await c.env.BUCKET.get(post.thumbnail_key as string);

    if (!object) {
      return c.json({ error: 'Thumbnail file not found' }, 404);
    }

    // Determine content type based on file extension
    let contentType = 'image/jpeg'; // default
    const key = post.thumbnail_key as string;
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
        'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable',
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
