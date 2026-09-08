import { Hono } from 'hono';
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

/**
 * Cache-Control for media responses.
 * CDN cacheable (`public` + `s-maxage`) since media keys are content-hash
 * based and do not require a signed token.
 */
const MEDIA_CACHE_CONTROL = 'public, max-age=86400, s-maxage=86400';

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

    // Verify the user owns a pending or published post with this storage key
    // For published posts, extract the postId from the key path to verify ownership
    const ownedPost = (await c.env.DB.prepare(
      'SELECT id FROM posts WHERE user_id = ? AND (gif_key = ? OR payload_key = ? OR swf_key = ?) AND status = ?',
    )
      .bind(user.id, key, key, key, 'pending')
      .first()) as { id: string } | null;

    if (!ownedPost) {
      // Versioned game uploads live under versions/<postId>/<versionId>.zip
      if (key.startsWith('versions/')) {
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
      detectedMime !== 'application/zip' &&
      detectedMime !== 'application/x-shockwave-flash' &&
      detectedMime !== 'text/html'
    ) {
      return c.json({ error: 'File type not allowed' }, 400);
    }
    // Sanity check: declared content-type should be consistent (relaxed for zip/swf which may use generic types)
    if (declaredContentType && detectedMime.startsWith('image/') && !declaredContentType.startsWith('image/')) {
      return c.json({ error: 'Declared Content-Type does not match actual file content' }, 400);
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

    const keysToTry = [`zip/${postId}.zip`, `dm/zip/${postId}.zip`];
    let object = null;

    for (const zipKey of keysToTry) {
      object = await c.env.BUCKET.get(zipKey);
      if (object) break;
    }

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

    // Try standard SWF key first, then DM variant
    const keysToTry = [`swf/${postId}.swf`, `dm/swf/${postId}.swf`];
    let object = null;

    for (const swfKey of keysToTry) {
      object = await c.env.BUCKET.get(swfKey);
      if (object) break;
    }

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
