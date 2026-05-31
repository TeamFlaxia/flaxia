import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { User, getSession, getMeWithSession, getSessionToken, setSessionCookie, clearSessionCookie, registerUser, loginUser, deleteSession, extendSession, hashPassword, verifyPassword } from '../lib/auth'
import { nanoid } from 'nanoid'
import { checkRateLimit, rateLimitResponse } from '../../src/lib/rate-limit'
import { isAdmin } from '../../src/lib/admin'
import { verifyHttpSignature, verifyDigest, fetchActorPublicKey, signRequest } from '../lib/activitypub/signature'
import { generateKeyPair, exportPublicKey, exportPrivateKey } from '../lib/activitypub/crypto'
import { buildNoteObject, buildCreateActivity, buildDeleteActivity } from '../lib/activitypub/note'
import type { ReportCategory } from '../../src/types/post'
import { FlaxiaClient } from '@flaxia/sdk'

type Bindings = {
  DB: D1Database
  DB_TEST: D1Database
  BUCKET: R2Bucket
  RATE_LIMIT: KVNamespace
  CACHE: KVNamespace
  SANDBOX_ORIGIN: string
  BASE_URL: string
  ADMIN_USERNAMES: string
  AP_DELIVERY_QUEUE: Queue
  CROWD_ORCHESTRATOR_URL: string
  CROWD_API_KEY: string
}

type Variables = {
  user: User | null
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// Auth middleware — sets user context (null if not authenticated); must precede all routes
app.use('/api/*', async (c, next) => {
  if ((c.req.method === 'GET' && c.req.path.startsWith('/api/images/')) ||
      (c.req.method === 'GET' && c.req.path.startsWith('/api/audio/')) ||
      (c.req.method === 'GET' && c.req.path.startsWith('/api/zip/')) ||
      (c.req.method === 'GET' && c.req.path.startsWith('/api/swf/')) ||
      (c.req.method === 'GET' && c.req.path === '/api/link-preview') ||
      (c.req.method === 'GET' && c.req.path === '/api/games') ||
      (c.req.method === 'GET' && c.req.path.startsWith('/api/ads/') && c.req.path.endsWith('/payload')) ||
      (c.req.method === 'GET' && c.req.path.startsWith('/api/wvfs-zip/'))) {
    await next()
    return
  }
  const token = getSessionToken(c.req.raw)
  const sessionData = token ? await getSession(c.env, token) : null
  c.set('user', sessionData?.user || null)
  await next()
})

const requireAuth = async (c: any, next: any) => {
  if (!c.get('user')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await next()
}

app.use('/*', cors({
  origin: (origin, c) => {
    if (!origin) return ''
    const env = c.env as { BASE_URL?: string; SANDBOX_ORIGIN?: string }
    const allowed = new Set([
      env.BASE_URL,
      env.SANDBOX_ORIGIN,
      'http://localhost:8787',
      'http://localhost:5173',
      'https://flaxia.app',
      'https://sandbox.flaxia.app',
    ].filter(Boolean))
    return allowed.has(origin) ? origin : ''
  },
  allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}))

function getCrowdClient(c: any): FlaxiaClient | null {
  const orchestratorUrl = (c.env.CROWD_ORCHESTRATOR_URL ?? '').replace(/\/+$/,'' )
  const apiKey = c.env.CROWD_API_KEY
  if (!orchestratorUrl || !apiKey) return null
  // Ensure the orchestrator base URL includes the /crowd prefix
  const baseUrl = `${orchestratorUrl}/crowd`
  return new FlaxiaClient({ baseUrl, apiKey })
}

const processingPosts = new Set<string>()

async function analyzeSentiment(c: any, postId: string, text: string): Promise<void> {
  if (processingPosts.has(postId)) return
  processingPosts.add(postId)
  try {
    const client = getCrowdClient(c)
    if (!client) return

    const task = await client.submit({
      workload: 'ai-inference',
      payload: {
        task: 'text-classification',
        model: 'Xenova/bert-base-multilingual-uncased-sentiment',
        input: text,
      },
    })

    const taskId = (task as any).taskId
    if (!taskId) return
    const result = await client.waitForTask(taskId, 2000, 30000)
    if (result.status === 'done' && result.result) {
      const output = ((result.result as any).output || []) as Array<{ label: string; score: number }>
      if (output.length > 0) {
        const labelScoreMap: Record<string, number> = {
          very_negative: 0.0,
          negative: 0.25,
          neutral: 0.5,
          positive: 0.75,
          very_positive: 1.0,
        }
        const score = labelScoreMap[output[0].label] ?? output[0].score
        await c.env.DB.prepare(
          'UPDATE posts SET sentiment_score = ? WHERE id = ?'
        ).bind(score, postId).run()
        console.log(`Sentiment analysis succeeded for post ${postId}: label=${output[0].label}, score=${score}, taskId=${taskId}`)
      }
    }
  } catch (err) {
    console.error(`Sentiment analysis failed for post ${postId}:`, err)
  } finally {
    processingPosts.delete(postId)
  }
}

// Magic byte detection to prevent MIME type spoofing
const MAGIC_TYPES: { offset: number; bytes: number[]; mime: string }[] = [
  { offset: 0, bytes: [0xFF, 0xD8, 0xFF], mime: 'image/jpeg' },
  { offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47], mime: 'image/png' },
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  { offset: 0, bytes: [0x50, 0x4B, 0x03, 0x04], mime: 'application/zip' },
  { offset: 0, bytes: [0x50, 0x4B, 0x05, 0x06], mime: 'application/zip' },
  { offset: 0, bytes: [0x43, 0x57, 0x53], mime: 'application/x-shockwave-flash' },
  { offset: 0, bytes: [0x46, 0x57, 0x53], mime: 'application/x-shockwave-flash' },
]

function detectMimeType(data: ArrayBuffer): string | null {
  const header = new Uint8Array(data, 0, 12)
  // WebP: RIFF(4)....WEBP(4)
  if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
      header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) {
    return 'image/webp'
  }
  for (const t of MAGIC_TYPES) {
    if (t.bytes.every((b, i) => header[t.offset + i] === b)) {
      return t.mime
    }
  }
  return null
}

function isAllowedImageMime(mime: string | null): mime is string {
  return !!mime && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime)
}

// PUT /api/upload/:key — direct file upload endpoint (requires auth + ownership of pending post)
app.put('/api/upload/*', requireAuth, async (c) => {
  try {
    const user = c.get('user')!
    const key = c.req.path.replace('/api/upload/', '')
    const declaredContentType = c.req.header('content-type')
    const contentLength = c.req.header('content-length')
    
    if (!key) {
      return c.json({ error: 'Missing file key' }, 400)
    }
    
    // Check file size limit (25MB = 25 * 1024 * 1024 bytes)
    const maxSize = 25 * 1024 * 1024
    if (contentLength && Number(contentLength) > maxSize) {
      return c.json({ error: 'File too large. Maximum size is 25MB' }, 413)
    }
    
    // Verify the user owns a pending post with this storage key
    const pending = await c.env.DB.prepare(
      'SELECT id FROM posts WHERE user_id = ? AND (gif_key = ? OR payload_key = ? OR swf_key = ?) AND status = ?'
    ).bind(user.id, key, key, key, 'pending').first() as { id: string } | null

    if (!pending) {
      return c.json({ error: 'No pending post found for this key' }, 403)
    }

    // Get the file data from request body
    const fileData = await c.req.arrayBuffer()
    
    // Double-check file size after reading
    if (fileData.byteLength > maxSize) {
      return c.json({ error: 'File too large. Maximum size is 25MB' }, 413)
    }
    
    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500)
    }
    
    // Validate magic bytes against declared content type
    const detectedMime = detectMimeType(fileData)
    if (!detectedMime) {
      return c.json({ error: 'Unrecognized file format. Magic bytes do not match any allowed type.' }, 400)
    }
    // Disallow SVG disguised as other types (SVG has no unique magic bytes, would fail detection above)
    if (!isAllowedImageMime(detectedMime) && detectedMime !== 'application/zip' && detectedMime !== 'application/x-shockwave-flash') {
      return c.json({ error: 'File type not allowed' }, 400)
    }
    // Sanity check: declared content-type should be consistent (relaxed for zip/swf which may use generic types)
    if (declaredContentType && detectedMime.startsWith('image/') && !declaredContentType.startsWith('image/')) {
      return c.json({ error: 'Declared Content-Type does not match actual file content' }, 400)
    }
    
    // Upload to R2 with detected content type
    await c.env.BUCKET.put(key, fileData, {
      httpMetadata: {
        contentType: detectedMime
      }
    })
    
    return c.json({ success: true, key })
  } catch (error: any) {
    console.error('Upload error:', error)
    return c.json({ error: 'Upload failed', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/images/* - proxy images from R2
// GET /api/audio/* - proxy audio files from R2  
app.get('/api/images/*', async (c) => {
  try {
    const key = c.req.path.replace('/api/images/', '')
    
    if (!key) {
      return c.json({ error: 'Missing image key' }, 400)
    }
    
    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500)
    }
    
    // Get object from R2
    const object = await c.env.BUCKET.get(key)
    
    if (!object) {
      // Special handling for default-avatar
      if (key === 'default-avatar') {
        const defaultAvatarSvg = `<svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
          <circle cx="20" cy="20" r="20" fill="#e5e7eb"/>
          <circle cx="20" cy="15" r="6" fill="#9ca3af"/>
          <ellipse cx="20" cy="32" rx="10" ry="6" fill="#9ca3af"/>
        </svg>`
        
        return new Response(defaultAvatarSvg, {
          headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'public, max-age=31536000',
            'Access-Control-Allow-Origin': '*'
          }
        })
      }
      
      return c.json({ error: 'Image not found' }, 404)
    }
    
    // Get content type from object metadata or default to image/jpeg
    const contentType = object.httpMetadata?.contentType || 'image/jpeg'
    
    // Return the image with proper headers
    return new Response(object.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch (error: any) {
    console.error('Image proxy error:', error)
    return c.json({ error: 'Failed to fetch image', details: error?.message || 'Unknown error' }, 500)
  }
})

app.get('/api/audio/*', async (c) => {
  try {
    const key = c.req.path.replace('/api/audio/', '')
    
    if (!key) {
      return c.json({ error: 'Missing audio key' }, 400)
    }
    
    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500)
    }
    
    // Get object from R2
    const object = await c.env.BUCKET.get(key)
    
    if (!object) {
      return c.json({ error: 'Audio not found' }, 404)
    }
    
    // Get content type from object metadata or detect from file extension
    let contentType = object.httpMetadata?.contentType
    if (!contentType) {
      // Detect content type from file extension
      const key = c.req.path.replace('/api/audio/', '')
      const extension = key.split('.').pop()?.toLowerCase()
      switch (extension) {
        case 'mp3':
          contentType = 'audio/mpeg'
          break
        case 'wav':
          contentType = 'audio/wav'
          break
        case 'ogg':
          contentType = 'audio/ogg'
          break
        case 'm4a':
          contentType = 'audio/mp4'
          break
        case 'webm':
          contentType = 'audio/webm'
          break
        default:
          contentType = 'audio/mpeg'
      }
    }
    
    // Return the audio with proper headers
    return new Response(object.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'Content-Length': object.size?.toString() || '0'
      }
    })
  } catch (error: any) {
    console.error('Audio proxy error:', error)
    return c.json({ error: 'Failed to fetch audio', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/dos-player/:postId - serve DOS player iframe HTML
app.get('/api/dos-player/:postId', async (c) => {
  try {
    const postId = c.req.param('postId')
    const loadFailed = c.req.query('load_failed') || 'Failed to load game'
    const origin = new URL(c.req.url).origin
    const zipUrl = c.req.query('zip_url') || `${origin}/api/zip/${postId}`

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>DOS Game</title>
  <link rel="stylesheet" href="${origin}/js-dos/js-dos.css?v=1">
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
    #dos-container { width: 100%; height: 100%; }
    #dos-container canvas { display: block; margin: 0 auto; }
    .error-overlay {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      display: flex; align-items: center; justify-content: center;
      background: #000; color: #fff; font-family: monospace; padding: 20px; text-align: center;
    }
  </style>
</head>
<body>
  <div id="dos-container"></div>
  <div id="error-overlay" class="error-overlay" style="display:none;"></div>
  <script>
    var zipUrl = '${zipUrl}';
    var loadFailedMsg = ${JSON.stringify(loadFailed)};
    var loadAttempts = 0;

    function showError(msg) {
      var overlay = document.getElementById('error-overlay');
      if (overlay) {
        overlay.style.display = 'flex';
        overlay.textContent = msg;
      }
    }

    function checkSupport() {
      var issues = [];
      if (typeof WebAssembly === 'undefined') {
        issues.push('WebAssembly not available');
      }
      try {
        var canvas = document.createElement('canvas');
        var gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
        if (!gl) {
          issues.push('WebGL not available');
        }
      } catch (e) {
        issues.push('WebGL check failed: ' + e.message);
      }
      if (issues.length) {
        showError(loadFailedMsg + ' (' + issues.join('; ') + ')');
        console.error('DOS support check failed:', issues);
        return false;
      }
      return true;
    }

    function loadJsdos() {
      return new Promise(function (resolve, reject) {
        var src;
        if (loadAttempts === 0) {
          src = '${origin}/js-dos/js-dos.js?v=' + Date.now();
        } else if (loadAttempts === 1) {
          src = 'https://v8.js-dos.com/latest/js-dos.js';
        } else {
          reject(new Error('All js-dos sources failed'));
          return;
        }
        loadAttempts++;
        console.log('DOS: fetching', src);
        fetch(src).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        }).then(function (code) {
          try {
            (new Function(code))();
            if (typeof window.Dos !== 'undefined') {
              console.log('DOS: loaded from', src);
              resolve();
            } else {
              console.warn('DOS: loaded but Dos undefined from', src);
              loadJsdos().then(resolve).catch(reject);
            }
          } catch (e) {
            console.warn('DOS: eval error from', src, e);
            loadJsdos().then(resolve).catch(reject);
          }
        }).catch(function (e) {
          console.error('DOS: fetch failed from', src, e);
          loadJsdos().then(resolve).catch(reject);
        });
      });
    }

    async function init() {
      var container = document.getElementById('dos-container');
      var errorOverlay = document.getElementById('error-overlay');
      var diagnostics = [];

      if (!checkSupport()) return;

      diagnostics.push('SAB=' + (typeof SharedArrayBuffer !== 'undefined'));
      diagnostics.push('isolated=' + window.crossOriginIsolated);
      diagnostics.push('ua=' + navigator.userAgent.substring(0, 80));
      console.log('DOS: init ' + diagnostics.join(' | '));

      try {
        console.log('DOS: loading js-dos...');
        await loadJsdos();
        console.log('DOS: js-dos loaded, initializing Dos()...');
        await Dos(container, {
          url: zipUrl,
          autolock: true,
          workerThread: false,
          pathPrefix: '${origin}/js-dos/emulators/'
        });
        console.log('DOS: Dos() initialized successfully');
      } catch (err) {
        console.error('DOS Player error:', err);
        errorOverlay.style.display = 'flex';
        errorOverlay.textContent = loadFailedMsg + ' (' + (err instanceof Error ? err.message : String(err)) + ')';
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  </script>
</body>
</html>`

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Cross-Origin-Embedder-Policy': 'credentialless'
      }
    })
  } catch (error: any) {
    console.error('DOS player error:', error)
    return c.json({ error: 'Failed to serve DOS player', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/zip/:postId - serve ZIP files from R2 (supports zip/ and dos/ prefixes)
app.get('/api/zip/:postId', async (c) => {
  try {
    const postId = c.req.param('postId')
    
    if (!postId) {
      return c.json({ error: 'Missing post ID' }, 400)
    }
    
    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500)
    }
    
    // Try HTML5 ZIP key first, then DOS ZIP key, then JSDOS key
    const keysToTry = [`zip/${postId}.zip`, `dos/${postId}.zip`, `jsdos/${postId}.jsdos`]
    let object = null
    
    for (const zipKey of keysToTry) {
      object = await c.env.BUCKET.get(zipKey)
      if (object) break
    }
    
    if (!object) {
      return c.json({ error: 'ZIP not found' }, 404)
    }
    
    // Return the ZIP with proper headers (echo origin for sandboxed iframe null-origin support)
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/zip',
        'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
        'Access-Control-Allow-Origin': c.req.header('Origin') || '*',
        'Access-Control-Allow-Credentials': 'true',
        'Cross-Origin-Resource-Policy': 'cross-origin'
      }
    })
  } catch (error: any) {
    console.error('ZIP proxy error:', error)
    return c.json({ error: 'Failed to fetch ZIP', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/wvfs-zip/:postId/* - redirect to sandbox.flaxia.app
app.get('/api/wvfs-zip/:postId/*', (c) => {
  return c.redirect(`https://sandbox.flaxia.app${c.req.path}`, 301)
})

// GET /api/ads/:id/payload - serve ad payloads from R2
app.get('/api/ads/:id/payload', async (c) => {
  try {
    const adId = c.req.param('id')
    
    if (!adId) {
      return c.json({ error: 'Missing ad ID' }, 400)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500)
    }
    
    // Fetch ad to get payload_key, payload_type, and thumbnail_key
    const ad = await c.env.DB.prepare('SELECT payload_key, payload_type, thumbnail_key FROM ads WHERE id = ?')
      .bind(adId).first()
    
    if (!ad) {
      return c.json({ error: 'Ad not found' }, 404)
    }
    
    if (!ad.payload_key) {
      return c.json({ error: 'No payload available' }, 404)
    }
    
    // Get object from R2
    const object = await c.env.BUCKET.get(ad.payload_key as string)
    
    if (!object) {
      return c.json({ error: 'Payload not found' }, 404)
    }
    
    // Determine content type based on payload_type
    let contentType = 'application/octet-stream'
    switch (ad.payload_type) {
      case 'zip':
        contentType = 'application/zip'
        break
      case 'swf':
        contentType = 'application/x-shockwave-flash'
        break
      case 'gif':
        contentType = 'image/gif'
        break
      case 'image':
        // Detect from key extension
        const extension = (ad.payload_key as string).split('.').pop()?.toLowerCase()
        if (extension === 'png') {
          contentType = 'image/png'
        } else if (extension === 'jpg' || extension === 'jpeg') {
          contentType = 'image/jpeg'
        } else if (extension === 'gif') {
          contentType = 'image/gif'
        } else if (extension === 'webp') {
          contentType = 'image/webp'
        }
        break
    }
    
    // Return the payload with proper headers
    return new Response(object.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch (error: any) {
    console.error('Ad payload error:', error)
    return c.json({ error: 'Failed to fetch ad payload', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/thumbnail/:id - serve thumbnail images from R2 (posts)
app.get('/api/thumbnail/:id', async (c) => {
  try {
    const postId = c.req.param('id')
    
    if (!postId) {
      return c.json({ error: 'Missing post ID' }, 400)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500)
    }
    
    // First try to get from posts table
    let post = await c.env.DB.prepare('SELECT thumbnail_key FROM posts WHERE id = ?')
      .bind(postId).first()
    
    // If not found in posts, try ads table
    if (!post || !post.thumbnail_key) {
      const ad = await c.env.DB.prepare('SELECT thumbnail_key FROM ads WHERE id = ?')
        .bind(postId).first()
      
      if (!ad || !ad.thumbnail_key) {
        return c.json({ error: 'Thumbnail not found' }, 404)
      }
      
      post = ad
    }
    
    // Get thumbnail object from R2
    const object = await c.env.BUCKET.get(post.thumbnail_key as string)
    
    if (!object) {
      return c.json({ error: 'Thumbnail file not found' }, 404)
    }
    
    // Determine content type based on file extension
    let contentType = 'image/jpeg' // default
    const key = post.thumbnail_key as string
    const extension = key.split('.').pop()?.toLowerCase()
    
    switch (extension) {
      case 'jpg':
      case 'jpeg':
        contentType = 'image/jpeg'
        break
      case 'png':
        contentType = 'image/png'
        break
      case 'gif':
        contentType = 'image/gif'
        break
    }
    
    // Stream the thumbnail with proper headers
    return new Response(object.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch (error: any) {
    console.error('Thumbnail proxy error:', error)
    return c.json({ error: 'Failed to fetch thumbnail', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/swf/:postId - serve SWF files from R2
app.get('/api/swf/:postId', async (c) => {
  try {
    const postId = c.req.param('postId')
    
    if (!postId) {
      return c.json({ error: 'Missing post ID' }, 400)
    }
    
    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500)
    }
    
    // Construct the SWF key
    const swfKey = `swf/${postId}.swf`
    
    // Get object from R2
    const object = await c.env.BUCKET.get(swfKey)
    
    if (!object) {
      return c.json({ error: 'SWF not found' }, 404)
    }
    
    // Return the SWF with proper headers (echo origin for sandboxed iframe null-origin support)
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/x-shockwave-flash',
        'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
        'Access-Control-Allow-Origin': c.req.header('Origin') || '*',
        'Access-Control-Allow-Credentials': 'true',
        'Cross-Origin-Resource-Policy': 'cross-origin'
      }
    })
  } catch (error: any) {
    console.error('SWF proxy error:', error)
    return c.json({ error: 'Failed to fetch SWF', details: error?.message || 'Unknown error' }, 500)
  }
})

// Helper functions for link preview
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
}

function parseMetaTags(html: string, baseUrl: string) {
  const result = {
    title: '',
    description: '',
    image: '',
    siteName: '',
    url: baseUrl,
    type: '',
    video: {
      url: '',
      secureUrl: '',
      type: '',
      width: 0,
      height: 0
    }
  }

  const matchMeta = (property: string): string | null => {
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i')
    ]
    for (const p of patterns) {
      const m = html.match(p)
      if (m) return m[1]
    }
    return null
  }

  const matchMetaName = (name: string): string | null => {
    const patterns = [
      new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i')
    ]
    for (const p of patterns) {
      const m = html.match(p)
      if (m) return m[1]
    }
    return null
  }

  const resolveUrl = (url: string): string => {
    if (url.startsWith('//')) {
      try { return new URL(url, baseUrl).toString() } catch {}
    } else if (url.startsWith('/') || url.startsWith('.')) {
      try { return new URL(url, baseUrl).toString() } catch {}
    }
    return url
  }

  // 1. Title
  const ogTitle = matchMeta('og:title') || matchMetaName('twitter:title')
  if (ogTitle) {
    result.title = decodeHtmlEntities(ogTitle)
  } else {
    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    if (titleTag) {
      result.title = decodeHtmlEntities(titleTag[1].trim())
    }
  }

  // 2. Description
  const ogDesc = matchMeta('og:description') || matchMetaName('description') || matchMetaName('twitter:description')
  if (ogDesc) {
    result.description = decodeHtmlEntities(ogDesc)
  }

  // 3. Image
  const ogImage = matchMeta('og:image') || matchMetaName('twitter:image')
  if (ogImage) {
    result.image = resolveUrl(ogImage)
  }

  // 4. Site Name
  const ogSiteName = matchMeta('og:site_name')
  if (ogSiteName) {
    result.siteName = decodeHtmlEntities(ogSiteName)
  } else {
    try {
      result.siteName = new URL(baseUrl).hostname
    } catch {}
  }

  // 5. og:type
  const ogType = matchMeta('og:type')
  if (ogType) {
    result.type = ogType
  }

  // 6. Video embed info
  const ogVideoUrl = matchMeta('og:video:url') || matchMeta('og:video')
  const ogVideoSecureUrl = matchMeta('og:video:secure_url')
  const ogVideoType = matchMeta('og:video:type')
  const ogVideoWidth = matchMeta('og:video:width')
  const ogVideoHeight = matchMeta('og:video:height')

  if (ogVideoUrl) {
    result.video.url = resolveUrl(ogVideoUrl)
  }
  if (ogVideoSecureUrl) {
    result.video.secureUrl = ogVideoSecureUrl
  }
  if (ogVideoType) {
    result.video.type = ogVideoType
  }
  if (ogVideoWidth) {
    result.video.width = parseInt(ogVideoWidth, 10) || 0
  }
  if (ogVideoHeight) {
    result.video.height = parseInt(ogVideoHeight, 10) || 0
  }

  return result
}

function isPrivateIP(hostname: string): boolean {
  // IPv4
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4Match) {
    const octets = [ipv4Match[1], ipv4Match[2], ipv4Match[3], ipv4Match[4]].map(Number)
    if (octets.some(o => o > 255)) return true
    const [a, b] = octets
    // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)) return true
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true
    // 100.64.0.0/10 (CGNAT)
    if (a === 100 && b >= 64 && b <= 127) return true
    // 198.18.0.0/15
    if (a === 198 && (b === 18 || b === 19)) return true
    return false
  }
  // IPv6
  if (hostname.includes(':') && hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1)
  }
  if (hostname.includes(':')) {
    const normalized = hostname.toLowerCase()
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true
    if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  }
  return false
}

function isInternalHostname(hostname: string): string | null {
  const lower = hostname.toLowerCase()
  // Strip trailing dot for FQDN
  const name = lower.endsWith('.') ? lower.slice(0, -1) : lower
  const internalNames = new Set([
    'localhost', 'localhost.localdomain', 'local', 'broadcasthost',
    'metadata.google.internal', 'metadata', '169.254.169.254',
  ])
  if (internalNames.has(name)) return name
  // Block any hostname ending in .internal, .local, .localhost
  if (name.endsWith('.internal') || name.endsWith('.local') || name.endsWith('.localhost')) return name
  return null
}

function checkSSRF(url: URL): string | null {
  const hostname = url.hostname
  // Strip brackets from IPv6
  const cleanHost = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (isPrivateIP(cleanHost)) return 'Requests to private IP addresses are not allowed'
  const internal = isInternalHostname(hostname)
  if (internal) return `Requests to ${internal} are not allowed`
  return null
}

// GET /api/link-preview - Scrape OpenGraph meta tags of a URL
app.get('/api/link-preview', async (c) => {
  const urlString = c.req.query('url')
  if (!urlString) {
    return c.json({ error: 'Missing url parameter' }, 400)
  }

  try {
    const targetUrl = new URL(urlString)
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      return c.json({ error: 'Invalid protocol' }, 400)
    }

    const blockedHost = checkSSRF(targetUrl)
    if (blockedHost) {
      return c.json({ error: blockedHost }, 400)
    }

    const response = await fetch(targetUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 FlaxiaPreviewBot/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      },
      redirect: 'follow'
    })

    if (!response.ok) {
      return c.json({ error: `Failed to fetch URL: ${response.statusText}` }, 400)
    }

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/html')) {
      return c.json({
        title: targetUrl.pathname.split('/').pop() || targetUrl.hostname,
        description: '',
        image: contentType.startsWith('image/') ? targetUrl.toString() : '',
        siteName: targetUrl.hostname,
        url: targetUrl.toString()
      })
    }

    const reader = response.body?.getReader()
    let html = ''
    if (reader) {
      const decoder = new TextDecoder('utf-8')
      let bytesRead = 0
      const maxBytes = 256 * 1024 // 256KB
      
      while (bytesRead < maxBytes) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          bytesRead += value.length
          html += decoder.decode(value, { stream: true })
        }
      }
      html += decoder.decode()
    } else {
      html = await response.text()
    }

    const previewData = parseMetaTags(html, targetUrl.toString())
    return c.json(previewData)
  } catch (error: any) {
    console.error('Link preview error:', error)
    return c.json({ error: 'Failed to fetch link preview', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/me - check auth state
app.get('/api/me', requireAuth, async (c) => {
  try {
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getMeWithSession(c.env, token) : null
    if (!sessionData) {
      return c.json({ error: 'Not authenticated' }, 401)
    }
    
    // Extend session (sliding window) - keep user logged in if active
    if (token) {
      await extendSession(c.env, token)
    }
    
    return c.json({ 
      user: {
        ...sessionData.user,
        ng_words: JSON.parse(sessionData.user.ng_words ?? '[]') as string[]
      }
    })
  } catch (error: any) {
    console.error('Auth check error:', error)
    return c.json({ error: 'Auth check failed' }, 500)
  }
})

// GET /api/games - get games (posts with SWF or ZIP payloads) for the arcade
app.get('/api/games', async (c) => {
  try {
    const shuffle = c.req.query('shuffle') === 'true'
    const trending = c.req.query('trending') === 'true'
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50)
    const cursor = c.req.query('cursor')
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Generate cache key based on query parameters
    const cacheKey = `games:${shuffle ? 'shuffle' : trending ? 'trending' : 'recent'}:${limit}:${cursor || 'first'}`

    // Try cache only for non-shuffle requests
    if (!shuffle) {
      const cachedData = await c.env.CACHE?.get(cacheKey)
      if (cachedData && !cursor) {
        const parsed = JSON.parse(cachedData)

        const token = getSessionToken(c.req.raw)
        const sessionData = token ? await getSession(c.env, token) : null
        const currentUserId = sessionData?.user?.id

        if (currentUserId && parsed.games.length > 0) {
          const gameIds = parsed.games.map((g: any) => g.id)
          const freshResults = await c.env.DB.prepare(`
            SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${gameIds.map(() => '?').join(',')})
          `).bind(currentUserId, ...gameIds).all()

          const freshedPostIds = new Set(freshResults.results?.map((r: any) => r.post_id) || [])

          parsed.games.forEach((game: any) => {
            game.isFreshed = freshedPostIds.has(game.id)
          })
        }

        return c.json(parsed)
      }
    }

    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    const currentUserId = sessionData?.user?.id

    if (shuffle) {
      const shuffleToken = c.req.query('token')
      const offset = Math.max(0, Number(c.req.query('offset') || '0'))
      const initialId = c.req.query('initialId')
      
      let shuffledIds: string[] = []
      let currentToken = shuffleToken
      
      if (currentToken) {
        const cached = await c.env.CACHE?.get(`games:shuffle:${currentToken}`)
        if (cached) {
          shuffledIds = JSON.parse(cached)
        } else {
          currentToken = undefined
        }
      }
      
      if (!currentToken) {
        const idResults = await c.env.DB.prepare(`
          SELECT p.id FROM posts p
          WHERE (p.swf_key IS NOT NULL OR p.payload_key IS NOT NULL)
            AND p.status = 'published'
            AND p.hidden = 0
            AND p.parent_id IS NULL
          ORDER BY p.created_at DESC
        `).all()
        
        shuffledIds = (idResults.results || []).map((r: any) => r.id)
        
        for (let i = shuffledIds.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffledIds[i], shuffledIds[j]] = [shuffledIds[j], shuffledIds[i]]
        }

        // If initialId is provided, move it to the front
        if (initialId) {
          const idx = shuffledIds.indexOf(initialId)
          if (idx !== -1) {
            shuffledIds.splice(idx, 1)
            shuffledIds.unshift(initialId)
          } else {
            // Check if the initialId exists and is actually a game post
            const check = await c.env.DB.prepare(`
              SELECT id FROM posts 
              WHERE id = ? AND (swf_key IS NOT NULL OR payload_key IS NOT NULL)
                AND status = 'published' AND hidden = 0
            `).bind(initialId).first()
            if (check) {
              shuffledIds.unshift(initialId)
            }
          }
        }
        
        currentToken = crypto.randomUUID()
        
        await c.env.CACHE?.put(`games:shuffle:${currentToken}`, JSON.stringify(shuffledIds), {
          expirationTtl: 300
        })
      }
      
      const pageIds = shuffledIds.slice(offset, offset + limit)
      const newOffset = offset + pageIds.length
      const hasMore = newOffset < shuffledIds.length
      
      let shuffledGames: any[] = []
      
      if (pageIds.length > 0) {
        const placeholders = pageIds.map(() => '?').join(',')
        const { results: sliceData } = await c.env.DB.prepare(`
          SELECT
            p.id as postId, p.user_id, p.text, p.swf_key, p.payload_key,
            p.thumbnail_key, p.fresh_count, p.reply_count, p.bookmark_count, p.impressions, p.created_at,
            u.username, u.display_name, u.avatar_key
          FROM posts p
          JOIN users u ON p.user_id = u.id
          WHERE p.id IN (${placeholders})
        `).bind(...pageIds).all<{
          postId: string
          user_id: string
          text: string
          swf_key: string | null
          payload_key: string | null
          thumbnail_key: string | null
          fresh_count: number
          reply_count: number
          impressions: number
          created_at: string
          username: string
          display_name: string | null
          avatar_key: string | null
        }>()
        
        const gameMap = new Map((sliceData || []).map(r => [r.postId, r]))
        
        let sliceFreshedPostIds: Set<string> = new Set()
        if (currentUserId && sliceData && sliceData.length > 0) {
          const slicePostIds = sliceData.map(r => r.postId)
          const freshResults = await c.env.DB.prepare(`
            SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${slicePostIds.map(() => '?').join(',')})
          `).bind(currentUserId, ...slicePostIds).all()
          sliceFreshedPostIds = new Set(freshResults.results?.map((r: any) => r.post_id) || [])
        }
        
        shuffledGames = pageIds.map(id => {
          const row = gameMap.get(id)
          if (!row) return null
          let type: string
          if (row.swf_key) type = 'flash'
          else if (row.payload_key && row.payload_key.startsWith('dos/')) type = 'dos'
          else type = 'zip'
          return {
            id: row.postId,
            postId: row.postId,
            title: row.text?.substring(0, 100) || `Game by @${row.username}`,
            username: row.username,
            displayName: row.display_name || undefined,
            avatarKey: row.avatar_key || undefined,
            type,
            swfKey: row.swf_key || undefined,
            payloadKey: row.payload_key || undefined,
            thumbnailKey: row.thumbnail_key || undefined,
            freshCount: row.fresh_count,
            replyCount: row.reply_count,
            impressions: row.impressions,
            isFreshed: sliceFreshedPostIds.has(row.postId),
            createdAt: row.created_at
          }
        }).filter(Boolean)
      }
      
      return c.json({
        games: shuffledGames,
        hasMore,
        token: currentToken,
        offset: newOffset
      })
    }

    let sql = `
      SELECT
        p.id as postId,
        p.user_id,
        p.text,
        p.swf_key,
        p.payload_key,
        p.thumbnail_key,
        p.fresh_count,
        p.reply_count,
        p.impressions,
        p.created_at,
        u.username,
        u.display_name,
        u.avatar_key
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE (p.swf_key IS NOT NULL OR p.payload_key IS NOT NULL)
        AND p.status = 'published'
        AND p.hidden = 0
        AND p.parent_id IS NULL
    `
    
    const params: (string | number)[] = []
    
    if (cursor) {
      sql += ' AND p.created_at < ?'
      params.push(cursor)
    }
    
    if (trending) {
      sql += ' ORDER BY (p.fresh_count + p.impressions) DESC, p.created_at DESC'
    } else {
      sql += ' ORDER BY p.created_at DESC'
    }
    
    sql += ' LIMIT ?'
    params.push(limit + 1)

    const { results } = await c.env.DB.prepare(sql).bind(...params).all<{
      postId: string
      user_id: string
      text: string
      swf_key: string | null
      payload_key: string | null
      thumbnail_key: string | null
      fresh_count: number
      reply_count: number
      impressions: number
      created_at: string
      username: string
      display_name: string | null
      avatar_key: string | null
    }>()

    let freshedPostIds: Set<string> = new Set()
    if (currentUserId && results.length > 0) {
      const postIds = results.map(row => row.postId)
      const freshResults = await c.env.DB.prepare(`
        SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})
      `).bind(currentUserId, ...postIds).all()
      
      freshedPostIds = new Set(freshResults.results?.map((r: any) => r.post_id) || [])
    }

    const games = (results || []).map(row => {
      let type: string
      if (row.swf_key) {
        type = 'flash'
      } else if (row.payload_key && row.payload_key.startsWith('dos/')) {
        type = 'dos'
      } else {
        type = 'zip'
      }
      return {
        id: row.postId,
        postId: row.postId,
        title: row.text?.substring(0, 100) || `Game by @${row.username}`,
        username: row.username,
        displayName: row.display_name || undefined,
        avatarKey: row.avatar_key || undefined,
        type,
        swfKey: row.swf_key || undefined,
        payloadKey: row.payload_key || undefined,
        thumbnailKey: row.thumbnail_key || undefined,
        freshCount: row.fresh_count,
        replyCount: row.reply_count,
        impressions: row.impressions,
        isFreshed: freshedPostIds.has(row.postId),
        createdAt: row.created_at
      }
    })

    const hasMore = games.length > limit
    const trimmedGames = hasMore ? games.slice(0, limit) : games
    const nextCursor = hasMore ? trimmedGames[trimmedGames.length - 1]?.createdAt : null

    const responseData = {
      games: trimmedGames,
      hasMore,
      cursor: nextCursor
    }

    if (!cursor && c.env.CACHE) {
      try {
        const cacheData = {
          games: trimmedGames.map(game => ({
            ...game,
            isFreshed: false
          })),
          hasMore,
          cursor: nextCursor
        }
        await c.env.CACHE.put(cacheKey, JSON.stringify(cacheData), {
          expirationTtl: 300
        })
      } catch (cacheError) {
        console.warn('Failed to cache games data:', cacheError)
      }
    }

    return c.json(responseData)
  } catch (error: any) {
    console.error('Games fetch error:', error)
    return c.json({ error: 'Failed to fetch games', details: error?.message }, 500)
  }
})

// POST /api/auth/register - user registration
app.post('/api/auth/register', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  let rl = { allowed: true, remaining: 0, resetIn: 0 }
  try {
    rl = await checkRateLimit(c.env.RATE_LIMIT, {
      key: `register:${ip}`,
      limit: 3,
      windowSeconds: 3600
    })
  } catch (kvError: any) {
    console.warn('Register rate limit check failed, proceeding anyway:', kvError.message)
  }
  if (!rl.allowed) return rateLimitResponse(c, rl.resetIn, 3)

  try {
    const { email, password, username, display_name } = await c.req.json()
    
    // Validation
    if (!email || !password || !username || !display_name) {
      return c.json({ error: 'Missing required fields' }, 400)
    }
    
    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return c.json({ error: 'Invalid email format' }, 400)
    }
    
    // Password validation
    if (password.length < 8 || password.length > 128) {
      return c.json({ error: 'Password must be 8-128 characters' }, 400)
    }
    
    // Username validation
    const usernameRegex = /^[a-zA-Z0-9_]{1,20}$/
    if (!usernameRegex.test(username)) {
      return c.json({ error: 'Username must be 1-20 alphanumeric characters' }, 400)
    }
    
    // Display name validation
    if (display_name.length > 50) {
      return c.json({ error: 'Display name must be ≤50 characters' }, 400)
    }
    
    // Register user with custom auth
    const user = await registerUser(c.env, {
      email,
      password,
      username,
      display_name
    })
    
    return c.json({ user })
  } catch (error: any) {
    console.error('Registration error:', error)
    return c.json({ error: 'Registration failed', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/auth/login - user login
app.post('/api/auth/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  let rl = { allowed: true, remaining: 0, resetIn: 0 }
  try {
    rl = await checkRateLimit(c.env.RATE_LIMIT, {
      key: `login:${ip}`,
      limit: 20,
      windowSeconds: 3600
    })
  } catch (kvError: any) {
    console.warn('Login rate limit check failed, proceeding anyway:', kvError.message)
  }
  if (!rl.allowed) return rateLimitResponse(c, rl.resetIn, 20)

  try {
    const { email, password } = await c.req.json()
    
    if (!email || !password) {
      return c.json({ error: 'Email and password required' }, 400)
    }
    
    // Login with custom auth
    const result = await loginUser(c.env, email, password)
    
    // Set session cookie
    const isSecure = c.req.url.startsWith('https')
    const response = c.json({ user: result.user })
    setSessionCookie(response, result.session.id, isSecure)
    
    return response
  } catch (error: any) {
    console.error('Login error:', error)
    return c.json({ error: 'Login failed', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/auth/logout - user logout (protected)
app.post('/api/auth/logout', requireAuth, async (c) => {
  try {
    const token = getSessionToken(c.req.raw)
    if (token) {
      await deleteSession(c.env, token)
    }
    
    // Clear session cookie
    const isSecure = c.req.url.startsWith('https')
    const response = c.json({ success: true })
    clearSessionCookie(response, isSecure)
    
    return response
  } catch (error: any) {
    console.error('Logout error:', error)
    return c.json({ error: 'Logout failed', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/users/suggestions - get user suggestions for "who to follow"
app.get('/api/users/suggestions', async (c) => {
  try {
    // Get current user from session
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    
    // If not authenticated, return empty list
    if (!sessionData || !c.env.DB) {
      return c.json({ users: [] })
    }
    
    const currentUserId = sessionData.user.id
    
    // Get suggestions: users not followed by current user and not self
    const suggestions = await c.env.DB.prepare(`
      SELECT id, username, display_name, avatar_key
      FROM users
      WHERE id != ?
      AND id NOT IN (
        SELECT followee_id FROM follows WHERE follower_id = ?
      )
      ORDER BY RANDOM()
      LIMIT 3
    `).bind(currentUserId, currentUserId).all()
    
    return c.json({ users: suggestions.results || [] })
  } catch (error: any) {
    console.error('User suggestions error:', error)
    return c.json({ users: [] })
  }
})

// POST /api/follows/:id - follow a user by ID (protected)
app.post('/api/follows/:id', requireAuth, async (c) => {
  try {
    const followeeId = c.req.param('id')
    
    if (!followeeId) {
      return c.json({ error: 'User ID required' }, 400)
    }
    
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    if (!sessionData) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    const followerId = sessionData.user.id
    
    // Can't follow yourself
    if (followerId === followeeId) {
      return c.json({ error: 'Cannot follow yourself' }, 400)
    }
    
    // Check if target user exists
    const targetUser = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
      .bind(followeeId).first()
    
    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404)
    }
    
    // Insert follow relationship (idempotent with INSERT OR IGNORE)
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)'
    ).bind(followerId, followeeId).run()
    
    return c.json({ success: true })
  } catch (error: any) {
    console.error('Follow error:', error)
    return c.json({ error: 'Failed to follow user', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/remote-follow - follow a remote ActivityPub user (protected)
app.post('/api/remote-follow', requireAuth, async (c) => {
  try {
    const { target } = await c.req.json() as { target?: string }
    if (!target || !target.includes('@')) {
      return c.json({ error: 'Invalid target format. Expected user@domain' }, 400)
    }

    const [remoteUsername, domain] = target.split('@')
    if (!remoteUsername || !domain) {
      return c.json({ error: 'Invalid target format. Expected user@domain' }, 400)
    }

    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    if (!sessionData) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const localUser = sessionData.user

    // Resolve remote user via WebFinger
    const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=acct:${remoteUsername}@${domain}`
    const wfResponse = await fetch(webfingerUrl, {
      headers: { 'Accept': 'application/jrd+json, application/json' }
    })

    if (!wfResponse.ok) {
      return c.json({ error: 'Could not resolve remote user' }, 404)
    }

    const wfData = await wfResponse.json() as any
    const selfLink = wfData.links?.find((l: any) => l.rel === 'self')
    if (!selfLink?.href) {
      return c.json({ error: 'Remote user has no ActivityPub actor link' }, 400)
    }

    const actorUrl = selfLink.href

    // Fetch actor to get inbox URL
    const actorResponse = await fetch(actorUrl, {
      headers: { 'Accept': 'application/activity+json, application/ld+json' }
    })

    if (!actorResponse.ok) {
      return c.json({ error: 'Could not fetch remote actor' }, 404)
    }

    const actorData = await actorResponse.json() as any
    const inboxUrl = actorData.inbox
    if (!inboxUrl) {
      return c.json({ error: 'Remote actor has no inbox' }, 400)
    }

    // Check if already following
    const existing = await c.env.DB.prepare(
      'SELECT id FROM ap_following WHERE local_user_id = ? AND target_actor_url = ?'
    ).bind(localUser.id, actorUrl).first()

    if (existing) {
      return c.json({ error: 'Already following this user' }, 409)
    }

    // Store in ap_following table
    const followId = nanoid()
    await c.env.DB.prepare(`
      INSERT INTO ap_following (id, local_user_id, target_actor_url, target_inbox_url, target_username, target_domain, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
    `).bind(followId, localUser.id, actorUrl, inboxUrl, remoteUsername, domain).run()

    // Build Follow activity
    const followActivity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${c.env.BASE_URL}/activities/follow-${followId}`,
      type: 'Follow',
      actor: `${c.env.BASE_URL}/actors/${localUser.username}`,
      object: actorUrl,
      to: [actorUrl]
    }

    // Queue delivery of Follow activity
    if (c.env.AP_DELIVERY_QUEUE) {
      await c.env.AP_DELIVERY_QUEUE.send({
        type: 'delivery',
        inboxUrl,
        activity: followActivity,
        senderUsername: localUser.username
      })
    }

    // Update status to sent
    await c.env.DB.prepare(
      'UPDATE ap_following SET status = ? WHERE id = ?'
    ).bind('sent', followId).run()

    return c.json({
      following: true,
      target: target,
      status: 'pending',
      message: 'Follow request sent to remote user'
    })
  } catch (error: any) {
    console.error('Remote follow error:', error)
    return c.json({ error: 'Failed to follow remote user', details: error?.message || 'Unknown error' }, 500)
  }
})

// DELETE /api/remote-follow - unfollow a remote ActivityPub user (protected)
app.delete('/api/remote-follow', requireAuth, async (c) => {
  try {
    const { target } = await c.req.json() as { target?: string }
    if (!target || !target.includes('@')) {
      return c.json({ error: 'Invalid target format. Expected user@domain' }, 400)
    }

    const [remoteUsername, domain] = target.split('@')
    if (!remoteUsername || !domain) {
      return c.json({ error: 'Invalid target format. Expected user@domain' }, 400)
    }

    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    if (!sessionData) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const localUser = sessionData.user

    // Resolve remote user via WebFinger
    const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=acct:${remoteUsername}@${domain}`
    const wfResponse = await fetch(webfingerUrl, {
      headers: { 'Accept': 'application/jrd+json, application/json' }
    })

    if (!wfResponse.ok) {
      return c.json({ error: 'Could not resolve remote user' }, 404)
    }

    const wfData = await wfResponse.json() as any
    const selfLink = wfData.links?.find((l: any) => l.rel === 'self')
    if (!selfLink?.href) {
      return c.json({ error: 'Remote user has no ActivityPub actor link' }, 400)
    }

    const actorUrl = selfLink.href

    // Find the existing following record
    const following = await c.env.DB.prepare(
      'SELECT id, target_inbox_url FROM ap_following WHERE local_user_id = ? AND target_actor_url = ?'
    ).bind(localUser.id, actorUrl).first() as { id: string; target_inbox_url: string } | null

    if (!following) {
      return c.json({ error: 'Not following this user' }, 404)
    }

    // Delete from database
    await c.env.DB.prepare('DELETE FROM ap_following WHERE id = ?')
      .bind(following.id).run()

    // Build Undo Follow activity
    const followActivityId = `${c.env.BASE_URL}/activities/follow-${following.id}`
    const undoActivity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${c.env.BASE_URL}/activities/undo-${following.id}`,
      type: 'Undo',
      actor: `${c.env.BASE_URL}/actors/${localUser.username}`,
      object: {
        id: followActivityId,
        type: 'Follow',
        actor: `${c.env.BASE_URL}/actors/${localUser.username}`,
        object: actorUrl
      },
      to: [actorUrl]
    }

    // Queue delivery of Undo activity
    if (c.env.AP_DELIVERY_QUEUE && following.target_inbox_url) {
      await c.env.AP_DELIVERY_QUEUE.send({
        type: 'delivery',
        inboxUrl: following.target_inbox_url,
        activity: undoActivity,
        senderUsername: localUser.username
      })
    }

    return c.json({
      following: false,
      target: target,
      message: 'Unfollow request sent to remote user'
    })
  } catch (error: any) {
    console.error('Remote unfollow error:', error)
    return c.json({ error: 'Failed to unfollow remote user', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/.well-known/webfinger - WebFinger endpoint for ActivityPub
app.get('/api/.well-known/webfinger', async (c) => {
  try {
    const resource = c.req.query('resource')
    
    if (!resource) {
      return c.json({ error: 'Missing resource parameter' }, 400)
    }
    
    // Parse resource parameter: acct:username@domain
    const match = resource.match(/^acct:([^@]+)@(.+)$/)
    if (!match) {
      return c.json({ error: 'Invalid resource format' }, 400)
    }
    
    const [, username, domain] = match
    if (!username) {
      return c.json({ error: 'User not found' }, 404)
    }
    
    // Verify domain matches our BASE_URL
    const baseUrl = new URL(c.env.BASE_URL)
    if (domain !== baseUrl.hostname) {
      return c.json({ error: 'Domain mismatch' }, 400)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    // Check if user exists (case-insensitive)
    const user = await c.env.DB.prepare('SELECT username FROM users WHERE username = ? COLLATE NOCASE')
      .bind(username).first()
    
    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }
    
    // Return WebFinger response
    const webfingerResponse = {
      subject: `acct:${username}@${domain}`,
      links: [
        {
          rel: 'self',
          type: 'application/activity+json',
          href: `${c.env.BASE_URL}/api/actors/${username}`
        }
      ]
    }
    
    return c.json(webfingerResponse, 200, {
      'Content-Type': 'application/jrd+json'
    })
  } catch (error: any) {
    console.error('WebFinger error:', error)
    return c.json({ error: 'WebFinger failed' }, 500)
  }
})

// GET /api/actors/:username - ActivityPub Actor (Person) endpoint
app.get('/api/actors/:username', async (c) => {
  try {
    const username = c.req.param('username')
    const user = await c.env.DB.prepare(
      `SELECT id, username, display_name, bio, avatar_key FROM users WHERE username = ? COLLATE NOCASE`
    ).bind(username).first() as any
    if (!user) return c.json({ error: 'User not found' }, 404)

    const keyRecord = await c.env.DB.prepare(
      `SELECT public_key_pem FROM actor_keys WHERE user_id = ?`
    ).bind(user.id).first() as any
    let publicKeyPem = keyRecord?.public_key_pem
    if (!publicKeyPem) {
      const keyPair = await generateKeyPair()
      publicKeyPem = await exportPublicKey(keyPair.publicKey)
      await c.env.DB.prepare(
        `INSERT INTO actor_keys (user_id, public_key_pem, private_key_pem, created_at) VALUES (?, ?, ?, datetime('now'))`
      ).bind(user.id, publicKeyPem, await exportPrivateKey(keyPair.privateKey)).run()
    }

    const actorUrl = `${c.env.BASE_URL}/api/actors/${username}`

    const actor: any = {
      "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
      "type": "Person",
      "id": actorUrl,
      "preferredUsername": user.username,
      "name": user.display_name,
      "summary": user.bio || "",
      "url": `${c.env.BASE_URL}/users/${username}`,
      "inbox": `${c.env.BASE_URL}/api/actors/${username}/inbox`,
      "outbox": `${c.env.BASE_URL}/api/actors/${username}/outbox`,
      "followers": `${c.env.BASE_URL}/api/actors/${username}/followers`,
      "following": `${c.env.BASE_URL}/api/actors/${username}/following`,
      "publicKey": {
        "id": `${actorUrl}#main-key`,
        "owner": actorUrl,
        "publicKeyPem": publicKeyPem
      },
      "endpoints": {
        "sharedInbox": `${c.env.BASE_URL}/api/inbox`
      }
    }

    if (user.avatar_key) {
      actor.icon = {
        type: "Image",
        url: `${c.env.BASE_URL}/api/images/${user.avatar_key}`
      }
    }

    return c.json(actor, 200, { 'Content-Type': 'application/activity+json' })
  } catch (error: any) {
    console.error('Actor endpoint error:', error)
    return c.json({ error: 'Actor endpoint failed' }, 500)
  }
})

// POST /api/actors/:username/inbox - ActivityPub inbox endpoint
app.post('/api/actors/:username/inbox', async (c) => {
  try {
    const username = c.req.param('username')
    const contentType = c.req.header('content-type') || ''
    
    if (!contentType.includes('application/activity+json')) {
      return c.json({ error: 'Invalid content type' }, 400)
    }
    
    const targetUser = await c.env.DB.prepare(
      'SELECT id, username FROM users WHERE username = ? COLLATE NOCASE'
    ).bind(username).first() as { id: string, username: string } | null
    
    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404)
    }
    
    const body = await c.req.text()
    let activity: any
    try {
      activity = JSON.parse(body)
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }
    
    const actorId = activity.actor
    if (!actorId || typeof actorId !== 'string') {
      return c.json({ error: 'Invalid actor' }, 400)
    }

    // Try to get local user's keys for signed fetch (authorized fetch support)
    let signKeyPem: string | undefined
    let signKeyId: string | undefined
    try {
      const keyRecord = await c.env.DB.prepare(
        `SELECT ak.private_key_pem FROM actor_keys ak
         JOIN users u ON u.id = ak.user_id
         WHERE u.username = ? COLLATE NOCASE`
      ).bind(username).first() as { private_key_pem: string } | null
      if (keyRecord?.private_key_pem) {
        signKeyPem = keyRecord.private_key_pem
        signKeyId = `${c.env.BASE_URL}/actors/${username}#main-key`
      }
    } catch {
      // Proceed without signing
    }

    // Verify HTTP Signature (with signed fetch if keys available)
    const publicKeyPem = await fetchActorPublicKey(actorId, signKeyPem, signKeyId)
    if (!publicKeyPem) {
      return c.json({ error: 'Could not fetch actor public key' }, 401)
    }

    const sigValid = await verifyHttpSignature(c.req.raw, publicKeyPem)
    if (!sigValid) {
      return c.json({ error: 'Invalid HTTP Signature' }, 401)
    }

    const digestValid = await verifyDigest(c.req.raw, body)
    if (!digestValid) {
      return c.json({ error: 'Invalid Digest' }, 401)
    }

    // Queue for async processing
    if (c.env.AP_DELIVERY_QUEUE) {
      await c.env.AP_DELIVERY_QUEUE.send({
        type: 'inbox' as const,
        username,
        activity,
        actorId
      })
    }

    return c.json({ ok: true }, 202)
  } catch (error: any) {
    console.error('Inbox error:', error)
    return c.json({ error: 'Inbox processing failed', details: error?.message }, 500)
  }
})

// POST /api/inbox - ActivityPub sharedInbox endpoint
app.post('/api/inbox', async (c) => {
  try {
    const contentType = c.req.header('content-type') || ''

    if (!contentType.includes('application/activity+json')) {
      return c.json({ error: 'Invalid content type' }, 400)
    }

    const body = await c.req.text()
    let activity: any
    try {
      activity = JSON.parse(body)
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const actorId = activity.actor
    if (!actorId || typeof actorId !== 'string') {
      return c.json({ error: 'Invalid actor' }, 400)
    }

    // Determine target username(s) from the activity
    const baseUrl = c.env.BASE_URL

    // Try to get any local user's keys for signed fetch
    let signKeyPem: string | undefined
    let signKeyId: string | undefined
    try {
      const anyKey = await c.env.DB.prepare(
        `SELECT ak.private_key_pem, u.username FROM actor_keys ak
         JOIN users u ON u.id = ak.user_id LIMIT 1`
      ).first() as { private_key_pem: string; username: string } | null
      if (anyKey?.private_key_pem) {
        signKeyPem = anyKey.private_key_pem
        signKeyId = `${c.env.BASE_URL}/actors/${anyKey.username}#main-key`
      }
    } catch {
      // Proceed without signing
    }

    // Verify HTTP Signature (with signed fetch if keys available)
    const publicKeyPem = await fetchActorPublicKey(actorId, signKeyPem, signKeyId)
    if (!publicKeyPem) {
      return c.json({ error: 'Could not fetch actor public key' }, 401)
    }

    const sigValid = await verifyHttpSignature(c.req.raw, publicKeyPem)
    if (!sigValid) {
      return c.json({ error: 'Invalid HTTP Signature' }, 401)
    }

    const digestValid = await verifyDigest(c.req.raw, body)
    if (!digestValid) {
      return c.json({ error: 'Invalid Digest' }, 401)
    }
    const targetAudience = [activity.to, activity.cc].flat().filter(Boolean) as string[]
    const localActorUrls = targetAudience.filter((url: string) =>
      typeof url === 'string' && url.startsWith(baseUrl) && url.includes('/actors/')
    )

    // Extract usernames from local actor URLs
    const targetUsernames = new Set<string>()
    for (const url of localActorUrls) {
      const match = (url as string).match(/\/actors\/([^/]+)/)
      if (match) targetUsernames.add(match[1])
    }

    // If no local target found via to/cc, try the object field (for Follow activities)
    if (targetUsernames.size === 0 && activity.object && typeof activity.object === 'string') {
      const match = activity.object.match(/\/actors\/([^/]+)/)
      if (match) targetUsernames.add(match[1])
    }

    // Fallback: if still no target, try all local users by checking the activity object
    if (targetUsernames.size === 0 && activity.object && typeof activity.object === 'object') {
      const objId = activity.object.id || ''
      const match = objId.match(/\/actors\/([^/]+)/)
      if (match) targetUsernames.add(match[1])
    }

    if (targetUsernames.size === 0) {
      console.error(JSON.stringify({
        event: 'sharedInbox:no_target_user',
        activityType: activity.type,
        actorId,
        activityId: activity.id || null,
        timestamp: new Date().toISOString()
      }))
      return c.json({ ok: true }, 202)
    }

    // Queue for async processing for each target
    if (c.env.AP_DELIVERY_QUEUE) {
      for (const username of targetUsernames) {
        await c.env.AP_DELIVERY_QUEUE.send({
          type: 'inbox' as const,
          username,
          activity,
          actorId
        })
      }
    }

    return c.json({ ok: true }, 202)
  } catch (error: any) {
    console.error('sharedInbox error:', error)
    return c.json({ error: 'sharedInbox processing failed', details: error?.message }, 500)
  }
})

// GET /api/actors/:username/followers - ActivityPub Followers collection
app.get('/api/actors/:username/followers', async (c) => {
  try {
    const username = c.req.param('username')

    const user = await c.env.DB.prepare(
      'SELECT id FROM users WHERE username = ? COLLATE NOCASE'
    ).bind(username).first() as { id: string } | null

    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }

    const pageSize = 20
    const pageParam = c.req.query('page')

    // Count local followers
    const localCount = (await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM follows WHERE followee_id = ?'
    ).bind(user.id).first() as any).count || 0

    // Count remote followers
    const remoteCount = (await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM ap_followers WHERE local_user_id = ?'
    ).bind(user.id).first() as any).count || 0

    const totalItems = localCount + remoteCount

    // If page parameter is present, return OrderedCollectionPage
    if (pageParam) {
      const pageNum = parseInt(pageParam, 10) || 1
      const offset = (pageNum - 1) * pageSize

      // Fetch local followers (users table via follows)
      const localFollowers = await c.env.DB.prepare(`
        SELECT u.username FROM follows f
        JOIN users u ON u.id = f.follower_id
        WHERE f.followee_id = ?
        ORDER BY u.username ASC LIMIT ? OFFSET ?
      `).bind(user.id, pageSize, offset).all() as { results: Array<{ username: string }> }

      // If we still have room and it's the first page, also fetch remote followers
      const remoteFetched: Array<{ actor_url: string }> = []
      if (localFollowers.results.length < pageSize) {
        const remoteOffset = Math.max(0, offset - localCount)
        const remaining = pageSize - localFollowers.results.length
        const remoteFollowers = await c.env.DB.prepare(`
          SELECT actor_url FROM ap_followers WHERE local_user_id = ?
          ORDER BY actor_url ASC LIMIT ? OFFSET ?
        `).bind(user.id, remaining, remoteOffset).all() as { results: Array<{ actor_url: string }> }
        remoteFetched.push(...remoteFollowers.results)
      }

      const orderedItems = [
        ...localFollowers.results.map(f => `${c.env.BASE_URL}/api/actors/${f.username}`),
        ...remoteFetched.map(f => f.actor_url)
      ]

      const hasNext = (offset + pageSize) < totalItems

      return c.json({
        "@context": "https://www.w3.org/ns/activitystreams",
        "type": "OrderedCollectionPage",
        "id": `${c.env.BASE_URL}/api/actors/${username}/followers?page=${pageNum}`,
        "partOf": `${c.env.BASE_URL}/api/actors/${username}/followers`,
        "totalItems": totalItems,
        "orderedItems": orderedItems,
        ...(hasNext && { "next": `${c.env.BASE_URL}/api/actors/${username}/followers?page=${pageNum + 1}` })
      }, 200, { 'Content-Type': 'application/activity+json' })
    }

    return c.json({
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "OrderedCollection",
      "id": `${c.env.BASE_URL}/api/actors/${username}/followers`,
      "totalItems": totalItems,
      "first": `${c.env.BASE_URL}/api/actors/${username}/followers?page=1`
    }, 200, { 'Content-Type': 'application/activity+json' })
  } catch (error: any) {
    console.error('Followers endpoint error:', error)
    return c.json({ error: 'Followers endpoint failed' }, 500)
  }
})

// GET /api/actors/:username/following - ActivityPub Following collection
app.get('/api/actors/:username/following', async (c) => {
  try {
    const username = c.req.param('username')

    const user = await c.env.DB.prepare(
      'SELECT id FROM users WHERE username = ? COLLATE NOCASE'
    ).bind(username).first() as { id: string } | null

    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }

    const pageSize = 20
    const pageParam = c.req.query('page')

    // Count local following (remote following not counted here for simplicity)
    const totalCount = (await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM follows WHERE follower_id = ?'
    ).bind(user.id).first() as any).count || 0

    // If page parameter is present, return OrderedCollectionPage
    if (pageParam) {
      const pageNum = parseInt(pageParam, 10) || 1
      const offset = (pageNum - 1) * pageSize

      const following = await c.env.DB.prepare(`
        SELECT u.username FROM follows f
        JOIN users u ON u.id = f.followee_id
        WHERE f.follower_id = ?
        ORDER BY u.username ASC LIMIT ? OFFSET ?
      `).bind(user.id, pageSize, offset).all() as { results: Array<{ username: string }> }

      const orderedItems = following.results.map(f => `${c.env.BASE_URL}/api/actors/${f.username}`)
      const hasNext = (offset + pageSize) < totalCount

      return c.json({
        "@context": "https://www.w3.org/ns/activitystreams",
        "type": "OrderedCollectionPage",
        "id": `${c.env.BASE_URL}/api/actors/${username}/following?page=${pageNum}`,
        "partOf": `${c.env.BASE_URL}/api/actors/${username}/following`,
        "totalItems": totalCount,
        "orderedItems": orderedItems,
        ...(hasNext && { "next": `${c.env.BASE_URL}/api/actors/${username}/following?page=${pageNum + 1}` })
      }, 200, { 'Content-Type': 'application/activity+json' })
    }

    return c.json({
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "OrderedCollection",
      "id": `${c.env.BASE_URL}/api/actors/${username}/following`,
      "totalItems": totalCount,
      "first": `${c.env.BASE_URL}/api/actors/${username}/following?page=1`
    }, 200, { 'Content-Type': 'application/activity+json' })
  } catch (error: any) {
    console.error('Following endpoint error:', error)
    return c.json({ error: 'Following endpoint failed' }, 500)
  }
})

// GET /api/notes/:noteId - ActivityPub individual Note endpoint
app.get('/api/notes/:noteId', async (c) => {
  try {
    const noteId = c.req.param('noteId')

    if (!noteId) {
      return c.json({ error: 'Note ID required' }, 400)
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Get post with user info
    const post = await c.env.DB.prepare(`
      SELECT p.id, p.text, p.created_at, p.status, p.user_id, p.username
      FROM posts p
      WHERE p.id = ? AND p.status = 'published'
    `).bind(noteId).first() as { id: string, text: string, created_at: string, status: string, user_id: string, username: string } | null

    if (!post) {
      return c.json({ error: 'Note not found' }, 404)
    }

    // Get user info by username (posts store username, not user_id)
    const user = await c.env.DB.prepare(`
      SELECT id, username, display_name FROM users WHERE username = ? COLLATE NOCASE
    `).bind(post.username).first() as { id: string, username: string, display_name: string } | null

    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }

    // Build Note object
    const note = buildNoteObject({
      id: post.id,
      text: post.text,
      created_at: post.created_at,
      visibility: post.status === 'published' ? 'public' : 'private'
    }, user, c.env.BASE_URL)

    // Build Create activity wrapping the note
    const activity = buildCreateActivity(note, user, c.env.BASE_URL)

    return c.json(activity, 200, {
      'Content-Type': 'application/activity+json'
    })
  } catch (error: any) {
    console.error('Note endpoint error:', error)
    return c.json({ error: 'Note endpoint failed', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/actors/:username/outbox - ActivityPub Outbox endpoint (paginated)
app.get('/api/actors/:username/outbox', async (c) => {
  try {
    const username = c.req.param('username')
    const page = c.req.query('page')
    const pageSize = 20

    if (!username) {
      return c.json({ error: 'Username required' }, 400)
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Find user in database
    const user = await c.env.DB.prepare(`
      SELECT id, username, display_name FROM users 
      WHERE username = ? COLLATE NOCASE
    `).bind(username).first() as { id: string, username: string, display_name: string } | null

    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }

    // Get total count of published posts
    const countResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total FROM posts
      WHERE user_id = ? AND status = 'published'
    `).bind(user.id).first() as { total: number }
    const totalItems = countResult?.total || 0

    // If page parameter is present, return OrderedCollectionPage
    // Supports both ?page=true (legacy) and ?page=N (Mastodon-style)
    if (page !== null && page !== undefined) {
      let offsetNum = 0
      if (page === 'true') {
        offsetNum = parseInt(c.req.query('offset') || '0', 10)
      } else {
        const pageNum = parseInt(page, 10) || 1
        offsetNum = (pageNum - 1) * pageSize
      }

      // Get posts for this page
      const posts = await c.env.DB.prepare(`
        SELECT id, text, created_at, status FROM posts
        WHERE user_id = ? AND status = 'published'
        ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).bind(user.id, pageSize, offsetNum).all() as { results: Array<{ id: string, text: string, created_at: string, status: string }> }

      // Build activities from posts
      const activities = posts.results.map(post => {
        const note = buildNoteObject({
          ...post,
          visibility: post.status === 'published' ? 'public' : 'private'
        }, user, c.env.BASE_URL)
        return buildCreateActivity(note, user, c.env.BASE_URL)
      })

      const nextOffset = offsetNum + pageSize
      const hasNext = nextOffset < totalItems

      return c.json({
        "@context": "https://www.w3.org/ns/activitystreams",
        "type": "OrderedCollectionPage",
        "id": `${c.env.BASE_URL}/api/actors/${username}/outbox?page=${page}&offset=${offsetNum}`,
        "partOf": `${c.env.BASE_URL}/api/actors/${username}/outbox`,
        "totalItems": totalItems,
        "orderedItems": activities,
        ...(hasNext && { "next": `${c.env.BASE_URL}/api/actors/${username}/outbox?page=${page}&offset=${nextOffset}` })
      }, 200, { 'Content-Type': 'application/activity+json' })
    }

    // Return main OrderedCollection with first link
    return c.json({
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "OrderedCollection",
      "id": `${c.env.BASE_URL}/api/actors/${username}/outbox`,
      "totalItems": totalItems,
      "first": `${c.env.BASE_URL}/api/actors/${username}/outbox?page=1`
    }, 200, { 'Content-Type': 'application/activity+json' })
  } catch (error: any) {
    console.error('Outbox endpoint error:', error)
    return c.json({ error: 'Outbox endpoint failed', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /notes/:noteId - ActivityPub individual Note endpoint (no /api prefix)
app.get('/notes/:noteId', async (c) => {
  try {
    const noteId = c.req.param('noteId')

    if (!noteId) {
      return c.json({ error: 'Note ID required' }, 400)
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Get post with user info
    const post = await c.env.DB.prepare(`
      SELECT p.id, p.text, p.created_at, p.status, p.user_id, p.username
      FROM posts p
      WHERE p.id = ? AND p.status = 'published'
    `).bind(noteId).first() as { id: string, text: string, created_at: string, status: string, user_id: string, username: string } | null

    if (!post) {
      return c.json({ error: 'Note not found' }, 404)
    }

    // Get user info by username (posts store username, not user_id)
    const user = await c.env.DB.prepare(`
      SELECT id, username, display_name FROM users WHERE username = ? COLLATE NOCASE
    `).bind(post.username).first() as { id: string, username: string, display_name: string } | null

    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }

    // Build Note object
    const note = buildNoteObject({
      id: post.id,
      text: post.text,
      created_at: post.created_at,
      visibility: post.status === 'published' ? 'public' : 'private'
    }, user, c.env.BASE_URL)

    // Build Create activity wrapping the note
    const activity = buildCreateActivity(note, user, c.env.BASE_URL)

    return c.json(activity, 200, {
      'Content-Type': 'application/activity+json'
    })
  } catch (error: any) {
    console.error('Note endpoint error:', error)
    return c.json({ error: 'Note endpoint failed', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /.well-known/webfinger - WebFinger endpoint for ActivityPub discovery
app.get('/.well-known/webfinger', async (c) => {
  try {
    const resource = c.req.query('resource')
    if (!resource || !resource.startsWith('acct:')) {
      return c.json({ error: 'Invalid resource parameter' }, 400)
    }

    // Extract username from acct:username@domain
    const match = resource.match(/^acct:([^@]+)@/)
    if (!match) {
      return c.json({ error: 'Invalid resource format' }, 400)
    }

    const username = match[1]
    if (!username) {
      return c.json({ error: 'User not found' }, 404)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Find user in database
    const user = await c.env.DB.prepare(`
      SELECT username FROM users 
      WHERE username = ? COLLATE NOCASE
    `).bind(username).first()

    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }

    // Return WebFinger response
    return c.json({
      subject: resource,
      links: [
        {
          rel: "self",
          type: "application/activity+json",
          href: `${c.env.BASE_URL}/api/actors/${username}`
        }
      ]
    }, 200, {
      'Content-Type': 'application/jrd+json'
    })
  } catch (error: any) {
    console.error('WebFinger error:', error)
    return c.json({ error: 'WebFinger failed', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/users/:username - get public user profile
app.get('/api/users/:username', async (c) => {
  try {
    const username = c.req.param('username')
    
    if (!username) {
      return c.json({ error: 'Username required' }, 400)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    const user = await c.env.DB.prepare(`
      SELECT id, username, display_name, bio, avatar_key, created_at 
      FROM users 
      WHERE username = ? COLLATE NOCASE
    `).bind(username).first()
    
    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }
    
    // Get follow counts and post count
    const [followersResult, followingResult, postsResult] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE followee_id = ?').bind(user.id).first(),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?').bind(user.id).first(),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM posts WHERE user_id = ?').bind(user.id).first()
    ])
    
    const followers_count = (followersResult?.count as number) || 0
    const following_count = (followingResult?.count as number) || 0
    const posts_count = (postsResult?.count as number) || 0
    
    // Check if current user follows this user (if authenticated)
    let is_following = false
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    if (sessionData && sessionData.user.id !== user.id) {
      const followResult = await c.env.DB.prepare(
        'SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?'
      ).bind(sessionData.user.id, user.id).first()
      is_following = followResult !== null
    }
    
    return c.json({ 
      user: {
        ...user,
        followers_count,
        following_count,
        posts_count,
        is_following
      }
    })
  } catch (error: any) {
    console.error('Get user error:', error)
    return c.json({ error: 'Failed to get user', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/users/:username/followers - get paginated followers list
app.get('/api/users/:username/followers', async (c) => {
  try {
    const username = c.req.param('username')
    const cursor = c.req.query('cursor')
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50)
    
    if (!username) {
      return c.json({ error: 'Username required' }, 400)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    // Get target user
    const user = await c.env.DB.prepare(`
      SELECT id, username, display_name, bio, avatar_key, created_at 
      FROM users 
      WHERE username = ? COLLATE NOCASE
    `).bind(username).first()
    
    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }
    
    // Get current user for follow status (optional)
    let currentUserId: string | null = null
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    if (sessionData) {
      currentUserId = sessionData.user.id
    }
    
    // Build query for followers with cursor-based pagination
    let query = `
      SELECT 
        u.id, u.username, u.display_name, u.avatar_key,
        u.created_at,
        (SELECT COUNT(*) FROM follows WHERE followee_id = u.id) as followers_count,
        (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) as following_count,
        CASE WHEN ? IS NOT NULL AND EXISTS (
          SELECT 1 FROM follows f2 
          WHERE f2.follower_id = ? AND f2.followee_id = u.id
        ) THEN 1 ELSE 0 END as is_following
      FROM follows f
      JOIN users u ON f.follower_id = u.id
      WHERE f.followee_id = ?
    `
    
    const params: any[] = [currentUserId, currentUserId, user.id]
    
    if (cursor) {
      query += ` AND u.username > ?`
      params.push(cursor)
    }
    
    query += ` ORDER BY u.username ASC LIMIT ?`
    params.push(limit + 1) // Get one extra to check if there are more
    
    const results = await c.env.DB.prepare(query).bind(...params).all()
    
    if (!results.results) {
      return c.json({ 
        users: [], 
        next_cursor: null, 
        has_more: false 
      })
    }
    
    const users = results.results.slice(0, limit)
    const hasMore = results.results.length > limit
    const nextCursor = hasMore ? (users[users.length - 1] as any).username : null
    
    return c.json({
      users,
      next_cursor: nextCursor,
      has_more: hasMore
    })
  } catch (error: any) {
    console.error('Get followers error:', error)
    return c.json({ error: 'Failed to get followers', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/users/:username/following - get paginated following list
app.get('/api/users/:username/following', async (c) => {
  try {
    const username = c.req.param('username')
    const cursor = c.req.query('cursor')
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50)
    
    if (!username) {
      return c.json({ error: 'Username required' }, 400)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    // Get target user
    const user = await c.env.DB.prepare(`
      SELECT id, username, display_name, bio, avatar_key, created_at 
      FROM users 
      WHERE username = ? COLLATE NOCASE
    `).bind(username).first()
    
    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }
    
    // Get current user for follow status (optional)
    let currentUserId: string | null = null
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    if (sessionData) {
      currentUserId = sessionData.user.id
    }
    
    // Build query for following with cursor-based pagination
    let query = `
      SELECT 
        u.id, u.username, u.display_name, u.avatar_key,
        u.created_at,
        (SELECT COUNT(*) FROM follows WHERE followee_id = u.id) as followers_count,
        (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) as following_count,
        CASE WHEN ? IS NOT NULL AND EXISTS (
          SELECT 1 FROM follows f2 
          WHERE f2.follower_id = ? AND f2.followee_id = u.id
        ) THEN 1 ELSE 0 END as is_following
      FROM follows f
      JOIN users u ON f.followee_id = u.id
      WHERE f.follower_id = ?
    `
    
    const params: any[] = [currentUserId, currentUserId, user.id]
    
    if (cursor) {
      query += ` AND u.username > ?`
      params.push(cursor)
    }
    
    query += ` ORDER BY u.username ASC LIMIT ?`
    params.push(limit + 1) // Get one extra to check if there are more
    
    const results = await c.env.DB.prepare(query).bind(...params).all()
    
    if (!results.results) {
      return c.json({ 
        users: [], 
        next_cursor: null, 
        has_more: false 
      })
    }
    
    const users = results.results.slice(0, limit)
    const hasMore = results.results.length > limit
    const nextCursor = hasMore ? (users[users.length - 1] as any).username : null
    
    return c.json({
      users,
      next_cursor: nextCursor,
      has_more: hasMore
    })
  } catch (error: any) {
    console.error('Get following error:', error)
    return c.json({ error: 'Failed to get following', details: error?.message || 'Unknown error' }, 500)
  }
})

// PATCH /api/users/me - update current user profile (protected)
app.patch('/api/users/me', requireAuth, async (c) => {
  try {
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    if (!sessionData) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    const userId = sessionData.user.id
    let display_name: string | undefined
    let bio: string | undefined
    let language: string | undefined
    let ng_words: string[] | undefined
    let avatarFile: File | undefined
    
    const contentType = c.req.header('content-type')
    
    if (contentType?.includes('multipart/form-data')) {
      // Handle multipart/form-data (for avatar uploads)
      const formData = await c.req.formData()
      display_name = formData.get('display_name') as string | null || undefined
      bio = formData.get('bio') as string | null || undefined
      avatarFile = formData.get('avatar') as File | null || undefined
      
      // Handle avatar upload if present
      if (avatarFile && avatarFile.size > 0) {
        // Validate file type
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
        if (!allowedTypes.includes(avatarFile.type)) {
          return c.json({ error: 'Only JPEG, PNG, GIF, and WebP images are allowed' }, 400)
        }
        
        // Validate file size (1MB)
        if (avatarFile.size > 1024 * 1024) {
          return c.json({ error: 'Avatar must be ≤1MB' }, 413)
        }
        
        if (!c.env.BUCKET) {
          return c.json({ error: 'Storage not available' }, 500)
        }
        
        // Calculate file hash
        const fileBuffer = await avatarFile.arrayBuffer()
        
        // Validate magic bytes to prevent MIME spoofing
        const detected = detectMimeType(fileBuffer)
        if (!isAllowedImageMime(detected)) {
          return c.json({ error: 'File content does not match allowed image types' }, 400)
        }
        const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer)
        const hashArray = Array.from(new Uint8Array(hashBuffer))
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
        
        // Check if file with same hash already exists
        const existingKey = `avatar/${hashHex}`
        const existingObject = await c.env.BUCKET.head(existingKey)
        
        let avatarKey: string
        if (existingObject) {
          // Use existing file
          avatarKey = existingKey
          console.log('Reusing existing avatar file:', avatarKey)
        } else {
          // Upload new file with hash as key
          avatarKey = existingKey
          await c.env.BUCKET.put(avatarKey, fileBuffer, {
            httpMetadata: {
              contentType: avatarFile.type
            }
          })
          console.log('Uploaded new avatar file:', avatarKey)
        }
        
        // Update avatar_key in database
        await c.env.DB.prepare('UPDATE users SET avatar_key = ? WHERE id = ?')
          .bind(avatarKey, userId).run()
      }
    } else {
      // Handle JSON request (for text-only updates)
      const body = await c.req.json()
      display_name = body.display_name
      bio = body.bio
      language = body.language
      ng_words = body.ng_words
    }
    
    // Validation
    if (display_name !== undefined && display_name.length > 50) {
      return c.json({ error: 'Display name must be ≤50 characters' }, 400)
    }
    
    if (bio !== undefined && bio.length > 200) {
      return c.json({ error: 'Bio must be ≤200 characters' }, 400)
    }
    
    if (language !== undefined && !['en', 'ja'].includes(language)) {
      return c.json({ error: 'Language must be either "en" or "ja"' }, 400)
    }
    
    if (ng_words !== undefined) {
      if (!Array.isArray(ng_words)) {
        return c.json({ error: 'ng_words must be an array' }, 400)
      }
      if (ng_words.length > 100) {
        return c.json({ error: 'Maximum 100 NG words allowed' }, 400)
      }
      for (const word of ng_words) {
        if (typeof word !== 'string') {
          return c.json({ error: 'All NG words must be strings' }, 400)
        }
        if (word.length > 50) {
          return c.json({ error: 'Each NG word must be ≤50 characters' }, 400)
        }
      }
    }
    
    // Build update query for text fields
    const updates: string[] = []
    const values: (string | null)[] = []
    
    if (display_name !== undefined) {
      updates.push('display_name = ?')
      values.push(display_name)
    }
    
    if (bio !== undefined) {
      updates.push('bio = ?')
      values.push(bio)
    }
    
    if (language !== undefined) {
      updates.push('language = ?')
      values.push(language)
    }
    
    if (ng_words !== undefined) {
      updates.push('ng_words = ?')
      values.push(JSON.stringify(ng_words))
    }
    
    if (updates.length > 0) {
      values.push(userId)
      
      const result = await c.env.DB.prepare(`
        UPDATE users SET ${updates.join(', ')} WHERE id = ?
      `).bind(...values).run()
      
      if (!result.success) {
        return c.json({ error: 'Failed to update profile' }, 500)
      }
    }
    
    // Return updated user
    type UpdatedUserRow = {
      id: string
      email: string
      username: string
      display_name: string | null
      bio: string | null
      avatar_key: string | null
      language: string | null
      ng_words: string | null
      created_at: string
    }

    const updatedUser = await c.env.DB.prepare(`
      SELECT id, email, username, display_name, bio, avatar_key, language, ng_words, created_at 
      FROM users 
      WHERE id = ?
    `).bind(userId).first<UpdatedUserRow>()
    
    return c.json({ 
      user: {
        ...updatedUser,
        ng_words: JSON.parse(updatedUser?.ng_words ?? '[]') as string[]
      }
    })
  } catch (error: any) {
    console.error('Update profile error:', error)
    return c.json({ error: 'Failed to update profile', details: error?.message || 'Unknown error' }, 500)
  }
})

// PATCH /api/users/me/email - update email (protected)
app.patch('/api/users/me/email', requireAuth, async (c) => {
  try {
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    if (!sessionData) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    const { current_password, new_email } = await c.req.json()
    
    // Validation
    if (!current_password || !new_email) {
      return c.json({ error: 'Current password and new email are required' }, 400)
    }
    
    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(new_email)) {
      return c.json({ error: 'Invalid email format' }, 400)
    }
    
    const userId = sessionData.user.id
    
    // Get user with password hash to verify current password
    const userWithPassword = await c.env.DB.prepare(`
      SELECT password_hash FROM users WHERE id = ?
    `).bind(userId).first() as any
    
    if (!userWithPassword) {
      return c.json({ error: 'User not found' }, 404)
    }
    
    // Verify current password using the same method as auth
    const isValid = await verifyPassword(current_password, userWithPassword.password_hash)
    if (!isValid) {
      return c.json({ error: 'Current password is incorrect' }, 401)
    }
    
    // Check if new email is already taken
    const existingEmail = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?')
      .bind(new_email, userId).first()
    if (existingEmail) {
      return c.json({ error: 'Email is already taken' }, 409)
    }
    
    // Update email
    const result = await c.env.DB.prepare('UPDATE users SET email = ? WHERE id = ?')
      .bind(new_email, userId).run()
    
    if (!result.success) {
      return c.json({ error: 'Failed to update email' }, 500)
    }
    
    return c.json({ ok: true })
  } catch (error: any) {
    console.error('Update email error:', error)
    return c.json({ error: 'Failed to update email', details: error?.message || 'Unknown error' }, 500)
  }
})

// PATCH /api/users/me/password - update password (protected)
app.patch('/api/users/me/password', requireAuth, async (c) => {
  try {
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    if (!sessionData) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    const { current_password, new_password } = await c.req.json()
    
    // Validation
    if (!current_password || !new_password) {
      return c.json({ error: 'Current password and new password are required' }, 400)
    }
    
    if (new_password.length < 8 || new_password.length > 128) {
      return c.json({ error: 'Password must be 8-128 characters' }, 400)
    }
    
    const userId = sessionData.user.id
    
    // Get user with password hash to verify current password
    const userWithPassword = await c.env.DB.prepare(`
      SELECT password_hash FROM users WHERE id = ?
    `).bind(userId).first() as any
    
    if (!userWithPassword) {
      return c.json({ error: 'User not found' }, 404)
    }
    
    // Verify current password using the same method as auth
    const isValid = await verifyPassword(current_password, userWithPassword.password_hash)
    if (!isValid) {
      return c.json({ error: 'Current password is incorrect' }, 401)
    }
    
    // Hash new password using the same method as registration
    const newPasswordHash = await hashPassword(new_password)
    
    // Update password
    const result = await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .bind(newPasswordHash, userId).run()
    
    if (!result.success) {
      return c.json({ error: 'Failed to update password' }, 500)
    }
    
    return c.json({ ok: true })
  } catch (error: any) {
    console.error('Update password error:', error)
    return c.json({ error: 'Failed to update password', details: error?.message || 'Unknown error' }, 500)
  }
})

// DELETE /api/users/me - delete current user account (protected)
app.delete('/api/users/me', requireAuth, async (c) => {
  try {
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    if (!sessionData) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    const userId = sessionData.user.id
    
    // Delete user (posts remain with user_id intact)
    const result = await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run()
    
    if (!result.success) {
      return c.json({ error: 'Failed to delete account' }, 500)
    }
    
    // Delete the session
    if (token) {
      await deleteSession(c.env, token)
    }
    
    return c.json({ success: true })
  } catch (error: any) {
    console.error('Delete account error:', error)
    return c.json({ error: 'Failed to delete account', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/users/me/avatar - upload avatar (protected)
app.post('/api/users/me/avatar', requireAuth, async (c) => {
  try {
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    if (!sessionData) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    
    const contentType = c.req.header('content-type')
    const contentLength = c.req.header('content-length')
    
    if (!contentType || !contentLength) {
      return c.json({ error: 'Content-Type and Content-Length headers required' }, 400)
    }
    
    // Validate content type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
    if (!contentType || !allowedTypes.includes(contentType as string)) {
      return c.json({ error: 'Only JPEG, PNG, GIF, and WebP images are allowed' }, 400)
    }
    
    // Check file size limit (1MB = 1024 * 1024 bytes)
    const maxSize = 1024 * 1024
    if (Number(contentLength) > maxSize) {
      return c.json({ error: 'Avatar must be ≤1MB' }, 413)
    }
    
    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500)
    }
    
    const userId = sessionData.user.id
    
    // Get the file data from request body
    const fileData = await c.req.arrayBuffer()
    
    // Double-check file size after reading
    if (fileData.byteLength > maxSize) {
      return c.json({ error: 'Avatar must be ≤1MB' }, 413)
    }
    
    // Validate magic bytes to prevent MIME spoofing
    const detected = detectMimeType(fileData)
    if (!isAllowedImageMime(detected)) {
      return c.json({ error: 'File content does not match allowed image types' }, 400)
    }
    
    // Calculate file hash
    const hashBuffer = await crypto.subtle.digest('SHA-256', fileData)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
    
    // Check if file with same hash already exists
    const existingKey = `avatar/${hashHex}`
    const existingObject = await c.env.BUCKET.head(existingKey)
    
    let avatarKey: string
    if (existingObject) {
      // Use existing file
      avatarKey = existingKey
      console.log('Reusing existing avatar file:', avatarKey)
    } else {
      // Upload new file with hash as key
      avatarKey = existingKey
      await c.env.BUCKET.put(avatarKey, fileData, {
        httpMetadata: {
          contentType: contentType
        }
      })
      console.log('Uploaded new avatar file:', avatarKey)
    }
    
    // Update user's avatar_key in database
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    const result = await c.env.DB.prepare('UPDATE users SET avatar_key = ? WHERE id = ?').bind(avatarKey, userId).run()
    
    if (!result.success) {
      return c.json({ error: 'Failed to update avatar' }, 500)
    }
    
    return c.json({ success: true, avatar_key: avatarKey })
  } catch (error: any) {
    console.error('Avatar upload error:', error)
    return c.json({ error: 'Avatar upload failed', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/users/:username/follow - follow a user (protected)
app.post('/api/users/:username/follow', requireAuth, async (c) => {
  try {
    const username = c.req.param('username')
    
    if (!username) {
      return c.json({ error: 'Username required' }, 400)
    }
    
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    if (!sessionData) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    const followerId = sessionData.user.id
    
    // Get target user ID
    const targetUser = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?')
      .bind(username).first()
    
    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404)
    }
    
    const followeeId = targetUser.id
    
    // Can't follow yourself
    if (followerId === followeeId) {
      return c.json({ error: 'Cannot follow yourself' }, 400)
    }
    
    // Insert follow relationship (idempotent with INSERT OR IGNORE)
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)'
    ).bind(followerId, followeeId).run()
    
    // Get updated follow counts
    const [followersResult, followingResult] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE followee_id = ?').bind(followeeId).first(),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?').bind(followeeId).first()
    ])
    
    return c.json({
      following: true,
      followers_count: (followersResult?.count as number) || 0,
      following_count: (followingResult?.count as number) || 0
    })
  } catch (error: any) {
    console.error('Follow error:', error)
    return c.json({ error: 'Failed to follow user', details: error?.message || 'Unknown error' }, 500)
  }
})

// DELETE /api/users/:username/follow - unfollow a user (protected)
app.delete('/api/users/:username/follow', requireAuth, async (c) => {
  try {
    const username = c.req.param('username')
    
    if (!username) {
      return c.json({ error: 'Username required' }, 400)
    }
    
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    if (!sessionData) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    const followerId = sessionData.user.id
    
    // Get target user ID
    const targetUser = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?')
      .bind(username).first()
    
    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404)
    }
    
    const followeeId = targetUser.id
    
    // Delete follow relationship (idempotent - safe to call even if not following)
    await c.env.DB.prepare(
      'DELETE FROM follows WHERE follower_id = ? AND followee_id = ?'
    ).bind(followerId, followeeId).run()
    
    // Get updated follow counts
    const [followersResult, followingResult] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE followee_id = ?').bind(followeeId).first(),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?').bind(followeeId).first()
    ])
    
    return c.json({
      following: false,
      followers_count: (followersResult?.count as number) || 0,
      following_count: (followingResult?.count as number) || 0
    })
  } catch (error: any) {
    console.error('Unfollow error:', error)
    return c.json({ error: 'Failed to unfollow user', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/posts - timeline
app.get('/api/posts', async (c) => {
  try {
    const cursor = c.req.query('cursor')
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50)
    const hashtag = c.req.query('hashtag')
    const following = c.req.query('following') === 'true'
    const username = c.req.query('username')
    
    // Check if database is available
    if (!c.env.DB) {
      console.error('Database not available')
      return c.json({ error: 'Database not available' }, 500)
    }
    
    // Get current user ID for fresh status (optional for all tabs, required for Following tab)
    let currentUserId: string | null = null
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    if (sessionData) {
      currentUserId = sessionData.user.id
    }
    
    // For Following tab, require authentication
    if (following && !currentUserId) {
      return c.json({ error: 'Authentication required for Following tab' }, 401)
    }
    
    let query: string
    let params: any[] = []
    
    if (hashtag) {
      // Filter by hashtag using json_each
      if (cursor) {
        query = 'SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, (SELECT COUNT(*) FROM posts WHERE root_id = p.id AND status = \'published\') as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, \'published\') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = \'published\' AND p.hidden = 0 AND p.parent_id IS NULL AND EXISTS (SELECT 1 FROM json_each(p.hashtags) WHERE value = ?) AND p.created_at < ? ORDER BY p.created_at DESC LIMIT ?'
        params = [hashtag, cursor, limit]
      } else {
        query = 'SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, (SELECT COUNT(*) FROM posts WHERE root_id = p.id AND status = \'published\') as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, \'published\') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = \'published\' AND p.hidden = 0 AND p.parent_id IS NULL AND EXISTS (SELECT 1 FROM json_each(p.hashtags) WHERE value = ?) ORDER BY p.created_at DESC LIMIT ?'
        params = [hashtag, limit]
      }
    } else if (following && currentUserId) {
      // Following tab - show posts from followed users and current user's own posts
      if (cursor) {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, 
          (SELECT COUNT(*) FROM posts WHERE root_id = p.id AND status = 'published') as reply_count, 
          COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at 
          FROM posts p 
          LEFT JOIN users u ON p.user_id = u.id 
          WHERE (
            p.user_id IN (
              SELECT followee_id FROM follows WHERE follower_id = ?
            )
            OR p.user_id = ?
          )
          AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL AND p.created_at < ? 
          ORDER BY p.created_at DESC LIMIT ?`
        params = [currentUserId, currentUserId, cursor, limit]
      } else {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, 
          (SELECT COUNT(*) FROM posts WHERE root_id = p.id AND status = 'published') as reply_count, 
          COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at 
          FROM posts p 
          LEFT JOIN users u ON p.user_id = u.id 
          WHERE (
            p.user_id IN (
              SELECT followee_id FROM follows WHERE follower_id = ?
            )
            OR p.user_id = ?
          )
          AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL 
          ORDER BY p.created_at DESC LIMIT ?`
        params = [currentUserId, currentUserId, limit]
      }
    } else if (username) {
      // Username filter - show posts from specific user
      if (cursor) {
        query = 'SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = \'published\') as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, \'published\') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.username = ? AND p.hidden = 0 AND p.created_at < ? ORDER BY p.created_at DESC LIMIT ?'
        params = [username, cursor, limit]
      } else {
        query = 'SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = \'published\') as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, \'published\') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.username = ? AND p.hidden = 0 ORDER BY p.created_at DESC LIMIT ?'
        params = [username, limit]
      }
    } else {
      // Regular timeline query (For You tab)
      if (cursor) {
        query = 'SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, (SELECT COUNT(*) FROM posts WHERE root_id = p.id AND status = \'published\') as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, \'published\') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = \'published\' AND p.hidden = 0 AND p.parent_id IS NULL AND p.created_at < ? ORDER BY p.created_at DESC LIMIT ?'
        params = [cursor, limit]
      } else {
        query = 'SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, (SELECT COUNT(*) FROM posts WHERE root_id = p.id AND status = \'published\') as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, \'published\') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = \'published\' AND p.hidden = 0 AND p.parent_id IS NULL ORDER BY p.created_at DESC LIMIT ?'
        params = [limit]
      }
    }
    
    const result = await c.env.DB.prepare(query).bind(...params).all()
    
    if (!result.success) {
      console.error('Database query failed:', result)
      return c.json({ error: 'Failed to fetch posts' }, 500)
    }
    
    const posts = result.results || []
    
    // Add fresh and bookmark status for current user if logged in
    if (currentUserId && posts.length > 0) {
      const postIds = posts.map((p: any) => p.id)
      const placeholders = postIds.map(() => '?').join(',')
      
      const freshResult = await c.env.DB.prepare(
        `SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${placeholders})`
      ).bind(currentUserId, ...postIds).all()
      
      if (freshResult.success) {
        const freshedPostIds = new Set((freshResult.results || []).map((f: any) => f.post_id))
        
        // Add is_freshed field to each post
        posts.forEach((post: any) => {
          post.is_freshed = freshedPostIds.has(post.id)
        })
      }
      
      // Add is_bookmarked field to each post
      const bookmarkResult = await c.env.DB.prepare(
        `SELECT post_id FROM bookmarks WHERE user_id = ? AND post_id IN (${placeholders})`
      ).bind(currentUserId, ...postIds).all()
      
      if (bookmarkResult.success) {
        const bookmarkedPostIds = new Set((bookmarkResult.results || []).map((b: any) => b.post_id))
        posts.forEach((post: any) => {
          post.is_bookmarked = bookmarkedPostIds.has(post.id)
        })
      }
    }

    // Batch fetch poll data for posts with polls
    await enrichPostsWithPolls(posts as any[], c.env.DB, currentUserId)

    // Trigger sentiment analysis for unprocessed posts in background
    for (const p of posts as any[]) {
      if (p.sentiment_score == null && p.text) {
        c.executionCtx.waitUntil(analyzeSentiment(c, p.id, p.text))
      }
    }

    // Return total count when filtering by hashtag
    if (hashtag) {
      const countResult = await c.env.DB.prepare(`
        SELECT COUNT(*) as count FROM posts WHERE status = 'published' AND hidden = 0 AND parent_id IS NULL AND id IN (SELECT posts.id FROM posts, json_each(posts.hashtags) WHERE value = ?)
      `).bind(hashtag).first<{ count: number }>()
      return c.json({ posts, count: countResult?.count || 0 })
    }
    
    return c.json({ posts })
  } catch (error: any) {
    console.error('Posts fetch error:', error)
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/posts/trending - get trending posts based on engagement and time decay
app.get('/api/posts/trending', async (c) => {
  try {
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50)
    const cursor = c.req.query('cursor')
    const [cursorScore, cursorCreatedAt] = cursor ? cursor.split(',') : [null, null]
    let numericScore = cursorScore !== null ? parseFloat(cursorScore) : null
    if (isNaN(numericScore!)) numericScore = null

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Get current user for fresh status
    let currentUserId: string | null = null
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    if (sessionData) {
      currentUserId = sessionData.user.id
    }

    // Trending algorithm: (fresh_count * 2 + reply_count * 3 + impressions * 0.1 + 1) / (hours_since_creation + 2)^1.5
    // SQLite doesn't have POW, so we use (hours + 2) * (hours + 2) as a simpler decay
    let query = `
      SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, 
      (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, 
      COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
      ((p.fresh_count * 2.0 + (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') * 3.0 + p.impressions * 0.1 + 1.0) / 
      ((unixepoch('now') - unixepoch(p.created_at)) / 3600.0 + 2.0) * ((unixepoch('now') - unixepoch(p.created_at)) / 3600.0 + 2.0)) as score
      FROM posts p 
      LEFT JOIN users u ON p.user_id = u.id 
      WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL
      ${numericScore !== null ? 'AND (score < ? OR (score = ? AND p.created_at < ?))' : ''}
      ORDER BY score DESC, p.created_at DESC
      LIMIT ?
    `
    const params: any[] = numericScore !== null ? [numericScore, numericScore, cursorCreatedAt, limit] : [limit]

    const result = await c.env.DB.prepare(query).bind(...params).all()
    const posts = result.results || []

    // Add fresh and bookmark status for current user if logged in
    if (currentUserId && posts.length > 0) {
      const postIds = posts.map((p: any) => p.id)
      const freshResult = await c.env.DB.prepare(
        `SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})`
      ).bind(currentUserId, ...postIds).all()
      
      const freshedPostIds = new Set((freshResult.results || []).map((f: any) => f.post_id))
      posts.forEach((post: any) => {
        post.is_freshed = freshedPostIds.has(post.id)
      })
      
      const bookmarkResult = await c.env.DB.prepare(
        `SELECT post_id FROM bookmarks WHERE user_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})`
      ).bind(currentUserId, ...postIds).all()
      const bookmarkedPostIds = new Set((bookmarkResult.results || []).map((b: any) => b.post_id))
      posts.forEach((post: any) => {
        post.is_bookmarked = bookmarkedPostIds.has(post.id)
      })
    }

    await enrichPostsWithPolls(posts as any[], c.env.DB, currentUserId)

    return c.json({ posts })
  } catch (error: any) {
    console.error('Trending posts error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// GET /api/posts/recommended - get recommended posts for the user
app.get('/api/posts/recommended', async (c) => {
  try {
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50)
    const cursor = c.req.query('cursor')
    // Cursor is expected to be "score,created_at"
    const [cursorScore, cursorCreatedAt] = cursor ? cursor.split(',') : [null, null]
    let numericScore = cursorScore !== null ? parseFloat(cursorScore) : null
    if (isNaN(numericScore!)) numericScore = null

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    const currentUserId = sessionData?.user?.id

    let query: string
    let params: any[] = []

    const scoreFormula = `((p.fresh_count * 2.0 + p.impressions * 0.1 + 1.0) / ((unixepoch('now') - unixepoch(p.created_at)) / 3600.0 + 2.0))`

    if (currentUserId) {
      query = `
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, 
        (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, 
        COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
        ${scoreFormula} as score
        FROM posts p 
        LEFT JOIN users u ON p.user_id = u.id 
        WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL
        AND p.user_id != ?
        ${cursorScore !== null ? 'AND (score < ? OR (score = ? AND p.created_at < ?))' : ''}
        ORDER BY score DESC, p.created_at DESC
        LIMIT ?
      `
      params = cursorScore !== null ? [currentUserId, numericScore, numericScore, cursorCreatedAt, limit] : [currentUserId, limit]
    } else {
      query = `
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, 
        (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, 
        COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
        ${scoreFormula} as score
        FROM posts p 
        LEFT JOIN users u ON p.user_id = u.id 
        WHERE p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL
        ${cursorScore !== null ? 'AND (score < ? OR (score = ? AND p.created_at < ?))' : ''}
        ORDER BY score DESC, p.created_at DESC
        LIMIT ?
      `
      params = cursorScore !== null ? [numericScore, numericScore, cursorCreatedAt, limit] : [limit]
    }

    const result = await c.env.DB.prepare(query).bind(...params).all()
    const posts = result.results || []

    // Add fresh and bookmark status if logged in
    if (currentUserId && posts.length > 0) {
      const postIds = posts.map((p: any) => p.id)
      const freshResult = await c.env.DB.prepare(
        `SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})`
      ).bind(currentUserId, ...postIds).all()
      
      const freshedPostIds = new Set((freshResult.results || []).map((f: any) => f.post_id))
      posts.forEach((post: any) => {
        post.is_freshed = freshedPostIds.has(post.id)
      })
      
      const bookmarkResult = await c.env.DB.prepare(
        `SELECT post_id FROM bookmarks WHERE user_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})`
      ).bind(currentUserId, ...postIds).all()
      const bookmarkedPostIds = new Set((bookmarkResult.results || []).map((b: any) => b.post_id))
      posts.forEach((post: any) => {
        post.is_bookmarked = bookmarkedPostIds.has(post.id)
      })
    }

    await enrichPostsWithPolls(posts as any[], c.env.DB, currentUserId)

    return c.json({ posts })
  } catch (error: any) {
    console.error('Recommended posts error:', error)
    return c.json({ error: 'Internal server error', details: error.message }, 500)
  }
})

// GET /api/ads/active - get active ads (public endpoint)
app.get('/api/ads/active', async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const result = await c.env.DB.prepare('SELECT id, body_text, payload_key, payload_type, thumbnail_key, click_url, impressions, clicks, active, created_at, ad_type FROM ads WHERE active = 1').all()
    
    if (!result.success) {
      console.error('Database query failed:', result)
      return c.json({ error: 'Failed to fetch ads' }, 500)
    }

    // Shuffle results in JS
    const shuffled = [...(result.results || [])].sort(() => Math.random() - 0.5)
    
    return c.json({ ads: shuffled })
  } catch (error: any) {
    console.error('Get active ads error:', error)
    return c.json({ error: 'Failed to get active ads', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/ads/:id/impression - track ad impression (public endpoint)
app.post('/api/ads/:id/impression', async (c) => {
  try {
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
    const isTestEnvironment = c.req.url.includes('localhost:8788')
    
    // Handle KV rate limit gracefully - if KV fails, continue with impression tracking
    let rl: { allowed: boolean; resetIn: number } | null = null
    try {
      rl = await checkRateLimit(c.env.RATE_LIMIT, {
        key: `ad-imp:${ip}`,
        limit: 60,
        windowSeconds: 60
      })
    } catch (kvError: any) {
      // Log KV error but don't fail the request
      console.warn('KV rate limit check failed, proceeding anyway:', kvError.message)
      // Check if it's specifically a KV put limit exceeded error
      if (kvError.message && kvError.message.includes('KV put() limit exceeded')) {
        console.warn('KV put limit exceeded, skipping rate limit check for ad impression')
      }
    }
    
    // Only apply rate limit if KV check succeeded
    if (rl && !rl.allowed) {
      return rateLimitResponse(c, rl.resetIn, 60)
    }

    const adId = c.req.param('id')
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const result = await c.env.DB.prepare('UPDATE ads SET impressions = impressions + 1 WHERE id = ?')
      .bind(adId).run()

    if (!result.success) {
      console.error('Database update failed:', result)
      return c.json({ error: 'Failed to record impression' }, 500)
    }

    return c.json({ ok: true })
  } catch (error: any) {
    console.error('Record impression error:', error)
    // Always return success to ensure content display continues
    // even if impression tracking fails
    return c.json({ ok: true, warning: 'Impression tracking failed but content can still be displayed' })
  }
})

// POST /api/posts/:id/impression - track post impression (public endpoint)
app.post('/api/posts/:id/impression', async (c) => {
  try {
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
    const isTestEnvironment = c.req.url.includes('localhost:8788')
    
    // Handle KV rate limit gracefully - if KV fails, continue with impression tracking
    let rl: { allowed: boolean; resetIn: number } | null = null
    try {
      rl = await checkRateLimit(c.env.RATE_LIMIT, {
        key: `post-imp:${ip}`,
        limit: 60,
        windowSeconds: 60
      })
    } catch (kvError: any) {
      // Log KV error but don't fail the request
      console.warn('KV rate limit check failed, proceeding anyway:', kvError.message)
      // Check if it's specifically a KV put limit exceeded error
      if (kvError.message && kvError.message.includes('KV put() limit exceeded')) {
        console.warn('KV put limit exceeded, skipping rate limit check for post impression')
      }
    }
    
    // Only apply rate limit if KV check succeeded
    if (rl && !rl.allowed) {
      return rateLimitResponse(c, rl.resetIn, 60)
    }

    const postId = c.req.param('id')
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const result = await c.env.DB.prepare('UPDATE posts SET impressions = impressions + 1 WHERE id = ?')
      .bind(postId).run()

    if (!result.success) {
      console.error('Database update failed:', result)
      return c.json({ error: 'Failed to record impression' }, 500)
    }

    return c.json({ ok: true })
  } catch (error: any) {
    console.error('Record post impression error:', error)
    // Always return success to ensure content display continues
    // even if impression tracking fails
    return c.json({ ok: true, warning: 'Impression tracking failed but content can still be displayed' })
  }
})

// POST /api/posts/impressions/batch - track multiple post impressions (public endpoint)
app.post('/api/posts/impressions/batch', async (c) => {
  try {
    const body = await c.req.json() as { post_ids: string[] }
    
    if (!body.post_ids || !Array.isArray(body.post_ids) || body.post_ids.length === 0) {
      return c.json({ error: 'Invalid request: post_ids array required' }, 400)
    }

    if (body.post_ids.length > 100) {
      return c.json({ error: 'Too many post IDs (max 100)' }, 400)
    }

    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
    
    // Handle KV rate limit gracefully - if KV fails, continue with impression tracking
    let rl: { allowed: boolean; resetIn: number } | null = null
    try {
      rl = await checkRateLimit(c.env.RATE_LIMIT, {
        key: `post-imp-batch:${ip}`,
        limit: 10,
        windowSeconds: 60
      })
    } catch (kvError: any) {
      // Log KV error but don't fail the request
      console.warn('KV rate limit check failed, proceeding anyway:', kvError.message)
      // Check if it's specifically a KV put limit exceeded error
      if (kvError.message && kvError.message.includes('KV put() limit exceeded')) {
        console.warn('KV put limit exceeded, skipping rate limit check for batch impressions')
      }
    }
    
    // Only apply rate limit if KV check succeeded
    if (rl && !rl.allowed) {
      return rateLimitResponse(c, rl.resetIn, 10)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Create placeholders for batch update
    const placeholders = body.post_ids.map(() => '?').join(',')
    const result = await c.env.DB.prepare(
      `UPDATE posts SET impressions = impressions + 1 WHERE id IN (${placeholders})`
    ).bind(...body.post_ids).run()

    if (!result.success) {
      console.error('Batch database update failed:', result)
      return c.json({ error: 'Failed to record impressions' }, 500)
    }

    return c.json({ ok: true, updated: result.meta?.changes || 0 })
  } catch (error: any) {
    console.error('Batch post impressions error:', error)
    // Always return success to ensure content display continues
    // even if impression tracking fails
    return c.json({ ok: true, updated: 0, warning: 'Batch impression tracking failed but content can still be displayed' })
  }
})

// POST /api/ads/:id/click - track ad click (public endpoint)
app.post('/api/ads/:id/click', async (c) => {
  try {
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
    const isTestEnvironment = c.req.url.includes('localhost:8788')
    
    // Handle KV rate limit gracefully - if KV fails, continue with click tracking
    let rl: { allowed: boolean; resetIn: number } | null = null
    try {
      rl = await checkRateLimit(c.env.RATE_LIMIT, {
        key: `ad-click:${ip}`,
        limit: 20,
        windowSeconds: 60
      })
    } catch (kvError: any) {
      // Log KV error but don't fail the request
      console.warn('KV rate limit check failed, proceeding anyway:', kvError.message)
      // Check if it's specifically a KV put limit exceeded error
      if (kvError.message && kvError.message.includes('KV put() limit exceeded')) {
        console.warn('KV put limit exceeded, skipping rate limit check for ad click')
      }
    }
    
    // Only apply rate limit if KV check succeeded
    if (rl && !rl.allowed) {
      return rateLimitResponse(c, rl.resetIn, 20)
    }

    const adId = c.req.param('id')
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const result = await c.env.DB.prepare('UPDATE ads SET clicks = clicks + 1 WHERE id = ?')
      .bind(adId).run()

    if (!result.success) {
      console.error('Database update failed:', result)
      return c.json({ error: 'Failed to record click' }, 500)
    }

    return c.json({ ok: true })
  } catch (error: any) {
    console.error('Record click error:', error)
    // Always return success to ensure content display continues
    // even if click tracking fails
    return c.json({ ok: true, warning: 'Click tracking failed but content can still be displayed' })
  }
})

// POST /api/ads/:id/interaction - track ad interaction (public endpoint)
app.post('/api/ads/:id/interaction', async (c) => {
  try {
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
    const isTestEnvironment = c.req.url.includes('localhost:8788')
    
    // Handle KV rate limit gracefully - if KV fails, continue with interaction tracking
    let rl: { allowed: boolean; resetIn: number } | null = null
    try {
      rl = await checkRateLimit(c.env.RATE_LIMIT, {
        key: `ad-int:${ip}`,
        limit: 30,
        windowSeconds: 60
      })
    } catch (kvError: any) {
      // Log KV error but don't fail the request
      console.warn('KV rate limit check failed, proceeding anyway:', kvError.message)
      // Check if it's specifically a KV put limit exceeded error
      if (kvError.message && kvError.message.includes('KV put() limit exceeded')) {
        console.warn('KV put limit exceeded, skipping rate limit check for ad interaction')
      }
    }
    
    // Only apply rate limit if KV check succeeded
    if (rl && !rl.allowed) {
      return rateLimitResponse(c, rl.resetIn, 30)
    }

    const adId = c.req.param('id')
    const { duration_ms } = await c.req.json()
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const result = await c.env.DB.prepare(
      'INSERT INTO ad_interactions (id, ad_id, duration_ms) VALUES (?, ?, ?)'
    ).bind(nanoid(), adId, duration_ms).run()

    if (!result.success) {
      console.error('Database insert failed:', result)
      return c.json({ error: 'Failed to record interaction' }, 500)
    }

    return c.json({ ok: true })
  } catch (error: any) {
    console.error('Record interaction error:', error)
    // Always return success to ensure content display continues
    // even if interaction tracking fails
    return c.json({ ok: true, warning: 'Interaction tracking failed but content can still be displayed' })
  }
})

// POST /api/ads/:id/play - track game play start (public endpoint)
app.post('/api/ads/:id/play', async (c) => {
  try {
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
    const isTestEnvironment = c.req.url.includes('localhost:8788')
    
    // Handle KV rate limit gracefully - if KV fails, continue with play tracking
    let rl: { allowed: boolean; resetIn: number } | null = null
    try {
      rl = await checkRateLimit(c.env.RATE_LIMIT, {
        key: `ad-play:${ip}`,
        limit: 30,
        windowSeconds: 60
      })
    } catch (kvError: any) {
      // Log KV error but don't fail the request
      console.warn('KV rate limit check failed, proceeding anyway:', kvError.message)
      // Check if it's specifically a KV put limit exceeded error
      if (kvError.message && kvError.message.includes('KV put() limit exceeded')) {
        console.warn('KV put limit exceeded, skipping rate limit check for ad play')
      }
    }
    
    // Only apply rate limit if KV check succeeded
    if (rl && !rl.allowed) {
      return rateLimitResponse(c, rl.resetIn, 30)
    }

    const adId = c.req.param('id')
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Record a 0-duration interaction to track play count
    const result = await c.env.DB.prepare(
      'INSERT INTO ad_interactions (id, ad_id, duration_ms) VALUES (?, ?, 0)'
    ).bind(nanoid(), adId).run()

    if (!result.success) {
      console.error('Database insert failed:', result)
      return c.json({ error: 'Failed to record play' }, 500)
    }

    return c.json({ ok: true })
  } catch (error: any) {
    console.error('Record play error:', error)
    // Always return success to ensure content display continues
    // even if play tracking fails
    return c.json({ ok: true, warning: 'Play tracking failed but content can still be displayed' })
  }
})

// GET /api/admin/ads/config - get ad configuration (admin endpoint)
app.get('/api/admin/ads/config', async (c) => {
  try {
    const user = c.get('user')
    if (!user || !isAdmin(c.env as any, user.username)) {
      return c.json({ error: 'Admin access required' }, 403)
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const result = await c.env.DB.prepare('SELECT value FROM ad_config WHERE key = \'every_n\'')
      .first()

    if (!result) {
      return c.json({ error: 'Ad config not found' }, 404)
    }

    return c.json({ every_n: Number(result.value) })
  } catch (error: any) {
    console.error('Get ad config error:', error)
    return c.json({ error: 'Failed to get ad config', details: error?.message || 'Unknown error' }, 500)
  }
})

// PATCH /api/admin/ads/config - update ad configuration (admin endpoint)
app.patch('/api/admin/ads/config', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    if (!user || !isAdmin(c.env as any, user.username)) {
      return c.json({ error: 'Admin access required' }, 403)
    }

    const { every_n } = await c.req.json()
    
    // Validate: must be an integer ≥ 1
    if (!Number.isInteger(every_n) || every_n < 1) {
      return c.json({ error: 'every_n must be an integer ≥ 1' }, 400)
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const result = await c.env.DB.prepare('UPDATE ad_config SET value = ? WHERE key = \'every_n\'')
      .bind(String(every_n)).run()

    if (!result.success) {
      console.error('Database update failed:', result)
      return c.json({ error: 'Failed to update ad config' }, 500)
    }

    return c.json({ every_n })
  } catch (error: any) {
    console.error('Update ad config error:', error)
    return c.json({ error: 'Failed to update ad config', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/admin/ads - get all ads with analytics (admin endpoint)
app.get('/api/admin/ads', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    if (!user || !isAdmin(c.env as any, user.username)) {
      return c.json({ error: 'Admin access required' }, 403)
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const result = await c.env.DB.prepare(`
      SELECT
        ads.id,
        ads.title,
        ads.body_text,
        ads.click_url,
        ads.payload_key,
        ads.payload_type,
        ads.thumbnail_key,
        ads.impressions,
        ads.clicks,
        ads.active,
        ads.created_at,
        ROUND(CAST(clicks AS FLOAT) / NULLIF(impressions, 0) * 100, 2) AS ctr,
        (SELECT COUNT(*) FROM ad_interactions WHERE ad_id = ads.id) AS interaction_count
      FROM ads
      ORDER BY created_at DESC
    `).all()

    if (!result.success) {
      console.error('Database query failed:', result)
      return c.json({ error: 'Failed to fetch ads' }, 500)
    }

    return c.json({ ads: result.results || [] })
  } catch (error: any) {
    console.error('Get admin ads error:', error)
    return c.json({ error: 'Failed to fetch ads', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/admin/ads - create new ad (admin endpoint)
app.post('/api/admin/ads', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    if (!user || !isAdmin(c.env as any, user.username)) {
      return c.json({ error: 'Admin access required' }, 403)
    }

    // Generate ad ID early so it can be used for both payload and thumbnail
    const adId = nanoid()

    const contentType = c.req.header('content-type')
    let title: string, body_text: string, click_url: string, ad_type: string, payloadFile: File | undefined, thumbnailFile: File | undefined

    if (contentType?.includes('multipart/form-data')) {
      const formData = await c.req.formData()
      title = formData.get('title') as string
      body_text = formData.get('body_text') as string
      click_url = formData.get('click_url') as string
      ad_type = formData.get('ad_type') as string
      payloadFile = formData.get('payload') as File | null || undefined
      thumbnailFile = formData.get('thumbnail') as File | null || undefined
    } else {
      const body = await c.req.json()
      title = body.title
      body_text = body.body_text
      click_url = body.click_url
      ad_type = body.ad_type
    }

    // Validate required fields
    if (!title || !body_text) {
      return c.json({ error: 'title and body_text are required' }, 400)
    }

    // Validate ad_type
    if (!ad_type || !['self_hosted', 'admax'].includes(ad_type)) {
      return c.json({ error: 'ad_type must be either "self_hosted" or "admax"' }, 400)
    }

    // For admax ads, payload files are not allowed
    if (ad_type === 'admax' && payloadFile && payloadFile.size > 0) {
      return c.json({ error: 'Admax ads do not support payload files' }, 400)
    }

    let payload_key: string | null = null
    let payload_type: 'zip' | 'swf' | 'gif' | 'image' | null = null

    // Handle payload file if present (only for self_hosted ads)
    if (payloadFile && payloadFile.size > 0) {
      // Validate size ≤ 100MB (Cloudflare Free/Pro plan limit)
      const maxSize = 100 * 1024 * 1024
      if (payloadFile.size > maxSize) {
        return c.json({ 
          error: 'Payload file must be ≤100MB on Free/Pro plans. For larger files, upgrade to Business plan (200MB) or use chunked upload.', 
          limit: maxSize,
          actualSize: payloadFile.size 
        }, 400)
      }

      if (!c.env.BUCKET) {
        return c.json({ error: 'Storage not available' }, 500)
      }

      // Detect payload_type from file extension
      const fileName = payloadFile.name.toLowerCase()
      if (fileName.endsWith('.zip')) {
        payload_type = 'zip'
      } else if (fileName.endsWith('.swf')) {
        payload_type = 'swf'
      } else if (fileName.endsWith('.gif')) {
        payload_type = 'gif'
      } else if (fileName.endsWith('.png') || fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) {
        payload_type = 'image'
      } else {
        return c.json({ error: 'Unsupported file type. Use .zip, .swf, .gif, .png, or .jpg' }, 400)
      }

      // If zip, validate that index.html exists at root
      if (payload_type === 'zip') {
        const fileBuffer = await payloadFile.arrayBuffer()
        // For now, we'll assume the zip is valid - in a real implementation you'd extract and check
        console.log('ZIP file validation skipped - would check for index.html at root')
      }

      // Upload to R2
      const r2Key = `ad/payload/${adId}`
      
      if (payload_type === 'zip') {
        const fileBuffer = await payloadFile.arrayBuffer()
        await c.env.BUCKET.put(r2Key, fileBuffer)
      } else {
        const fileBuffer = await payloadFile.arrayBuffer()
        await c.env.BUCKET.put(r2Key, fileBuffer, {
          httpMetadata: {
            contentType: payloadFile.type
          }
        })
      }

      payload_key = r2Key
    }

    // Generate ad ID first (needed for thumbnail key)
    // Note: adId was already generated above for payload upload

    let thumbnail_key: string | null = null
    
    // Handle thumbnail file if present
    if (thumbnailFile && thumbnailFile.size > 0) {
      // Validate thumbnail size ≤ 1MB
      if (thumbnailFile.size > 1024 * 1024) {
        return c.json({ error: 'Thumbnail must be ≤1MB' }, 400)
      }

      // Validate thumbnail extension
      const allowedExts = ['jpg', 'jpeg', 'png', 'gif']
      const ext = thumbnailFile.name.toLowerCase().split('.').pop()
      if (!ext || !allowedExts.includes(ext)) {
        return c.json({ error: 'Thumbnail must be .jpg, .jpeg, .png, or .gif' }, 400)
      }

      // Upload thumbnail to R2
      const thumbnailR2Key = `ad/thumbnail/${adId}.${ext}`
      const thumbnailBuffer = await thumbnailFile.arrayBuffer()
      await c.env.BUCKET.put(thumbnailR2Key, thumbnailBuffer, {
        httpMetadata: {
          contentType: thumbnailFile.type
        }
      })

      thumbnail_key = thumbnailR2Key
    }

    // Insert into database
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO ads (id, title, body_text, click_url, payload_key, payload_type, thumbnail_key, impressions, clicks, active, created_at, ad_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, datetime('now'), ?)
    `).bind(adId, title, body_text, click_url || null, payload_key, payload_type, thumbnail_key, ad_type).run()

    if (!result.success) {
      console.error('Database insert failed:', result)
      return c.json({ error: 'Failed to create ad' }, 500)
    }

    // Return created ad
    const createdAd = await c.env.DB.prepare('SELECT * FROM ads WHERE id = ?')
      .bind(adId).first()

    return c.json({ ad: createdAd })
  } catch (error: any) {
    console.error('Create ad error:', error)
    return c.json({ error: 'Failed to create ad', details: error?.message || 'Unknown error' }, 500)
  }
})

// PATCH /api/admin/ads/:id - update ad (admin endpoint)
app.patch('/api/admin/ads/:id', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    if (!user || !isAdmin(c.env as any, user.username)) {
      return c.json({ error: 'Admin access required' }, 403)
    }

    const adId = c.req.param('id')
    const body = await c.req.json()

    if (body.click_url !== undefined && body.click_url !== null) {
      if (typeof body.click_url !== 'string') {
        return c.json({ error: 'Invalid click_url format' }, 400)
      }
      try {
        const parsed = new URL(body.click_url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return c.json({ error: 'Invalid click_url format' }, 400)
        }
      } catch {
        return c.json({ error: 'Invalid click_url format' }, 400)
      }
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Build UPDATE query dynamically
    const updates: string[] = []
    const values: (string | number | null)[] = []

    if (body.title !== undefined) {
      updates.push('title = ?')
      values.push(body.title)
    }
    if (body.body_text !== undefined) {
      updates.push('body_text = ?')
      values.push(body.body_text)
    }
    if (body.click_url !== undefined) {
      updates.push('click_url = ?')
      values.push(body.click_url)
    }
    if (body.active !== undefined) {
      updates.push('active = ?')
      values.push(body.active ? 1 : 0)
    }

    if (updates.length === 0) {
      return c.json({ error: 'No fields to update' }, 400)
    }

    values.push(adId)

    const result = await c.env.DB.prepare(`
      UPDATE ads SET ${updates.join(', ')} WHERE id = ?
    `).bind(...values).run()

    if (!result.success) {
      console.error('Database update failed:', result)
      return c.json({ error: 'Failed to update ad' }, 500)
    }

    // Return updated ad
    const updatedAd = await c.env.DB.prepare('SELECT * FROM ads WHERE id = ?')
      .bind(adId).first()

    return c.json({ ad: updatedAd })
  } catch (error: any) {
    console.error('Update ad error:', error)
    return c.json({ error: 'Failed to update ad', details: error?.message || 'Unknown error' }, 500)
  }
})

// DELETE /api/admin/ads/:id - delete ad (admin endpoint)
app.delete('/api/admin/ads/:id', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    if (!user || !isAdmin(c.env as any, user.username)) {
      return c.json({ error: 'Admin access required' }, 403)
    }

    const adId = c.req.param('id')

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Fetch the ad to get payload_key
    const ad = await c.env.DB.prepare('SELECT payload_key FROM ads WHERE id = ?')
      .bind(adId).first()

    if (!ad) {
      return c.json({ error: 'Ad not found' }, 404)
    }

    // Delete R2 object if payload_key exists
    if (ad.payload_key && c.env.BUCKET) {
      await c.env.BUCKET.delete(ad.payload_key as string)
    }

    // Delete the ad row (cascades to ad_interactions)
    const result = await c.env.DB.prepare('DELETE FROM ads WHERE id = ?')
      .bind(adId).run()

    if (!result.success) {
      console.error('Database delete failed:', result)
      return c.json({ error: 'Failed to delete ad' }, 500)
    }

    return c.json({ ok: true })
  } catch (error: any) {
    console.error('Delete ad error:', error)
    return c.json({ error: 'Failed to delete ad', details: error?.message || 'Unknown error' }, 500)
  }
})

// Step 1 — POST /api/posts/prepare (protected)
app.post('/api/posts/prepare', requireAuth, async (c) => {
  try {
    const { filename, contentType, payloadType } = await c.req.json()
    
    if (!filename) {
      return c.json({ error: 'Missing filename' }, 400)
    }
    
    const name = filename.toLowerCase()
    const ext = name.match(/\.(\w+)$/)?.[1]
    const postId = crypto.randomUUID()
    
    let storageKey: string
    let keyColumn: string
    let responseType: 'gif' | 'zip' | 'swf'
    
    // SWF files
    if (name.endsWith('.swf') || ext === 'swf') {
      storageKey = `swf/${postId}.swf`
      keyColumn = 'swf_key'
      responseType = 'swf'
    }
    // ZIP/JSDOS/DOS files
    else if (name.endsWith('.zip') || name.endsWith('.jsdos') || name.endsWith('.dosz')) {
      const isDos = payloadType === 'dos' || name.endsWith('.jsdos')
      storageKey = isDos ? `dos/${postId}.zip` : `zip/${postId}.zip`
      keyColumn = 'payload_key'
      responseType = 'zip'
    }
    // Audio files by extension
    else if (ext && ['mp3', 'wav', 'ogg', 'm4a', 'webm'].includes(ext)) {
      const extMap: Record<string, string> = { mp3: '.mp3', wav: '.wav', ogg: '.ogg', m4a: '.m4a', webm: '.webm' }
      storageKey = `audio/${postId}${extMap[ext]}`
      keyColumn = 'gif_key'
      responseType = 'gif'
    }
    // Image files by extension
    else if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
      const extMap: Record<string, string> = { png: '.png', jpg: '.jpg', jpeg: '.jpg', gif: '.gif', webp: '.webp', svg: '.svg', bmp: '.bmp', ico: '.ico' }
      storageKey = `gif/${postId}${extMap[ext]}`
      keyColumn = 'gif_key'
      responseType = 'gif'
    }
    // Fallback: store as generic payload with original extension
    else {
      const safeExt = ext ? `.${ext}` : ''
      storageKey = `payload/${postId}${safeExt}`
      keyColumn = 'payload_key'
      responseType = 'zip'
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    const result = await c.env.DB.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, ${keyColumn}, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).bind(postId, c.get('user')?.id || '', c.get('user')?.username || 'anonymous', '', '[]', storageKey).run()
    
    if (!result.success) {
      return c.json({ error: 'Failed to create pending post' }, 500)
    }
    
    const origin = new URL(c.req.url).origin
    const uploadUrl = `${origin}/api/upload/${storageKey}`
    const resp: any = { postId }
    
    if (responseType === 'zip') {
      resp.zipUploadUrl = uploadUrl
      resp.zipKey = storageKey
    } else if (responseType === 'swf') {
      resp.swfUploadUrl = uploadUrl
      resp.swfKey = storageKey
    } else {
      resp.gifUploadUrl = uploadUrl
      resp.gifKey = storageKey
    }
    
    return c.json(resp)
  } catch (error: any) {
    console.error('Prepare post error:', error)
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
})

// Step 3 — POST /api/posts/commit (protected)
app.post('/api/posts/commit', requireAuth, async (c) => {
  try {
    const { postId, gifKey, zipKey, swfKey, text, hashtags, poll: pollData } = await c.req.json()
    
    // Validate text
    if (!text || text.length < 1 || text.length > 200) {
      return c.json({ error: 'Text must be 1-200 characters' }, 422)
    }
    
    // Validate hashtags
    if (!Array.isArray(hashtags) || hashtags.length > 5) {
      return c.json({ error: 'Maximum 5 hashtags allowed' }, 422)
    }
    
    for (const tag of hashtags) {
      if (typeof tag !== 'string' || tag.length > 20 || !/^[a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+$/u.test(tag)) {
        return c.json({ error: 'Hashtags must be alphanumeric, Japanese characters, and ≤20 chars' }, 422)
      }
    }

    // Extract mentions from text
    const mentionRegex = /@([a-zA-Z0-9_]{1,20})/g
    const mentionSet = new Set<string>()
    let mentionMatch
    while ((mentionMatch = mentionRegex.exec(text)) !== null) {
      mentionSet.add(mentionMatch[1])
    }
    const mentionedUsernames = Array.from(mentionSet)
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    let post: any
    
    if (gifKey || zipKey || swfKey) {
      const key = zipKey || swfKey || gifKey
      // Validate that this is a pending post and key matches
      const pendingPost = await c.env.DB.prepare(`
        SELECT * FROM posts WHERE id = ? AND status = 'pending' AND (gif_key = ? OR payload_key = ? OR swf_key = ?)
      `).bind(postId, key, key, key).first()
      
      if (!pendingPost) {
        return c.json({ error: 'Invalid or expired post preparation' }, 422)
      }
      
      // Resolve mentions
      const userId = c.get('user')?.id || ''
      const username = c.get('user')?.username || 'anonymous'
      const mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, username)
      
      // Update post to published status
      const updateResult = await c.env.DB.prepare(`
        UPDATE posts 
        SET text = ?, hashtags = ?, mentions = ?, status = 'published', created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
      `).bind(text, JSON.stringify(hashtags), mentionsJson, postId).run()
      
      if (!updateResult.success) {
        return c.json({ error: 'Failed to commit post' }, 500)
      }
      
      // Return the updated post
      post = await c.env.DB.prepare(`
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?
      `).bind(postId).first()

      // Create mention notifications for mentioned users (skip self-mentions)
      if (mentionedUsernames.length > 0) {
        try {
          const mentionData = JSON.parse(mentionsJson) as Array<{username: string, user_id: string}>
          for (const mention of mentionData) {
            if (mention.user_id === userId) continue
            await c.env.DB.prepare(
              'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)'
            ).bind(nanoid(), mention.user_id, 'mention', postId, userId).run()
          }
        } catch (e) {
          // Don't fail the post creation if mention notifications fail
          console.error('Failed to create mention notifications:', e)
        }
      }

      // Create poll if poll data was provided
      if (pollData && pollData.question && pollData.options && pollData.options.length >= 2) {
        try {
          const pId = crypto.randomUUID()
          await c.env.DB.prepare(`
            INSERT INTO polls (id, post_id, question, multiple_choice, ends_at)
            VALUES (?, ?, ?, ?, ?)
          `).bind(pId, postId, pollData.question, pollData.multipleChoice ? 1 : 0, pollData.endsAt || null).run()
          for (const label of pollData.options) {
            await c.env.DB.prepare(`
              INSERT INTO poll_options (id, poll_id, label)
              VALUES (?, ?, ?)
            `).bind(crypto.randomUUID(), pId, label).run()
          }
        } catch (e) {
          console.error('Failed to create poll:', e)
        }
      }

      // Patch DOS ZIP with js-dos.json for auto-execution
      if (zipKey && zipKey.startsWith('dos/')) {
        try {
          const fflate = await import('fflate')
          const object = await c.env.BUCKET.get(zipKey)
          if (object) {
            const zipData = await object.arrayBuffer()
            const unzipped = fflate.unzipSync(new Uint8Array(zipData))

            let command = 'run.bat'
            const files = Object.keys(unzipped)
            const lower = files.map(f => f.toLowerCase())
            const runBatIdx = lower.indexOf('run.bat')
            if (runBatIdx !== -1) {
              command = files[runBatIdx]
            } else {
              const exeFile = files.find(f => f.toLowerCase().endsWith('.exe') || f.toLowerCase().endsWith('.com'))
              if (exeFile) command = exeFile
            }

            unzipped['js-dos.json'] = new TextEncoder().encode(JSON.stringify({
              executable: command,
              exit: true
            }))

            const patched = fflate.zipSync(unzipped, { level: 9 })
            await c.env.BUCKET.put(zipKey, patched, {
              httpMetadata: { contentType: 'application/zip' }
            })
          }
        } catch (e) {
          console.error('Failed to patch DOS ZIP:', e)
        }
      }
    } else {
      // Resolve mentions
      const username = c.get('user')?.username || 'anonymous'
      const mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, username)
      
      // Create text-only post directly
      const result = await c.env.DB.prepare(`
        INSERT INTO posts (id, user_id, username, text, hashtags, mentions, status)
        VALUES (?, ?, ?, ?, ?, ?, 'published')
      `).bind(postId, c.get('user')?.id || '', username, text, JSON.stringify(hashtags), mentionsJson).run()
      
      if (!result.success) {
        return c.json({ error: 'Failed to create post' }, 500)
      }
      
      // Return the created post
      post = await c.env.DB.prepare(`
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?
      `).bind(postId).first()

      // Create mention notifications for mentioned users (skip self-mentions)
      if (mentionedUsernames.length > 0) {
        try {
          const userId = c.get('user')?.id || ''
          const mentionData = JSON.parse(mentionsJson) as Array<{username: string, user_id: string}>
          for (const mention of mentionData) {
            if (mention.user_id === userId) continue
            await c.env.DB.prepare(
              'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)'
            ).bind(nanoid(), mention.user_id, 'mention', postId, userId).run()
          }
        } catch (e) {
          // Don't fail the post creation if mention notifications fail
          console.error('Failed to create mention notifications:', e)
        }
      }

      // Create poll if poll data was provided
      if (pollData && pollData.question && pollData.options && pollData.options.length >= 2) {
        try {
          const pId = crypto.randomUUID()
          await c.env.DB.prepare(`
            INSERT INTO polls (id, post_id, question, multiple_choice, ends_at)
            VALUES (?, ?, ?, ?, ?)
          `).bind(pId, postId, pollData.question, pollData.multipleChoice ? 1 : 0, pollData.endsAt || null).run()
          for (const label of pollData.options) {
            await c.env.DB.prepare(`
              INSERT INTO poll_options (id, poll_id, label)
              VALUES (?, ?, ?)
            `).bind(crypto.randomUUID(), pId, label).run()
          }
        } catch (e) {
          console.error('Failed to create poll:', e)
        }
      }

      // Queue ActivityPub delivery for public posts
      if (post && post.visibility === 'public') {
        try {
          const user = c.get('user')
          if (user) {
            // Build mention actor URLs for CC
            const mentionActorUrls: string[] = []
            try {
              const mentionData = JSON.parse(mentionsJson) as Array<{username: string, user_id: string}>
              for (const m of mentionData) {
                mentionActorUrls.push(`${c.env.BASE_URL}/actors/${m.username}`)
              }
            } catch {}
            const note = buildNoteObject(post, user, c.env.BASE_URL, mentionActorUrls)
            const activity = buildCreateActivity(note, user, c.env.BASE_URL)
            
            // Get all followers to deliver to
            const followers = await c.env.DB.prepare(`
              SELECT inbox_url FROM ap_followers WHERE local_user_id = ?
            `).bind(user.id).all()
            
            // Queue delivery to each follower
            for (const follower of followers.results) {
              const inboxUrl = follower.inbox_url
              if (inboxUrl) {
                await c.env.AP_DELIVERY_QUEUE.send({
                  type: 'delivery',
                  inboxUrl,
                  activity,
                  senderUsername: user.username
                })
              }
            }
          }
        } catch (deliveryError) {
          console.error('Failed to queue ActivityPub delivery:', deliveryError)
          // Don't fail the post creation if delivery queuing fails
        }
      }
    }

    if (pollData && pollData.question && pollData.options && pollData.options.length >= 2) {
      try {
        await enrichPostsWithPolls([post], c.env.DB, c.get('user')?.id)
      } catch (e) {
        console.error('Failed to enrich post with poll:', e)
      }
    }

    c.executionCtx.waitUntil(analyzeSentiment(c, post.id, post.text))

    return c.json({ post })
  } catch (error: any) {
    console.error('Commit post error:', error)
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/posts - create post (protected)
app.post('/api/posts', requireAuth, async (c) => {
  const isTestEnvironment = c.req.url.includes('localhost:8788')
  let rl = { allowed: true, remaining: 0, resetIn: 0 }
  try {
    rl = await checkRateLimit(c.env.RATE_LIMIT, {
      key: `post:${c.get('user')?.id}`,
      limit: 5,
      windowSeconds: 60
    })
  } catch (kvError: any) {
    console.warn('Post rate limit check failed, proceeding anyway:', kvError.message)
  }
  if (!rl.allowed) return rateLimitResponse(c, rl.resetIn, 5)

  try {
    const contentType = c.req.header('content-type')
    let text: string
    let payloadKey: string | undefined
    let gifKey: string | undefined
    let swfKey: string | undefined
    let thumbnailKey: string | undefined
    let thumbnailFile: File | undefined

    let pollData: { question: string; options: string[]; multipleChoice: boolean; endsAt?: string } | null = null

    if (contentType?.includes('multipart/form-data')) {
      // Handle multipart/form-data (for thumbnail uploads)
      const formData = await c.req.formData()
      text = formData.get('text') as string
      const providedPostId = formData.get('postId') as string | null
      payloadKey = formData.get('payloadKey') as string | null || undefined
      gifKey = formData.get('gifKey') as string | null || undefined
      swfKey = formData.get('swfKey') as string | null || undefined
      thumbnailFile = formData.get('thumbnail') as File | null || undefined
      
      const userId = c.get('user')?.id
      const username = c.get('user')?.username || 'anonymous'

      // Use provided ID or generate a new one
      const postId = providedPostId || crypto.randomUUID()

      // Process thumbnail if present
      if (thumbnailFile && thumbnailFile.size > 0) {
        // Validate thumbnail size (1MB max)
        if (thumbnailFile.size > 1024 * 1024) {
          return c.json({ error: 'Thumbnail must be ≤1MB' }, 400)
        }

        // Validate thumbnail extension
        const allowedExts = ['jpg', 'jpeg', 'png', 'gif']
        const ext = thumbnailFile.name.toLowerCase().split('.').pop()
        if (!ext || !allowedExts.includes(ext)) {
          return c.json({ error: 'Thumbnail must be .jpg, .jpeg, .png, or .gif' }, 400)
        }

        // Upload thumbnail to R2
        if (!c.env.BUCKET) {
          return c.json({ error: 'Storage not available' }, 500)
        }

        thumbnailKey = `thumbnail/${postId}.${ext}`

        await c.env.BUCKET.put(thumbnailKey, await thumbnailFile.arrayBuffer(), {
          httpMetadata: {
            contentType: thumbnailFile.type
          }
        })
      }

      if (!text || text.length > 200) {
        return c.json({ error: 'Invalid text' }, 400)
      }
      
      // Extract hashtags from text
      const hashtagRegex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu
      const hashtagSet = new Set<string>()
      let match
      while ((match = hashtagRegex.exec(text)) !== null) {
        hashtagSet.add(match[1])
      }
      const hashtags = Array.from(hashtagSet)

      // Extract mentions from text
      const mentionRegex = /@([a-zA-Z0-9_]{1,20})/g
      const mentionSet = new Set<string>()
      let mentionMatch
      while ((mentionMatch = mentionRegex.exec(text)) !== null) {
        mentionSet.add(mentionMatch[1])
      }
      const mentionedUsernames = Array.from(mentionSet)

      // Resolve mentions
      const mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, username)
      
      // Check if database is available
      if (!c.env.DB) {
        console.error('Database not available')
        return c.json({ error: 'Database not available' }, 500)
      }

      let result
      if (providedPostId) {
        // Update existing pending post
        result = await c.env.DB.prepare(`
          UPDATE posts 
          SET text = ?, hashtags = ?, mentions = ?, payload_key = ?, gif_key = ?, swf_key = ?, thumbnail_key = ?, status = 'published', created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND user_id = ?
        `).bind(text, JSON.stringify(hashtags), mentionsJson, payloadKey || null, gifKey || null, swfKey || null, thumbnailKey || null, providedPostId, userId).run()
      } else {
        // Insert new post
        result = await c.env.DB.prepare(`
          INSERT INTO posts (id, user_id, username, text, hashtags, mentions, payload_key, gif_key, swf_key, thumbnail_key, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')
        `).bind(postId, userId, username, text, JSON.stringify(hashtags), mentionsJson, payloadKey || null, gifKey || null, swfKey || null, thumbnailKey || null).run()
      }
      
      if (!result.success) {
        console.error('Database operation failed:', result)
        return c.json({ error: 'Failed to save post', details: result }, 500)
      }

      const formPoll = formData.get('poll')
      if (formPoll) {
        try {
          pollData = JSON.parse(formPoll as string)
        } catch { /* ignore invalid poll data */ }
      }

      // Return the post (need to fetch it first)
      const post = await c.env.DB.prepare(`
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at 
        FROM posts p 
        LEFT JOIN users u ON p.user_id = u.id 
        WHERE p.id = ?
      `).bind(postId).first()

      // Handle poll creation and notifications...
      // (This part is common for both multipart and JSON, so we should keep it below)
      
      // We need to return early for multipart to avoid duplication
      // but we need to handle notifications and poll first.
      
      // Let's refactor to handle poll and notifications after this block if we have a successful 'post'
      if (post) {
        // Create mention notifications
        if (mentionedUsernames.length > 0) {
          try {
            const mentionData = JSON.parse(mentionsJson) as Array<{username: string, user_id: string}>
            for (const mention of mentionData) {
              if (mention.user_id === userId) continue
              await c.env.DB.prepare(
                'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)'
              ).bind(nanoid(), mention.user_id, 'mention', postId, userId).run()
            }
          } catch (e) {
            console.error('Failed to create mention notifications:', e)
          }
        }

        // Create poll
        if (pollData && pollData.question && pollData.options && pollData.options.length >= 2) {
          try {
            const pollId = crypto.randomUUID()
            await c.env.DB.prepare(`
              INSERT INTO polls (id, post_id, question, multiple_choice, ends_at)
              VALUES (?, ?, ?, ?, ?)
            `).bind(pollId, postId, pollData.question, pollData.multipleChoice ? 1 : 0, pollData.endsAt || null).run()

            for (const label of pollData.options) {
              await c.env.DB.prepare(`
                INSERT INTO poll_options (id, poll_id, label)
                VALUES (?, ?, ?)
              `).bind(crypto.randomUUID(), pollId, label).run()
            }
          } catch (e) {
            console.error('Failed to create poll:', e)
          }
        }

        c.executionCtx.waitUntil(analyzeSentiment(c, (post as any).id, (post as any).text))

        return c.json({ success: true, post })
      }
    } else {
      // Handle JSON request (existing behavior)
      const body = await c.req.json()
      text = body.text
      payloadKey = body.payloadKey
      gifKey = body.gifKey
      swfKey = body.swfKey
      pollData = body.poll || null
    }
    
    if (!text || text.length > 200) {
      return c.json({ error: 'Invalid text' }, 400)
    }
    
    const postId = crypto.randomUUID()
    const userId = c.get('user')?.id
    const username = c.get('user')?.username || 'anonymous'
    
    // Extract hashtags from text
    const hashtagRegex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu
    const hashtagSet = new Set<string>()
    let match
    while ((match = hashtagRegex.exec(text)) !== null) {
      hashtagSet.add(match[1])
    }
    const hashtags = Array.from(hashtagSet)

    // Extract mentions from text
    const mentionRegex = /@([a-zA-Z0-9_]{1,20})/g
    const mentionSet = new Set<string>()
    let mentionMatch
    while ((mentionMatch = mentionRegex.exec(text)) !== null) {
      mentionSet.add(mentionMatch[1])
    }
    const mentionedUsernames = Array.from(mentionSet)

    // Resolve mentions
    const mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, username)
    
    // Check if database is available
    if (!c.env.DB) {
      console.error('Database not available')
      return c.json({ error: 'Database not available' }, 500)
    }
    
    const result = await c.env.DB.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, mentions, payload_key, gif_key, swf_key, thumbnail_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(postId, userId, username, text, JSON.stringify(hashtags), mentionsJson, payloadKey || null, gifKey || null, swfKey || null, thumbnailKey || null).run()
    
    if (!result.success) {
      console.error('Database insert failed:', result)
      return c.json({ error: 'Failed to create post', details: result }, 500)
    }

    // Create poll if poll data was provided
    if (pollData && pollData.question && pollData.options && pollData.options.length >= 2) {
      try {
        const pollId = crypto.randomUUID()
        await c.env.DB.prepare(`
          INSERT INTO polls (id, post_id, question, multiple_choice, ends_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(pollId, postId, pollData.question, pollData.multipleChoice ? 1 : 0, pollData.endsAt || null).run()

        const optionIds: string[] = []
        for (const label of pollData.options) {
          const optId = crypto.randomUUID()
          optionIds.push(optId)
          await c.env.DB.prepare(`
            INSERT INTO poll_options (id, poll_id, label)
            VALUES (?, ?, ?)
          `).bind(optId, pollId, label).run()
        }
      } catch (e) {
        console.error('Failed to create poll:', e)
        // Don't fail post creation if poll creation fails
      }
    }

    // Create mention notifications for mentioned users (skip self-mentions)
    if (mentionedUsernames.length > 0) {
      try {
        const mentionData = JSON.parse(mentionsJson) as Array<{username: string, user_id: string}>
        for (const mention of mentionData) {
          if (mention.user_id === userId) continue
          await c.env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)'
          ).bind(nanoid(), mention.user_id, 'mention', postId, userId).run()
        }
      } catch (e) {
        // Don't fail the post creation if mention notifications fail
        console.error('Failed to create mention notifications:', e)
      }
    }

    // ActivityPub delivery for public posts
    try {
      // Get user info for ActivityPub
      const user = await c.env.DB.prepare(
        'SELECT id, username, display_name FROM users WHERE id = ?'
      ).bind(userId).first() as { id: string, username: string, display_name: string } | null

      if (user && c.env.AP_DELIVERY_QUEUE) {
        // Get post details including mentions
        const post = await c.env.DB.prepare(
          'SELECT id, text, created_at, visibility, mentions FROM posts WHERE id = ?'
        ).bind(postId).first() as { id: string, text: string, created_at: string, visibility: string, mentions: string | null } | null

        if (post && post.visibility === 'public') {
          // Build mention actor URLs for CC
          const mentionActorUrls: string[] = []
          try {
            if (post.mentions) {
              const mentionData = JSON.parse(post.mentions) as Array<{username: string, user_id: string}>
              for (const m of mentionData) {
                mentionActorUrls.push(`${c.env.BASE_URL}/actors/${m.username}`)
              }
            }
          } catch {}
          const note = buildNoteObject(post, user, c.env.BASE_URL, mentionActorUrls)
          const activity = buildCreateActivity(note, user, c.env.BASE_URL)

          // Get followers from ap_followers
          const followers = await c.env.DB.prepare(
            'SELECT inbox_url FROM ap_followers WHERE local_user_id = ?'
          ).bind(userId).all() as { results: Array<{ inbox_url: string }> }

          // Send to queue for each follower
          for (const follower of followers.results) {
            await c.env.AP_DELIVERY_QUEUE.send({
              inboxUrl: follower.inbox_url,
              activity,
              senderUsername: username
            })
          }
        }
      }
    } catch (e) {
      // Queue not available or other error - skip delivery in development
      console.error('ActivityPub delivery skipped:', String(e))
    }

    // Fetch the created post for enrichment
    const fullPost = await c.env.DB.prepare(
      'SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key as payloadKey, p.swf_key as swfKey, p.thumbnail_key as thumbnailKey, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, \'published\') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?'
    ).bind(postId).first() as any

    if (pollData && pollData.question && pollData.options && pollData.options.length >= 2) {
      try {
        await enrichPostsWithPolls([fullPost], c.env.DB, c.get('user')?.id)
      } catch (e) {
        console.error('Failed to enrich post with poll:', e)
      }
    }

    c.executionCtx.waitUntil(analyzeSentiment(c, fullPost.id, fullPost.text))

    return c.json({ post: fullPost })
  } catch (error: any) {
    console.error('Post creation error:', error)
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/polls/:postId - get poll data
app.get('/api/polls/:postId', async (c) => {
  try {
    const postId = c.req.param('postId')
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500)

    const poll = await c.env.DB.prepare(
      'SELECT * FROM polls WHERE post_id = ?'
    ).bind(postId).first() as any | null

    if (!poll) return c.json({ error: 'Poll not found' }, 404)

    const { results: options } = await c.env.DB.prepare(
      'SELECT * FROM poll_options WHERE poll_id = ? ORDER BY rowid'
    ).bind(poll.id).all()

    let userVote: string | null = null
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    if (sessionData) {
      const vote = await c.env.DB.prepare(
        'SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?'
      ).bind(poll.id, sessionData.user.id).first() as { option_id: string } | null
      if (vote) userVote = vote.option_id
    }

    const now = new Date()
    const endsAt = poll.ends_at || null
    const expired = endsAt ? new Date(endsAt) <= now : false

    if (expired && !poll.ended_notified) {
      try {
        const post = await c.env.DB.prepare(
          'SELECT user_id FROM posts WHERE id = ?'
        ).bind(postId).first() as { user_id: string } | null
        if (post) {
          await c.env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)'
          ).bind(crypto.randomUUID(), post.user_id, 'poll_ended', postId, '').run()
          await c.env.DB.prepare(
            'UPDATE polls SET ended_notified = 1 WHERE id = ?'
          ).bind(poll.id).run()
        }
      } catch (e) {
        console.error('Failed to create poll ended notification:', e)
      }
    }

    return c.json({ poll, options, userVote, expired })
  } catch (error: any) {
    console.error('Get poll error:', error)
    return c.json({ error: 'Failed to get poll', details: error?.message }, 500)
  }
})

// POST /api/polls/:pollId/vote - vote on a poll option (protected)
app.post('/api/polls/:pollId/vote', requireAuth, async (c) => {
  try {
    const pollId = c.req.param('pollId')
    const userId = c.get('user')?.id
    const { optionId } = await c.req.json()

    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500)
    if (!optionId) return c.json({ error: 'optionId is required' }, 400)

    const poll = await c.env.DB.prepare(
      'SELECT * FROM polls WHERE id = ?'
    ).bind(pollId).first() as any | null

    if (!poll) return c.json({ error: 'Poll not found' }, 404)

    if (poll.ends_at && new Date(poll.ends_at) <= new Date()) {
      return c.json({ error: 'Poll has ended' }, 400)
    }

    const option = await c.env.DB.prepare(
      'SELECT * FROM poll_options WHERE id = ? AND poll_id = ?'
    ).bind(optionId, pollId).first() as any | null

    if (!option) return c.json({ error: 'Option not found' }, 404)

    const existingVote = await c.env.DB.prepare(
      'SELECT * FROM poll_votes WHERE poll_id = ? AND user_id = ?'
    ).bind(pollId, userId).first() as any | null

    if (existingVote) {
      if (existingVote.option_id === optionId) {
        return c.json({ error: 'Already voted for this option' }, 409)
      }
      // Change vote: remove old vote, decrement old option, add new vote, increment new option
      await c.env.DB.prepare(
        'DELETE FROM poll_votes WHERE id = ?'
      ).bind(existingVote.id).run()
      await c.env.DB.prepare(
        'UPDATE poll_options SET votes_count = MAX(0, votes_count - 1) WHERE id = ?'
      ).bind(existingVote.option_id).run()
    }

    await c.env.DB.prepare(
      'INSERT INTO poll_votes (id, poll_id, option_id, user_id) VALUES (?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), pollId, optionId, userId).run()

    await c.env.DB.prepare(
      'UPDATE poll_options SET votes_count = votes_count + 1 WHERE id = ?'
    ).bind(optionId).run()

    const { results: options } = await c.env.DB.prepare(
      'SELECT * FROM poll_options WHERE poll_id = ? ORDER BY rowid'
    ).bind(pollId).all()

    return c.json({ options, userVote: optionId })
  } catch (error: any) {
    console.error('Vote error:', error)
    return c.json({ error: 'Failed to vote', details: error?.message }, 500)
  }
})

// POST /api/posts/:id/fresh - toggle Fresh! (protected)
app.post('/api/posts/:id/fresh', requireAuth, async (c) => {

  const postId = c.req.param('id')
  const userId = c.get('user')?.id || ''
  const currentUser = c.get('user')
  
  // Get post to check ownership for notification and remote actor
  const post = await c.env.DB.prepare(
    'SELECT user_id, actor_id, username FROM posts WHERE id = ? AND status = \'published\''
  ).bind(postId).first() as { user_id: string, actor_id: string | null, username: string } | null
  
  if (!post) {
    return c.json({ error: 'Post not found' }, 404)
  }
  
  // Check if already freshed
  const existing = await c.env.DB.prepare(
    'SELECT * FROM freshs WHERE post_id = ? AND user_id = ?'
  ).bind(postId, userId).first()
  
  if (existing) {
    // Remove fresh
    await c.env.DB.prepare(
      'DELETE FROM freshs WHERE post_id = ? AND user_id = ?'
    ).bind(postId, userId).run()
    
    const result = await c.env.DB.prepare(
      'UPDATE posts SET fresh_count = fresh_count - 1 WHERE id = ? RETURNING fresh_count'
    ).bind(postId).first<{ fresh_count: number }>()
    
    return c.json({ freshed: false, fresh_count: result?.fresh_count ?? 0 })
  } else {
    // Add fresh
    await c.env.DB.prepare(
      'INSERT INTO freshs (post_id, user_id) VALUES (?, ?)'
    ).bind(postId, userId).run()
    
    const result = await c.env.DB.prepare(
      'UPDATE posts SET fresh_count = fresh_count + 1 WHERE id = ? RETURNING fresh_count'
    ).bind(postId).first<{ fresh_count: number }>()
    
    // Create notification for post author (only if not self-freshing)
    if (post.user_id !== userId) {
      try {
        const existingNotif = await c.env.DB.prepare(
          'SELECT id, actor_id, actor_data FROM notifications WHERE user_id = ? AND post_id = ? AND type = \'fresh\' ORDER BY created_at DESC LIMIT 1'
        ).bind(post.user_id, postId).first() as any

        if (existingNotif) {
          const actorData = existingNotif.actor_data
            ? JSON.parse(existingNotif.actor_data)
            : existingNotif.actor_id
              ? [existingNotif.actor_id]
              : []
          if (!actorData.includes(userId)) {
            actorData.push(userId)
          }
          await c.env.DB.prepare(
            'UPDATE notifications SET actor_id = ?, actor_data = ?, created_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\'), read = 0 WHERE id = ?'
          ).bind(actorData[0], JSON.stringify(actorData), existingNotif.id).run()
        } else {
          await c.env.DB
            .prepare('INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)')
            .bind(nanoid(), post.user_id, 'fresh', postId, userId)
            .run()
        }
      } catch (e) {
        console.error('Failed to create fresh notification:', e)
      }
    }
    
    // If the post is from a remote actor, send Like activity
    if (post.actor_id && currentUser && c.env.AP_DELIVERY_QUEUE) {
      try {
        const actorResponse = await fetch(post.actor_id, {
          headers: { 'Accept': 'application/activity+json, application/ld+json' }
        })
        if (actorResponse.ok) {
          const actorData = await actorResponse.json() as any
          const inboxUrl = actorData.inbox
          if (inboxUrl) {
            const likeActivity = {
              '@context': 'https://www.w3.org/ns/activitystreams',
              id: `${c.env.BASE_URL}/activities/like-${nanoid()}`,
              type: 'Like',
              actor: `${c.env.BASE_URL}/actors/${currentUser.username}`,
              object: `${c.env.BASE_URL}/notes/${postId}`,
              to: [post.actor_id]
            }
            await c.env.AP_DELIVERY_QUEUE.send({
              type: 'delivery',
              inboxUrl,
              activity: likeActivity,
              senderUsername: currentUser.username
            })
          }
        }
      } catch (e) {
        console.error('Failed to send Like activity for remote post:', e)
      }
    }
    
    return c.json({ freshed: true, fresh_count: result?.fresh_count ?? 0 })
  }
})

// POST /api/posts/:id/bookmark - toggle bookmark (protected)
app.post('/api/posts/:id/bookmark', requireAuth, async (c) => {
  const postId = c.req.param('id')
  const userId = c.get('user')?.id || ''

  // Verify post exists
  const post = await c.env.DB.prepare(
    'SELECT id FROM posts WHERE id = ? AND status = \'published\''
  ).bind(postId).first() as { id: string } | null

  if (!post) {
    return c.json({ error: 'Post not found' }, 404)
  }

  // Check if already bookmarked
  const existing = await c.env.DB.prepare(
    'SELECT * FROM bookmarks WHERE post_id = ? AND user_id = ?'
  ).bind(postId, userId).first()

  if (existing) {
    await c.env.DB.prepare(
      'DELETE FROM bookmarks WHERE post_id = ? AND user_id = ?'
    ).bind(postId, userId).run()

    const result = await c.env.DB.prepare(
      'UPDATE posts SET bookmark_count = bookmark_count - 1 WHERE id = ? RETURNING bookmark_count'
    ).bind(postId).first<{ bookmark_count: number }>()

    return c.json({ bookmarked: false, bookmark_count: result?.bookmark_count ?? 0 })
  } else {
    await c.env.DB.prepare(
      'INSERT INTO bookmarks (post_id, user_id) VALUES (?, ?)'
    ).bind(postId, userId).run()

    const result = await c.env.DB.prepare(
      'UPDATE posts SET bookmark_count = bookmark_count + 1 WHERE id = ? RETURNING bookmark_count'
    ).bind(postId).first<{ bookmark_count: number }>()

    return c.json({ bookmarked: true, bookmark_count: result?.bookmark_count ?? 0 })
  }
})

// GET /api/bookmarks - get bookmarked posts for current user (protected)
app.get('/api/bookmarks', requireAuth, async (c) => {
  try {
    const cursor = c.req.query('cursor')
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50)
    const userId = c.get('user')?.id || ''

    let query: string
    const params: any[] = [userId]

    if (cursor) {
      params.push(cursor)
      query = `
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
        (SELECT COUNT(*) FROM posts WHERE root_id = p.id AND status = 'published') as reply_count,
        COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        INNER JOIN bookmarks b ON b.post_id = p.id AND b.user_id = ?
        WHERE p.status = 'published' AND p.hidden = 0 AND p.created_at < ?
        ORDER BY p.created_at DESC
        LIMIT ?
      `
      params.push(limit)
    } else {
      query = `
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count,
        (SELECT COUNT(*) FROM posts WHERE root_id = p.id AND status = 'published') as reply_count,
        COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        INNER JOIN bookmarks b ON b.post_id = p.id AND b.user_id = ?
        WHERE p.status = 'published' AND p.hidden = 0
        ORDER BY p.created_at DESC
        LIMIT ?
      `
      params.push(limit)
    }

    const result = await c.env.DB.prepare(query).bind(...params).all()
    const posts = result.results || []

    // All posts fetched from bookmarks are by definition bookmarked
    posts.forEach((post: any) => {
      post.is_bookmarked = true
    })

    const nextCursor = posts.length === limit ? posts[posts.length - 1].created_at : null

    return c.json({ posts, nextCursor })
  } catch (error: any) {
    console.error('Bookmarks fetch error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// POST /api/posts/fresh/batch - batch toggle Fresh! for multiple posts (protected)
app.post('/api/posts/fresh/batch', requireAuth, async (c) => {
  try {
    const { post_ids, action } = await c.req.json()
    
    if (!Array.isArray(post_ids) || post_ids.length === 0) {
      return c.json({ error: 'Invalid post_ids array' }, 400)
    }
    
    if (!['add', 'remove'].includes(action)) {
      return c.json({ error: 'Invalid action. Must be "add" or "remove"' }, 400)
    }
    
    const userId = c.get('user')?.id || ''
    const maxBatchSize = 50
    
    if (post_ids.length > maxBatchSize) {
      return c.json({ error: `Maximum batch size is ${maxBatchSize}` }, 400)
    }
    
    // Get posts to check ownership for notifications
    const posts = await c.env.DB.prepare(`
      SELECT id, user_id FROM posts WHERE id IN (${post_ids.map(() => '?').join(',')}) AND status = 'published'
    `).bind(...post_ids).all()
    
    const validPostIds = posts.results?.map(p => p.id) || []
    const invalidIds = post_ids.filter(id => !validPostIds.includes(id))
    
    if (invalidIds.length > 0) {
      return c.json({ error: 'Some posts not found', invalid_ids: invalidIds }, 404)
    }
    
    if (action === 'add') {
      // Check which posts are already freshed to avoid duplicates
      const existingFreshes = await c.env.DB.prepare(`
        SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${post_ids.map(() => '?').join(',')})
      `).bind(userId, ...post_ids).all()
      
      const alreadyFreshed = new Set(existingFreshes.results?.map(f => f.post_id) || [])
      const toFresh = post_ids.filter(id => !alreadyFreshed.has(id))
      
      if (toFresh.length > 0) {
        // Batch insert freshs
        const stmts = toFresh.map(id => c.env.DB.prepare(
          'INSERT INTO freshs (post_id, user_id) VALUES (?, ?)'
        ).bind(id, userId))
        await c.env.DB.batch(stmts)
        
        // Batch update fresh counts
        await c.env.DB.prepare(`
          UPDATE posts SET fresh_count = fresh_count + 1 WHERE id IN (${toFresh.map(() => '?').join(',')})
        `).bind(...toFresh).run()
        
        // Create notifications for non-self posts (grouped)
        const nonSelfPosts = posts.results.filter(p => toFresh.includes(p.id) && p.user_id !== userId)
        
        if (nonSelfPosts.length > 0) {
          try {
            // Get existing fresh notifications for these posts
            const userPostPairs = nonSelfPosts.map(p => ({ userId: p.user_id, postId: p.id }))
            const existingNotifs = await c.env.DB.prepare(`
              SELECT id, user_id, post_id, actor_id, actor_data FROM notifications 
              WHERE (user_id, post_id) IN (${userPostPairs.map(() => '(?, ?)').join(',')}) AND type = 'fresh'
            `).bind(...userPostPairs.flatMap(p => [p.userId, p.postId])).all()
            
            const existingMap = new Map<string, any>()
            for (const row of (existingNotifs.results || [])) {
              existingMap.set(`${row.user_id}:${row.post_id}`, row)
            }
            
            const inserts: Array<[string, string, string, string, string]> = []
            
            for (const p of nonSelfPosts) {
              const key = `${p.user_id}:${p.id}`
              const existing = existingMap.get(key)
              
              if (existing) {
                const actorData = existing.actor_data
                  ? JSON.parse(existing.actor_data)
                  : existing.actor_id
                    ? [existing.actor_id]
                    : []
                if (!actorData.includes(userId)) {
                  actorData.push(userId)
                }
                await c.env.DB.prepare(
                  'UPDATE notifications SET actor_id = ?, actor_data = ?, created_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\'), read = 0 WHERE id = ?'
                ).bind(actorData[0], JSON.stringify(actorData), existing.id).run()
              } else {
                inserts.push([nanoid(), String(p.user_id), 'fresh', String(p.id), userId])
              }
            }
            
            if (inserts.length > 0) {
              const stmts = inserts.map(row => c.env.DB.prepare(
                'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)'
              ).bind(...row))
              await c.env.DB.batch(stmts)
            }
          } catch (e) {
            console.error('Failed to create batch fresh notifications:', e)
          }
        }
      }
      
      return c.json({ freshed: toFresh, already_freshed: Array.from(alreadyFreshed) })
    } else {
      // Remove freshes
      await c.env.DB.prepare(`
        DELETE FROM freshs WHERE user_id = ? AND post_id IN (${post_ids.map(() => '?').join(',')})
      `).bind(userId, ...post_ids).run()
      
      // Batch update fresh counts
      await c.env.DB.prepare(`
        UPDATE posts SET fresh_count = fresh_count - 1 WHERE id IN (${post_ids.map(() => '?').join(',')})
      `).bind(...post_ids).run()
      
      return c.json({ unfreshed: post_ids })
    }
  } catch (error: any) {
    console.error('Batch fresh error:', error)
    return c.json({ error: 'Batch fresh operation failed', details: error?.message }, 500)
  }
})

// POST /api/posts/:id/share - toggle share/repost (protected)
app.post('/api/posts/:id/share', requireAuth, async (c) => {
  try {
    const postId = c.req.param('id')
    const currentUser = c.get('user')
    if (!currentUser) return c.json({ error: 'Unauthorized' }, 401)

    // Get post info
    const post = await c.env.DB.prepare(
      'SELECT id, user_id, actor_id, username FROM posts WHERE id = ? AND status = \'published\''
    ).bind(postId).first() as { id: string, user_id: string, actor_id: string | null, username: string } | null

    if (!post) {
      return c.json({ error: 'Post not found' }, 404)
    }

    // Check if already shared
    const existing = await c.env.DB.prepare(
      'SELECT id FROM shares WHERE post_id = ? AND user_id = ?'
    ).bind(postId, currentUser.id).first()

    if (existing) {
      // Remove share
      await c.env.DB.prepare(
        'DELETE FROM shares WHERE post_id = ? AND user_id = ?'
      ).bind(postId, currentUser.id).run()

      await c.env.DB.prepare(
        'UPDATE posts SET reply_count = MAX(0, reply_count - 1) WHERE id = ?'
      ).bind(postId).run()

      return c.json({ shared: false })
    } else {
      // Add share
      const shareId = nanoid()
      await c.env.DB.prepare(
        'INSERT INTO shares (id, post_id, user_id, actor_id, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))'
      ).bind(shareId, postId, currentUser.id, `${c.env.BASE_URL}/actors/${currentUser.username}`).run()

      await c.env.DB.prepare(
        'UPDATE posts SET reply_count = reply_count + 1 WHERE id = ?'
      ).bind(postId).run()

      // Send Announce for remote posts
      if (post.actor_id && c.env.AP_DELIVERY_QUEUE) {
        try {
          const actorResponse = await fetch(post.actor_id, {
            headers: { 'Accept': 'application/activity+json, application/ld+json' }
          })
          if (actorResponse.ok) {
            const actorData = await actorResponse.json() as any
            const inboxUrl = actorData.inbox
            if (inboxUrl) {
              const announceActivity = {
                '@context': 'https://www.w3.org/ns/activitystreams',
                id: `${c.env.BASE_URL}/activities/announce-${shareId}`,
                type: 'Announce',
                actor: `${c.env.BASE_URL}/actors/${currentUser.username}`,
                object: `${c.env.BASE_URL}/notes/${postId}`,
                to: [post.actor_id, 'https://www.w3.org/ns/activitystreams#Public']
              }
              await c.env.AP_DELIVERY_QUEUE.send({
                type: 'delivery',
                inboxUrl,
                activity: announceActivity,
                senderUsername: currentUser.username
              })
            }
          }
        } catch (e) {
          console.error('Failed to send Announce activity:', e)
        }
      }

      return c.json({ shared: true, share_id: shareId })
    }
  } catch (error: any) {
    console.error('Share error:', error)
    return c.json({ error: 'Share operation failed', details: error?.message }, 500)
  }
})

// GET /api/posts/:id/replies - get direct replies
app.get('/api/posts/:id/replies', async (c) => {
  try {
    const postId = c.req.param('id')
    const cursor = c.req.query('cursor')
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50)
    
    // Get current user ID from session (optional)
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    const currentUserId = sessionData?.user?.id || null

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    // Verify parent post exists and is published
    const parentPost = await c.env.DB.prepare(
      'SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, \'published\') as status, created_at FROM posts WHERE id = ? AND status = \'published\''
    ).bind(postId).first()
    
    if (!parentPost) {
      return c.json({ error: 'Post not found' }, 404)
    }
    
    let query = `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.parent_id = ? AND p.status = 'published' 
       ORDER BY p.created_at ASC LIMIT ?`
    const params: any[] = [postId, limit]
    
    if (cursor) {
      query = `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.parent_id = ? AND p.status = 'published' AND p.created_at < ?
       ORDER BY p.created_at ASC LIMIT ?`
      params.splice(1, 0, cursor)
    }
    
    const result = await c.env.DB.prepare(query).bind(...params).all()
    
    if (!result.success) {
      return c.json({ error: 'Failed to fetch replies' }, 500)
    }
    
    const replies = result.results || []
    const nextCursor = replies.length === limit ? replies[replies.length - 1].created_at : null

    await enrichPostsWithPolls(replies as any[], c.env.DB, currentUserId)
    
    return c.json({ replies, nextCursor })
  } catch (error: any) {
    console.error('Replies fetch error:', error)
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/tags/trending - get top 5 trending hashtags (based on recent N posts percentage)
app.get('/api/tags/trending', async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Get recent posts count from query param (default: 100)
    const recentCountParam = c.req.query('recent_count')
    const recentCount = recentCountParam ? parseInt(recentCountParam, 10) : 100
    const validRecentCount = isNaN(recentCount) || recentCount < 10 || recentCount > 1000 ? 100 : recentCount

    // Query trending tags based on percentage in recent N posts
    const result = await c.env.DB.prepare(`
WITH recent_posts AS (
  SELECT id, hashtags
  FROM posts
  WHERE hidden = 0 AND status = 'published'
  ORDER BY created_at DESC
  LIMIT ?
)
SELECT
  value AS tag,
  COUNT(*) AS count,
  ROUND(COUNT(*) * 100.0 / ?, 1) AS percentage
FROM recent_posts, json_each(recent_posts.hashtags)
GROUP BY value
ORDER BY count DESC
LIMIT 5
    `).bind(validRecentCount, validRecentCount).all()

    if (!result.success) {
      return c.json({ error: 'Failed to fetch trending tags' }, 500)
    }

    const tags = result.results || []

    return c.json({ tags }, 200, {
      'Cache-Control': 'public, max-age=60'
    })
  } catch (error: any) {
    console.error('Trending tags error:', error)
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/tags/suggest?q=prefix - suggest hashtags matching prefix
app.get('/api/tags/suggest', async (c) => {
  try {
    const q = c.req.query('q')
    if (!q || q.length < 1) {
      return c.json({ tags: [] })
    }

    const limit = Math.min(parseInt(c.req.query('limit') || '10', 10), 20)
    const prefix = q.toLowerCase()

    const result = await c.env.DB.prepare(`
      SELECT DISTINCT value AS tag, COUNT(*) AS count
      FROM posts, json_each(posts.hashtags)
      WHERE posts.hidden = 0 AND posts.status = 'published'
        AND LOWER(value) LIKE ?
      GROUP BY value
      ORDER BY count DESC
      LIMIT ?
    `).bind(prefix + '%', limit).all()

    const tags = result.results || []
    return c.json({ tags }, 200, {
      'Cache-Control': 'public, max-age=30'
    })
  } catch (error: any) {
    console.error('Tag suggest error:', error)
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/posts/:id/thread - get full thread
app.get('/api/posts/:id/thread', async (c) => {
  try {
    const postId = c.req.param('id')
    
    // Get current user ID from session (optional)
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    const currentUserId = sessionData?.user?.id || null
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    // First get the post to find root_id
    const post = await c.env.DB.prepare(
      'SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, \'published\') as status, created_at FROM posts WHERE id = ? AND status = \'published\''
    ).bind(postId).first()
    
    if (!post) {
      return c.json({ error: 'Post not found' }, 404)
    }
    
    const rootId = post.root_id || post.id
    
    // Get root post with user info
    const rootPost = await c.env.DB.prepare(
      `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.id = ? AND p.status = 'published'`
    ).bind(rootId).first()
    
    if (!rootPost) {
      return c.json({ error: 'Thread not found' }, 404)
    }
    
    // Get all replies in thread with user info (max 200 for MVP)
    const repliesResult = await c.env.DB.prepare(
      `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.root_id = ? AND p.status = 'published' AND p.id != ?
       ORDER BY p.created_at ASC LIMIT 200`
    ).bind(rootId, rootId).all()
    
    if (!repliesResult.success) {
      return c.json({ error: 'Failed to fetch thread' }, 500)
    }
    
    const replies = repliesResult.results || []
    
    // Add fresh and bookmark status for current user if logged in
    if (currentUserId) {
      const allPosts = [rootPost, ...replies]
      const postIds = allPosts.map((p: any) => p.id)
      const placeholders = postIds.map(() => '?').join(',')
      
      const freshResult = await c.env.DB.prepare(
        `SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${placeholders})`
      ).bind(currentUserId, ...postIds).all()
      
      if (freshResult.success) {
        const freshedPostIds = new Set((freshResult.results || []).map((f: any) => f.post_id))
        
        // Add is_freshed field to root post and replies
        rootPost.is_freshed = freshedPostIds.has(rootPost.id)
        replies.forEach((post: any) => {
          post.is_freshed = freshedPostIds.has(post.id)
        })
      }
      
      // Add is_bookmarked field to root post and replies
      const bookmarkResult = await c.env.DB.prepare(
        `SELECT post_id FROM bookmarks WHERE user_id = ? AND post_id IN (${placeholders})`
      ).bind(currentUserId, ...postIds).all()
      if (bookmarkResult.success) {
        const bookmarkedPostIds = new Set((bookmarkResult.results || []).map((b: any) => b.post_id))
        rootPost.is_bookmarked = bookmarkedPostIds.has(rootPost.id)
        replies.forEach((post: any) => {
          post.is_bookmarked = bookmarkedPostIds.has(post.id)
        })
      }
    }
    
    // Add poll data
    await enrichPostsWithPolls([rootPost as any], c.env.DB, currentUserId)
    await enrichPostsWithPolls(replies as any[], c.env.DB, currentUserId)

    // Trigger sentiment analysis for unprocessed posts in background
    if ((rootPost as any).sentiment_score == null && (rootPost as any).text) {
      c.executionCtx.waitUntil(analyzeSentiment(c, (rootPost as any).id, (rootPost as any).text))
    }
    for (const r of replies as any[]) {
      if (r.sentiment_score == null && r.text) {
        c.executionCtx.waitUntil(analyzeSentiment(c, r.id, r.text))
      }
    }

    return c.json({ root: rootPost, replies })
  } catch (error: any) {
    console.error('Thread fetch error:', error)
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
})

// Step 1 — POST /api/posts/:id/replies/prepare (protected)
app.post('/api/posts/:id/replies/prepare', requireAuth, async (c) => {
  try {
    const postId = c.req.param('id')
    const { filename, contentType } = await c.req.json()
    
    if (!filename || !contentType) {
      return c.json({ error: 'Missing filename or contentType' }, 400)
    }
    
    const allowedTypes = ['image/gif', 'image/png', 'image/jpeg', 'image/jpg', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/webm']
    if (!allowedTypes.includes(contentType)) {
      return c.json({ error: 'Only image files (GIF, PNG, JPG) and audio files (MP3, WAV, OGG, M4A, WebM) are supported' }, 400)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    // Validate parent post exists and is published
    const parentPost = await c.env.DB.prepare(
      'SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, \'published\') as status, created_at FROM posts WHERE id = ? AND status = \'published\''
    ).bind(postId).first()
    
    if (!parentPost) {
      return c.json({ error: 'Parent post not found' }, 404)
    }
    
    const replyId = crypto.randomUUID()
    let fileExtension: string
    let storageKey: string
    
    if (contentType.startsWith('image/')) {
      fileExtension = contentType === 'image/png' ? '.png' : contentType === 'image/jpeg' || contentType === 'image/jpg' ? '.jpg' : '.gif'
      storageKey = `gif/${replyId}${fileExtension}`
    } else if (contentType.startsWith('audio/')) {
      fileExtension = contentType === 'audio/mpeg' ? '.mp3' : 
                     contentType === 'audio/wav' ? '.wav' : 
                     contentType === 'audio/ogg' ? '.ogg' : 
                     contentType === 'audio/mp4' ? '.m4a' : '.webm'
      storageKey = `audio/${replyId}${fileExtension}`
    } else {
      return c.json({ error: 'Unsupported file type' }, 400)
    }
    
    const gifKey = storageKey
    
    // Compute depth and root_id
    const depth = Math.min(Number(parentPost.depth || 0) + 1, 5)
    const rootId = parentPost.root_id || parentPost.id
    
    // Store pending reply in D1
    const result = await c.env.DB.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, status, parent_id, root_id, depth, reply_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?, 0)
    `).bind(
      replyId, 
      c.get('user')?.id || '', 
      c.get('user')?.username || 'anonymous', 
      '', 
      '[]', 
      '[]',
      gifKey,
      '',
      '',
      postId,
      rootId,
      depth
    ).run()
    
    if (!result.success) {
      return c.json({ error: 'Failed to create pending reply' }, 500)
    }
    
    // Generate upload endpoint URL (our own API)
    const gifUploadUrl = `${new URL(c.req.url).origin}/api/upload/${gifKey}`
    
    return c.json({
      replyId,
      gifUploadUrl,
      gifKey
    })
  } catch (error: any) {
    console.error('Prepare reply error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Step 3 — POST /api/posts/:id/replies/commit (protected)
app.post('/api/posts/:id/replies/commit', requireAuth, async (c) => {
  const postId = c.req.param('id')
  
  try {
    const { replyId, gifKey, text, hashtags } = await c.req.json()
    
    // Validate text
    if (!text || text.length < 1 || text.length > 200) {
      return c.json({ error: 'Text must be 1-200 characters' }, 422)
    }
    
    // Validate hashtags
    if (!Array.isArray(hashtags) || hashtags.length > 5) {
      return c.json({ error: 'Maximum 5 hashtags allowed' }, 422)
    }
    
    for (const tag of hashtags) {
      if (typeof tag !== 'string' || tag.length > 20 || !/^[a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+$/u.test(tag)) {
        return c.json({ error: 'Hashtags must be alphanumeric, Japanese characters, and ≤20 chars' }, 422)
      }
    }

    // Extract mentions from text
    const mentionRegex = /@([a-zA-Z0-9_]{1,20})/g
    const mentionSet = new Set<string>()
    let mentionMatch
    while ((mentionMatch = mentionRegex.exec(text)) !== null) {
      mentionSet.add(mentionMatch[1])
    }
    const mentionedUsernames = Array.from(mentionSet)
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    // Validate parent still exists and is published
    const parentPost = await c.env.DB.prepare(
      'SELECT id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, COALESCE(reply_count, 0) as reply_count, parent_id, root_id, COALESCE(depth, 0) as depth, COALESCE(status, \'published\') as status, created_at FROM posts WHERE id = ? AND status = \'published\''
    ).bind(postId).first()
    
    if (!parentPost) {
      return c.json({ error: 'Parent post no longer available' }, 422)
    }
    
    let reply: any
    
    if (gifKey) {
      // Resolve mentions
      const replyUsername = c.get('user')?.username || 'anonymous'
      const mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, replyUsername)

      // Validate that this is a pending reply and gifKey matches
      const pendingReply = await c.env.DB.prepare(`
        SELECT * FROM posts WHERE id = ? AND status = 'pending' AND gif_key = ? AND parent_id = ?
      `).bind(replyId, gifKey, postId).first()
      
      if (!pendingReply) {
        return c.json({ error: 'Invalid or expired reply preparation' }, 422)
      }
      
      // Check if GIF exists in R2 (simplified check for now)
      const gifExists = true // Placeholder - implement actual R2 check
      
      if (!gifExists) {
        return c.json({ error: 'GIF not uploaded' }, 422)
      }
      
      // Update reply to published status
      const updateResult = await c.env.DB.prepare(`
        UPDATE posts 
        SET text = ?, hashtags = ?, mentions = ?, status = 'published', created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
      `).bind(text, JSON.stringify(hashtags), mentionsJson, replyId).run()
      
      if (!updateResult.success) {
        return c.json({ error: 'Failed to commit reply' }, 500)
      }
      
      // Return the updated reply
      reply = await c.env.DB.prepare(`
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?
      `).bind(replyId).first()
    } else {
      // Resolve mentions
      const replyUsername = c.get('user')?.username || 'anonymous'
      const mentionsJson = await resolveMentions(c.env.DB, mentionedUsernames, replyUsername)

      // Create text-only reply directly
      const depth = Math.min(Number(parentPost.depth || 0) + 1, 5)
      const rootId = parentPost.root_id || parentPost.id
      
      try {
        const result = await c.env.DB.prepare(`
          INSERT INTO posts (id, user_id, username, text, hashtags, mentions, gif_key, payload_key, swf_key, fresh_count, status, parent_id, root_id, depth, reply_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'published', ?, ?, ?, 0)
        `).bind(
          replyId, 
          c.get('user')?.id || '', 
          replyUsername, 
          text, 
          JSON.stringify(hashtags),
          mentionsJson,
          '',
          '',
          '',
          postId,
          rootId,
          depth
        ).run()
        
        if (!result.success) {
          console.error('Failed to create reply:', result.error)
          return c.json({ error: 'Failed to create reply' }, 500)
        }
        
        // Return the created reply
        reply = await c.env.DB.prepare(`
          SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?
        `).bind(replyId).first()
      } catch (dbError: any) {
        console.error('Database error creating reply:', dbError)
        console.error('Error details:', {
          message: dbError?.message,
          stack: dbError?.stack,
          cause: dbError?.cause,
          name: dbError?.name
        })
        return c.json({ error: 'Database error', details: dbError?.message || 'Unknown error' }, 500)
      }
    }
    
    // Increment parent's reply count
    const incrementResult = await c.env.DB.prepare(`
      UPDATE posts SET reply_count = COALESCE(reply_count, 0) + 1 WHERE id = ?
    `).bind(postId).run()
    
    if (!incrementResult.success) {
      console.error('Failed to increment reply count for post:', postId)
      // Don't fail the whole operation, just log the error
    }

    // Create notification for the parent post author (if not replying to own post)
    const notifiedUserIds = new Set<string>()
    const replyUserId = c.get('user')?.id || ''
    if (parentPost.user_id !== replyUserId) {
      try {
        // Group reply notifications: check for existing reply notification for this post
        const existingNotif = await c.env.DB.prepare(
          'SELECT id, actor_id, actor_data FROM notifications WHERE user_id = ? AND post_id = ? AND type = \'reply\' ORDER BY created_at DESC LIMIT 1'
        ).bind(parentPost.user_id, postId).first() as any

        if (existingNotif) {
          const actorData = existingNotif.actor_data
            ? JSON.parse(existingNotif.actor_data)
            : existingNotif.actor_id
              ? [existingNotif.actor_id]
              : []
          if (!actorData.includes(replyUserId)) {
            actorData.push(replyUserId)
          }
          await c.env.DB.prepare(
            'UPDATE notifications SET actor_id = ?, actor_data = ?, created_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\'), read = 0 WHERE id = ?'
          ).bind(actorData[0], JSON.stringify(actorData), existingNotif.id).run()
        } else {
          await c.env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)'
          ).bind(nanoid(), parentPost.user_id, 'reply', postId, replyUserId).run()
        }
        notifiedUserIds.add(parentPost.user_id)
      } catch (e) {
        console.error('Failed to create reply notification:', e)
        // Don't fail the whole operation, just log the error
      }
    }

    // Create mention notifications for mentioned users in the reply (skip self-mentions)
    if (mentionedUsernames.length > 0) {
      try {
        const mentionData = JSON.parse(mentionsJson) as Array<{username: string, user_id: string}>
        for (const mention of mentionData) {
          if (mention.user_id === replyUserId) continue
          await c.env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)'
          ).bind(nanoid(), mention.user_id, 'mention', replyId, replyUserId).run()
        }
      } catch (e) {
        // Don't fail the reply creation if mention notifications fail
        console.error('Failed to create mention notifications:', e)
      }
    }

    // Create notifications for >>N post references in the reply
    // Skip if the referenced post author was already notified (e.g., parent post author)
    try {
      const refRegex = />>(\d+)/g
      const referencedIndices = new Set<number>()
      let refMatch
      while ((refMatch = refRegex.exec(text)) !== null) {
        const index = parseInt(refMatch[1], 10)
        if (index > 0) referencedIndices.add(index)
      }

      if (referencedIndices.size > 0) {
        const rootId = parentPost.root_id || parentPost.id
        const allRepliesResult = await c.env.DB.prepare(
          'SELECT id, user_id, username FROM posts WHERE root_id = ? AND status = \'published\' AND id != ? ORDER BY created_at ASC'
        ).bind(rootId, rootId).all()

        const allReplies = allRepliesResult.results || []

        for (const refIndex of referencedIndices) {
          const arrayIndex = refIndex - 1
          if (arrayIndex >= 0 && arrayIndex < allReplies.length) {
            const referencedPost = allReplies[arrayIndex] as any
            // Increment reply_count for the referenced post (skip if it's the direct parent to avoid double-count)
            if (referencedPost.id !== postId) {
              await c.env.DB.prepare(
                'UPDATE posts SET reply_count = COALESCE(reply_count, 0) + 1 WHERE id = ?'
              ).bind(referencedPost.id).run()
            }
            if (referencedPost.user_id && referencedPost.user_id !== replyUserId && !notifiedUserIds.has(referencedPost.user_id)) {
              await c.env.DB.prepare(
                'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)'
              ).bind(nanoid(), referencedPost.user_id, 'reply', replyId, replyUserId).run()
            }
          }
        }
      }
    } catch (e) {
      console.error('Failed to create >>N reference notifications:', e)
    }

    return c.json({ reply })
  } catch (error: any) {
    console.error('Commit reply error:', error)
    console.error('Full error details:', {
      message: error?.message,
      stack: error?.stack,
      cause: error?.cause,
      name: error?.name,
      postId: postId || 'unknown',
      replyId: error?.replyId || 'unknown'
    })
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/search - search posts and users
app.get('/api/search', async (c) => {
  try {
    const query = c.req.query('q')
    const type = c.req.query('type') || 'posts'
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50)

    if (!query || query.trim().length === 0) {
      return c.json({ error: 'Search query required' }, 400)
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const tokens = query.trim().split(/\s+/).filter(Boolean)

    if (type === 'users') {
      const cleanQuery = query.trim().replace(/^@/, '')
      const searchTerm = `%${cleanQuery}%`
      const users = await c.env.DB.prepare(`
        SELECT id, username, display_name, bio, avatar_key, created_at
        FROM users
        WHERE username LIKE ? OR display_name LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `).bind(searchTerm, searchTerm, limit).all()

      return c.json({
        type: 'users',
        query,
        results: users.results || []
      })
    }

    // Build multi-term AND search for posts / arcade
    const conditions: string[] = []
    const params: any[] = []

    if (type === 'arcade') {
      conditions.push('((p.swf_key IS NOT NULL AND p.swf_key != \'\') OR (p.payload_key IS NOT NULL AND p.payload_key != \'\'))')
    }

    for (const token of tokens) {
      if (token.startsWith('#')) {
        const tag = token.slice(1).trim()
        if (tag) {
          conditions.push(`EXISTS (SELECT 1 FROM json_each(p.hashtags) WHERE value = ?)`)
          params.push(tag)
        }
      } else {
        conditions.push('LOWER(p.text) LIKE ?')
        params.push(`%${token.toLowerCase()}%`)
      }
    }

    const cleanQuery = query.trim().replace(/^@/, '')
    const searchTerm = `%${cleanQuery.toLowerCase()}%`

    let usersResult: any[] = []

    if (conditions.length === 0) {
      // No specific tokens, but still search users by the raw query
      if (type === 'posts') {
        const users = await c.env.DB.prepare(`
          SELECT username, display_name, avatar_key
          FROM users
          WHERE LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?
          ORDER BY created_at DESC LIMIT ?
        `).bind(searchTerm, searchTerm, limit).all()
        usersResult = (users.results || []).map((u: any) => ({
          username: u.username,
          display_name: u.display_name || '',
          avatar_key: u.avatar_key || ''
        }))
      }
      return c.json({ type, query, results: [], users: usersResult })
    }

    const whereClause = `WHERE p.status = 'published' AND p.hidden = 0 AND (${conditions.join(' AND ')})`

    const selectColumns = `
      SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
    `

    const posts = await c.env.DB.prepare(
      `${selectColumns} ${whereClause} ORDER BY p.created_at DESC LIMIT ?`
    ).bind(...params, limit).all()

    // Also fetch matching users for posts search (type=posts)
    if (type === 'posts') {
      const users = await c.env.DB.prepare(`
        SELECT username, display_name, avatar_key
        FROM users
        WHERE LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?
        ORDER BY created_at DESC LIMIT ?
      `).bind(searchTerm, searchTerm, limit).all()
      usersResult = (users.results || []).map((u: any) => ({
        username: u.username,
        display_name: u.display_name || '',
        avatar_key: u.avatar_key || ''
      }))
    }

    return c.json({
      type,
      query,
      results: posts.results || [],
      users: usersResult
    })
  } catch (error: any) {
    console.error('Search error:', error)
    return c.json({ error: 'Search failed', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/users/suggest?q=prefix - suggest usernames matching prefix
app.get('/api/users/suggest', async (c) => {
  try {
    const q = c.req.query('q')
    if (!q || q.length < 1) {
      return c.json({ users: [] })
    }

    const limit = Math.min(parseInt(c.req.query('limit') || '10', 10), 20)
    const prefix = q.toLowerCase()

    const result = await c.env.DB.prepare(`
      SELECT username, display_name, avatar_key
      FROM users
      WHERE LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?
      ORDER BY
        CASE WHEN LOWER(username) LIKE ? THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT ?
    `).bind(prefix + '%', prefix + '%', prefix + '%', limit).all()

    const users = (result.results || []).map((u: any) => ({
      username: u.username,
      display_name: u.display_name || '',
      avatar_key: u.avatar_key || ''
    }))

    return c.json({ users }, 200, {
      'Cache-Control': 'public, max-age=15'
    })
  } catch (error: any) {
    console.error('User suggest error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// DELETE /api/posts/:id - delete post (protected)
app.delete('/api/posts/:id', requireAuth, async (c) => {
  try {
    const postId = c.req.param('id')
    const userId = c.get('user')?.id || ''
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    // Get the post to verify ownership and get file keys
    const post = await c.env.DB.prepare(
      'SELECT id, user_id, username, parent_id, gif_key, payload_key, swf_key, thumbnail_key, status FROM posts WHERE id = ?'
    ).bind(postId).first() as { id: string; user_id: string; username: string; parent_id?: string; gif_key?: string; payload_key?: string; swf_key?: string; thumbnail_key?: string; status?: string } | null
    
    if (!post) {
      return c.json({ error: 'Post not found' }, 404)
    }
    
    // Verify ownership
    if (post.user_id !== userId) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    
    // Delete associated files from R2
    if (c.env.BUCKET) {
      if (post.gif_key) {
        try {
          await c.env.BUCKET.delete(post.gif_key)
        } catch (e) {
          console.error('Failed to delete gif file:', e)
        }
      }
      if (post.payload_key) {
        try {
          await c.env.BUCKET.delete(post.payload_key)
        } catch (e) {
          console.error('Failed to delete payload file:', e)
        }
      }
      if (post.swf_key) {
        try {
          await c.env.BUCKET.delete(post.swf_key)
        } catch (e) {
          console.error('Failed to delete SWF file:', e)
        }
      }
      if (post.thumbnail_key) {
        try {
          await c.env.BUCKET.delete(post.thumbnail_key)
        } catch (e) {
          console.error('Failed to delete thumbnail file:', e)
        }
      }
    }
    
    // Delete all replies (and their replies) to this post
    const deleteReplies = async (id: string) => {
      const replies = await c.env.DB.prepare('SELECT id FROM posts WHERE parent_id = ?').bind(id).all() as { results: { id: string }[] }
      for (const reply of replies.results) {
        await deleteReplies(reply.id)
        // Decrement parent's reply count before deleting the reply
        await c.env.DB.prepare('UPDATE posts SET reply_count = COALESCE(reply_count, 0) - 1 WHERE id = ?').bind(id).run()
        await c.env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(reply.id).run()
      }
    }
    await deleteReplies(postId)
    
    // Delete the post
    const result = await c.env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run()
    
    if (!result.success) {
      return c.json({ error: 'Failed to delete post' }, 500)
    }
    
    // Decrement parent's reply count if this post was a reply
    if (post.parent_id) {
      await c.env.DB.prepare('UPDATE posts SET reply_count = COALESCE(reply_count, 0) - 1 WHERE id = ?').bind(post.parent_id).run()
    }
    
    // Queue ActivityPub delete delivery for public posts
    if (post && post.status === 'published') {
      try {
        const user = c.get('user')
        if (user) {
          const noteId = `${c.env.BASE_URL}/notes/${postId}`
          const activity = buildDeleteActivity(noteId, user, c.env.BASE_URL)
          
          // Get all followers to deliver to
          const followers = await c.env.DB.prepare(`
            SELECT inbox_url FROM ap_followers WHERE local_user_id = ?
          `).bind(user.id).all()
          
          // Queue delivery to each follower
          for (const follower of followers.results) {
            const inboxUrl = follower.inbox_url
            if (inboxUrl) {
              await c.env.AP_DELIVERY_QUEUE.send({
                type: 'delivery',
                inboxUrl,
                activity,
                senderUsername: user.username
              })
            }
          }
        }
      } catch (deliveryError) {
        console.error('Failed to queue ActivityPub delete delivery:', deliveryError)
        // Don't fail the post deletion if delivery queuing fails
      }
    }
    
    // Invalidate cache entries related to the deleted post
    if (c.env.CACHE) {
      try {
        // Delete games cache entries (since deleted posts might be games)
        await c.env.CACHE.delete('games:recent:20:first')
        await c.env.CACHE.delete('games:trending:20:first')
        
        // Delete any other cache keys that might contain this post
        // Pattern: games:{trending|recent}:{limit}:{cursor}
        // We'll delete the most common ones
        const cacheKeysToDelete = [
          'games:recent:20:first',
          'games:trending:20:first',
          'games:recent:50:first',
          'games:trending:50:first'
        ]
        
        for (const key of cacheKeysToDelete) {
          await c.env.CACHE.delete(key)
        }
        
        console.log('Cache invalidated for deleted post:', postId)
      } catch (cacheError) {
        console.warn('Failed to invalidate cache for deleted post:', cacheError)
        // Don't fail the deletion if cache invalidation fails
      }
    }
    
    return c.json({ success: true })
  } catch (error: any) {
    console.error('Delete post error:', error)
    return c.json({ error: 'Failed to delete post', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/posts/:id - get single post
app.get('/api/posts/:id', async (c) => {
  try {
    const postId = c.req.param('id')

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const post = await c.env.DB.prepare(
      'SELECT * FROM posts WHERE id = ?'
    ).bind(postId).first() as any | null

    if (!post) {
      return c.json({ error: 'Not found' }, 404)
    }

    // Check if post is hidden - allow admin bypass
    if (post.hidden && !isAdmin(c.env as unknown as Bindings, c.get('user')?.username ?? '')) {
      return c.json({ error: 'Gone' }, 410)
    }

    // Fetch poll data if available
    const poll = await c.env.DB.prepare('SELECT * FROM polls WHERE post_id = ?').bind(postId).first() as any | null
    if (poll) {
      const { results: options } = await c.env.DB.prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY rowid').bind(poll.id).all()
      let userVote: string | null = null
      const currentUserId = c.get('user')?.id
      if (currentUserId) {
        const vote = await c.env.DB.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').bind(poll.id, currentUserId).first() as { option_id: string } | null
        if (vote) userVote = vote.option_id
      }
      post.poll = {
        id: poll.id,
        question: poll.question,
        multipleChoice: !!poll.multiple_choice,
        endsAt: poll.ends_at,
        options,
        userVote
      }
    }

    return c.json(post)
  } catch (error: any) {
    console.error('Get post error:', error)
    return c.json({ error: 'Failed to get post', details: error?.message || 'Unknown error' }, 500)
  }
})

// Helper function to get threshold for a category
function getThreshold(category: ReportCategory): number {
  const thresholds: Record<ReportCategory, number> = {
    spam: 1,
    harassment: 3,
    inappropriate: 3,
    misinformation: 3,
    other: 3,
    hate_speech: 3,
    copyright: 1,
    csam: 1,
    malware: 1,
    privacy: 3
  }
  return thresholds[category]
}

// Helper function to get priority for a category
function getPriority(category: ReportCategory): 'critical' | 'high' | 'normal' {
  if (category === 'csam' || category === 'malware') {
    return 'critical'
  }
  if (category === 'copyright') {
    return 'high'
  }
  return 'normal'
}

// Helper function to resolve mentioned usernames to {username, user_id} objects
async function resolveMentions(db: D1Database, mentionedUsernames: string[], currentUsername: string): Promise<string> {
  const mentionData: Array<{username: string, user_id: string}> = []
  for (const mentionedUsername of mentionedUsernames) {
    const user = await db.prepare(
      'SELECT id, username FROM users WHERE username = ? COLLATE NOCASE'
    ).bind(mentionedUsername).first() as { id: string, username: string } | null
    if (user) {
      mentionData.push({ username: user.username, user_id: user.id })
    }
  }
  return JSON.stringify(mentionData)
}

// Helper function to insert notification
async function insertNotification(db: D1Database, userId: string, type: 'fresh' | 'reported' | 'warned' | 'hidden', postId: string, actorId?: string) {
  const messages: Record<string, string> = {
    fresh: 'fresed your post',
    reported: 'reported your post',
    warned: 'Your post has been reported for {category}. It may be removed if it violates our ToS.',
    hidden: 'Your post has been removed due to a {category} report.'
  }
  await db.prepare(
    'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)'
  ).bind(nanoid(), userId, type, postId, actorId || null).run()
}

// Helper function to insert admin alert
async function insertAdminAlert(db: D1Database, postId: string, category: ReportCategory, priority: 'critical' | 'high' | 'normal') {
  const id = nanoid()
  const result = await db.prepare(
    'INSERT INTO alerts (id, post_id, category, priority, status) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, postId, category, priority, 'open').run()
  if (!result.success) {
    console.error('Failed to create admin alert')
  }
}

async function enrichPostsWithPolls(posts: any[], db: D1Database, currentUserId?: string | null): Promise<void> {
  if (posts.length === 0) return
  const postIds = posts.map(p => p.id)
  const placeholders = postIds.map(() => '?').join(',')
  const pollsResult = await db.prepare(
    `SELECT * FROM polls WHERE post_id IN (${placeholders})`
  ).bind(...postIds).all()

  if (!pollsResult.success || pollsResult.results.length === 0) return

  const pollMap = new Map<string, any>()
  for (const poll of pollsResult.results) {
    pollMap.set((poll as any).post_id, poll)
  }

  const pollIds = pollsResult.results.map((p: any) => p.id)
  const optPlaceholders = pollIds.map(() => '?').join(',')
  const optsResult = await db.prepare(
    `SELECT * FROM poll_options WHERE poll_id IN (${optPlaceholders}) ORDER BY rowid`
  ).bind(...pollIds).all()

  const optsByPoll = new Map<string, any[]>()
  if (optsResult.success) {
    for (const opt of optsResult.results) {
      const pid = (opt as any).poll_id
      if (!optsByPoll.has(pid)) optsByPoll.set(pid, [])
      optsByPoll.get(pid)!.push(opt)
    }
  }

  let userVotes = new Map<string, string>()
  if (currentUserId) {
    const votesResult = await db.prepare(
      `SELECT poll_id, option_id FROM poll_votes WHERE poll_id IN (${optPlaceholders}) AND user_id = ?`
    ).bind(...pollIds, currentUserId).all()
    if (votesResult.success) {
      for (const v of votesResult.results) {
        userVotes.set((v as any).poll_id, (v as any).option_id)
      }
    }
  }

  for (const post of posts) {
    const poll = pollMap.get(post.id)
    if (poll) {
      const now = new Date()
      const endsAt = poll.ends_at || null
      const expired = endsAt ? new Date(endsAt) <= now : false
      post.poll = {
        id: poll.id,
        question: poll.question,
        multipleChoice: !!poll.multiple_choice,
        endsAt,
        options: optsByPoll.get(poll.id) || [],
        userVote: userVotes.get(poll.id) || null,
        expired
      }

      if (expired && !poll.ended_notified) {
        try {
          await db.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)'
          ).bind(nanoid(), post.user_id, 'poll_ended', post.id, '').run()
          await db.prepare(
            'UPDATE polls SET ended_notified = 1 WHERE id = ?'
          ).bind(poll.id).run()
        } catch (e) {
          console.error('Failed to create poll ended notification:', e)
        }
      }
    }
  }
}

// POST /api/report - unified report endpoint (protected)
app.post('/api/report', requireAuth, async (c) => {
  let rl = { allowed: true, remaining: 0, resetIn: 0 }
  try {
    rl = await checkRateLimit(c.env.RATE_LIMIT, {
      key: `report:${c.get('user')?.id}`,
      limit: 10,
      windowSeconds: 60
    })
  } catch (kvError: any) {
    console.warn('Report rate limit check failed, proceeding anyway:', kvError.message)
  }
  if (!rl.allowed) return rateLimitResponse(c, rl.resetIn, 10)

  try {
    const userId = c.get('user')?.id || ''
    const username = c.get('user')?.username || ''
    const { post_id, category, dmca } = await c.req.json() as {
      post_id: string
      category: ReportCategory
      dmca?: {
        work_description: string
        reporter_email: string
        sworn: boolean
      }
    }

    // Validate category
    const validCategories: ReportCategory[] = ['spam', 'harassment', 'inappropriate', 'misinformation', 'other', 'hate_speech', 'copyright', 'csam', 'malware', 'privacy']
    if (!category || !validCategories.includes(category)) {
      return c.json({ error: 'Invalid category' }, 400)
    }

    // DMCA validation
    if (category === 'copyright') {
      if (!dmca) {
        return c.json({ error: 'DMCA information required for copyright reports' }, 400)
      }
      if (!dmca.sworn) {
        return c.json({ error: 'You must swear that this report is made in good faith' }, 400)
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(dmca.reporter_email)) {
        return c.json({ error: 'Invalid email format' }, 400)
      }
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Get the post
    const post = await c.env.DB.prepare(
      'SELECT id, user_id FROM posts WHERE id = ? AND hidden = 0'
    ).bind(post_id).first() as { id: string; user_id: string } | null

    if (!post) {
      return c.json({ error: 'Post not found' }, 404)
    }

    // Cannot report own post
    if (post.user_id === userId) {
      return c.json({ error: 'Cannot report own post' }, 403)
    }

    // Check for duplicate report
    const existingReport = await c.env.DB.prepare(
      'SELECT id FROM reports WHERE post_id = ? AND user_id = ?'
    ).bind(post_id, userId).first()

    if (existingReport) {
      return c.json({ error: 'Already reported' }, 409)
    }

    // Insert report with optional DMCA fields
    const reportId = nanoid()
    if (dmca && category === 'copyright') {
      await c.env.DB.prepare(
        'INSERT INTO reports (id, post_id, user_id, category, dmca_work_description, dmca_reporter_email, dmca_sworn, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(reportId, post_id, userId, category, dmca.work_description, dmca.reporter_email, dmca.sworn ? 1 : 0, 'pending').run()
    } else {
      await c.env.DB.prepare(
        'INSERT INTO reports (id, post_id, user_id, category, status) VALUES (?, ?, ?, ?, ?)'
      ).bind(reportId, post_id, userId, category, 'pending').run()
    }

    // Process based on category
    if (category === 'csam' || category === 'malware') {
      // Immediate hide - no threshold check
      await c.env.DB.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(post_id).run()
      await insertNotification(c.env.DB, post.user_id, 'hidden', post_id)
      await insertAdminAlert(c.env.DB, post_id, category, 'critical')
    } else {
      const threshold = getThreshold(category)
      const { count } = await c.env.DB
        .prepare('SELECT COUNT(*) as count FROM reports WHERE post_id = ? AND category = ?')
        .bind(post_id, category)
        .first() as { count: number }

      if (count >= threshold) {
        await c.env.DB.prepare('UPDATE reports SET status = ? WHERE post_id = ?').bind('warned', post_id).run()
        await insertNotification(c.env.DB, post.user_id, 'warned', post_id)
        
        // Also hide the post and send hidden notification when threshold is reached
        await c.env.DB.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(post_id).run()
        await insertNotification(c.env.DB, post.user_id, 'hidden', post_id)
        
        const priority = getPriority(category)
        await insertAdminAlert(c.env.DB, post_id, category, priority)
      }
    }

    return c.json({ success: true, report_id: reportId })
  } catch (error: any) {
    console.error('Report error:', error)
    return c.json({ error: 'Failed to report post', details: error?.message || 'Unknown error' }, 500)
  }
})

// Admin middleware helper
const requireAdmin = async (c: any, next: any) => {
  const username = c.get('user')?.username
  if (!username || !isAdmin(c.env, username)) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await next()
}

// GET /api/admin/alerts - get unresolved admin alerts (admin only)
app.get('/api/admin/alerts', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const result = await c.env.DB.prepare(`
      SELECT id, post_id, category, priority, resolved, created_at
      FROM admin_alerts
      WHERE resolved = 0
      ORDER BY CASE priority
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'normal' THEN 3
      END, created_at DESC
    `).all()

    return c.json({ alerts: result.results || [] })
  } catch (error: any) {
    console.error('Fetch admin alerts error:', error)
    return c.json({ error: 'Failed to fetch alerts', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/admin/alerts/:id/resolve - mark alert as resolved (admin only)
app.post('/api/admin/alerts/:id/resolve', requireAuth, requireAdmin, async (c) => {
  try {
    const alertId = c.req.param('id')

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    await c.env.DB.prepare('UPDATE admin_alerts SET resolved = 1 WHERE id = ?').bind(alertId).run()

    return c.json({ success: true })
  } catch (error: any) {
    console.error('Resolve alert error:', error)
    return c.json({ error: 'Failed to resolve alert', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/admin/posts/:id/hide - manually hide a post (admin only)
app.post('/api/admin/posts/:id/hide', requireAuth, requireAdmin, async (c) => {
  try {
    const postId = c.req.param('id')

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const post = await c.env.DB.prepare('SELECT id, user_id FROM posts WHERE id = ?').bind(postId).first()

    if (!post) {
      return c.json({ error: 'Post not found' }, 404)
    }

    await c.env.DB.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(postId).run()

    return c.json({ success: true })
  } catch (error: any) {
    console.error('Hide post error:', error)
    return c.json({ error: 'Failed to hide post', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/admin/posts/:id/unhide - restore a hidden post (admin only)
app.post('/api/admin/posts/:id/unhide', requireAuth, requireAdmin, async (c) => {
  try {
    const postId = c.req.param('id')

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const post = await c.env.DB.prepare('SELECT id, user_id FROM posts WHERE id = ?').bind(postId).first()

    if (!post) {
      return c.json({ error: 'Post not found' }, 404)
    }

    await c.env.DB.prepare('UPDATE posts SET hidden = 0 WHERE id = ?').bind(postId).run()

    return c.json({ success: true })
  } catch (error: any) {
    console.error('Unhide post error:', error)
    return c.json({ error: 'Failed to unhide post', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/admin/posts/hidden - get hidden posts (admin only)
app.get('/api/admin/posts/hidden', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const result = await c.env.DB.prepare(`
      SELECT posts.*, users.username, users.display_name
      FROM posts
      JOIN users ON posts.user_id = users.id
      WHERE posts.hidden = 1
      ORDER BY posts.created_at DESC
    `).all()

    return c.json({ posts: result.results || [] })
  } catch (error: any) {
    console.error('Fetch hidden posts error:', error)
    return c.json({ error: 'Failed to fetch hidden posts', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/admin/users - get all users (admin only)
app.get('/api/admin/users', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const result = await c.env.DB.prepare(`
      SELECT id, username, display_name, email, created_at
      FROM users
      ORDER BY created_at DESC
    `).all()

    return c.json({ users: result.results || [] })
  } catch (error: any) {
    console.error('Fetch users error:', error)
    return c.json({ error: 'Failed to fetch users', details: error?.message || 'Unknown error' }, 500)
  }
})

// DELETE /api/admin/users/:id - delete a user account (admin only)
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (c) => {
  try {
    const targetUserId = c.req.param('id')
    const adminUsername = c.get('user')?.username

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Get the target user
    const targetUser = await c.env.DB.prepare(
      'SELECT id, username FROM users WHERE id = ?'
    ).bind(targetUserId).first() as { id: string; username: string } | null

    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404)
    }

    // Check if trying to delete an admin
    if (isAdmin(c.env as unknown as Bindings, targetUser.username)) {
      return c.json({ error: 'Cannot delete admin accounts' }, 403)
    }

    // Delete the user (posts remain with user_id intact)
    const result = await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetUserId).run()

    if (!result.success) {
      return c.json({ error: 'Failed to delete account' }, 500)
    }

    // Invalidate all sessions for this user (simplified - in production, use session table)
    // For now, we just delete the user row

    return c.json({ success: true })
  } catch (error: any) {
    console.error('Delete user error:', error)
    return c.json({ error: 'Failed to delete user', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/notifications - fetch notifications (protected)
app.get('/api/notifications', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || ''
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    // Get notifications with post and actor info (optimized: LIMIT first, then JOIN)
    const result = await c.env.DB.prepare(`
      SELECT 
        n.id,
        n.type,
        n.post_id,
        n.read,
        n.created_at,
        n.actor_id,
        n.actor_data,
        SUBSTR(p.text, 1, 50) as post_text_preview,
        u.username as actor_username,
        u.display_name as actor_display_name,
        u.avatar_key as actor_avatar_key
      FROM (
        SELECT * FROM notifications 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT 20
      ) n
      LEFT JOIN posts p ON n.post_id = p.id
      LEFT JOIN users u ON n.actor_id = u.id
    `).bind(userId).all()
    
    if (!result.success) {
      return c.json({ error: 'Failed to fetch notifications' }, 500)
    }
    
    // Get unread count
    const unreadResult = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0'
    ).bind(userId).first() as { count: number }
    
    // Format notifications
    const rows = (result.results || [])
    
    // Collect all actor IDs from actor_data for grouped fresh notifications
    const allActorIds = new Set<string>()
    for (const row of rows) {
      if (row.type === 'fresh' && row.actor_data) {
        try {
          const ids = JSON.parse(row.actor_data)
          if (Array.isArray(ids)) ids.forEach((id: string) => allActorIds.add(id))
        } catch {}
      }
    }
    
    // Fetch user info for all grouped actors
    const actorUserMap = new Map<string, any>()
    if (allActorIds.size > 0) {
      const userRows = await c.env.DB.prepare(`
        SELECT id, username, display_name, avatar_key FROM users WHERE id IN (${Array.from(allActorIds).map(() => '?').join(',')})
      `).bind(...Array.from(allActorIds)).all()
      for (const u of (userRows.results || [])) {
        actorUserMap.set(u.id, u)
      }
    }
    
    const notifications = rows.map((row: any) => {
      const notif: any = {
        id: row.id,
        type: row.type,
        post_id: row.post_id,
        post_text_preview: row.post_text_preview,
        actor: row.actor_username ? {
          username: row.actor_username,
          display_name: row.actor_display_name,
          avatar_key: row.actor_avatar_key
        } : undefined,
        actor_id: row.actor_id,
        actor_data: row.actor_data,
        read: row.read === 1,
        created_at: row.created_at
      }
      
      // For fresh notifications with grouped actors, include all actors
      if (row.type === 'fresh' && row.actor_data) {
        try {
          const ids = JSON.parse(row.actor_data)
          if (Array.isArray(ids) && ids.length > 1) {
            notif.actors = ids.map((id: string) => {
              const u = actorUserMap.get(id)
              return u ? { username: u.username, display_name: u.display_name, avatar_key: u.avatar_key } : null
            }).filter(Boolean)
          }
        } catch {}
      }
      
      return notif
    })
    
    return c.json({
      notifications,
      unread_count: unreadResult?.count || 0
    })
  } catch (error: any) {
    console.error('Fetch notifications error:', error)
    return c.json({ error: 'Failed to fetch notifications', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/notifications/read-all - mark all notifications as read (protected)
app.post('/api/notifications/read-all', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || ''
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    await c.env.DB.prepare(
      'UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0'
    ).bind(userId).run()
    
    return c.json({ success: true })
  } catch (error: any) {
    console.error('Mark all read error:', error)
    return c.json({ error: 'Failed to mark notifications as read', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/test/reset - reset database for testing (only allowed in test environment)
app.post('/api/test/reset', async (c) => {
  // Allow reset if we're using the test database binding or BASE_URL is localhost
  const isTestEnvironment = c.env.BASE_URL === 'http://localhost:8788' || 
                           c.req.url.includes('localhost:8788')
  
  if (!isTestEnvironment) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  
  // Use DB_TEST if available, otherwise fall back to DB
  const db = c.env.DB_TEST || c.env.DB
  
  await db.batch([
    db.prepare('DELETE FROM notifications'),
    db.prepare('DELETE FROM reports'),
    db.prepare('DELETE FROM freshs'),
    db.prepare('DELETE FROM follows'),
    db.prepare('DELETE FROM posts'),
    db.prepare('DELETE FROM users'),
  ])
  return c.json({ ok: true })
})

// Get current topic - randomly selected Flash/HTML post
app.get('/api/current-topic', async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Get a random Flash/HTML post
    // Use a seed based on current hour to keep the same post for 1 hour
    const currentHour = new Date().getHours()
    const result = await c.env.DB.prepare(`
      SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.created_at,
             u.display_name, u.avatar_key,
             (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count,
             COALESCE(p.impressions, 0) as impressions,
             p.fresh_count, COALESCE(p.bookmark_count, 0) as bookmark_count
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE (p.swf_key IS NOT NULL OR p.payload_key IS NOT NULL)
        AND p.status = 'published'
        AND p.hidden = 0
        AND p.parent_id IS NULL
      ORDER BY RANDOM()
      LIMIT 1
    `).first()

    if (!result) {
      return c.json({ error: 'No Flash/HTML posts found' }, 404)
    }

    let hashtags = []
    try {
      hashtags = result.hashtags ? (typeof result.hashtags === 'string' ? JSON.parse(result.hashtags) : result.hashtags) : []
    } catch (error) {
      console.warn('Failed to parse hashtags:', error)
      hashtags = []
    }

    const topicPost = {
      id: result.id,
      user_id: result.user_id,
      username: result.username,
      display_name: result.display_name,
      avatar_key: result.avatar_key,
      text: result.text,
      hashtags,
      gif_key: result.gif_key,
      payload_key: result.payload_key,
      swf_key: result.swf_key,
      thumbnail_key: result.thumbnail_key,
      fresh_count: result.fresh_count,
      reply_count: result.reply_count,
      impressions: result.impressions,
      created_at: result.created_at,
      type: result.swf_key ? 'flash' : ((result as any).payload_key && (result as any).payload_key.startsWith('dos/') ? 'dos' : 'html')
    }

    return c.json(topicPost)
  } catch (error: any) {
    console.error('Current topic fetch error:', error)
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
})

// Export for Cloudflare Pages Functions
export async function onRequest(context: any) {
  return app.fetch(context.request, context.env, context)
}
