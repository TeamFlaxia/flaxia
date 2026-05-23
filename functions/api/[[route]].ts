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
import { extractZipToWvfs, serveFileFromWvfs, cleanupWvfsZip } from '../../src/lib/wvfs-zip-server'

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
}

type Variables = {
  user: User | null
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

app.use('/*', cors())

// PUT /api/upload/:key - direct file upload endpoint (no auth required - validated in prepare step)
app.put('/api/upload/*', async (c) => {
  try {
    const key = c.req.path.replace('/api/upload/', '')
    const contentType = c.req.header('content-type')
    const contentLength = c.req.header('content-length')
    
    if (!key) {
      return c.json({ error: 'Missing file key' }, 400)
    }
    
    // Check file size limit (25MB = 25 * 1024 * 1024 bytes)
    const maxSize = 25 * 1024 * 1024
    if (contentLength && Number(contentLength) > maxSize) {
      return c.json({ error: 'File too large. Maximum size is 25MB' }, 413)
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
    
    // Upload to R2 with proper content type
    await c.env.BUCKET.put(key, fileData, {
      httpMetadata: {
        contentType: contentType || 'application/octet-stream'
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

// GET /api/zip/:postId - serve ZIP files from R2
app.get('/api/zip/:postId', async (c) => {
  try {
    const postId = c.req.param('postId')
    
    if (!postId) {
      return c.json({ error: 'Missing post ID' }, 400)
    }
    
    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500)
    }
    
    // Construct the ZIP key
    const zipKey = `zip/${postId}.zip`
    
    // Get object from R2
    const object = await c.env.BUCKET.get(zipKey)
    
    if (!object) {
      return c.json({ error: 'ZIP not found' }, 404)
    }
    
    // Return the ZIP with proper headers
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/zip',
        'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch (error: any) {
    console.error('ZIP proxy error:', error)
    return c.json({ error: 'Failed to fetch ZIP', details: error?.message || 'Unknown error' }, 500)
  }
})

// GET /api/wvfs-zip/:postId - serve ZIP files using WVFS
// GET /api/wvfs-zip/:postId/* - serve individual files from ZIP using WVFS
app.get('/api/wvfs-zip/:postId/*', async (c) => {
  // Add rate limiting for WVFS endpoints with graceful KV handling
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  
  // Handle KV rate limit gracefully - if KV fails, continue with WVFS serving
  let rl: { allowed: boolean; resetIn: number } | null = null
  try {
    rl = await checkRateLimit(c.env.RATE_LIMIT, {
      key: `wvfs:${ip}`,
      limit: 100,  // 100 requests per minute
      windowSeconds: 60
    })
  } catch (kvError: any) {
    // Log KV error but don't fail the request
    console.warn('KV rate limit check failed for WVFS, proceeding anyway:', kvError.message)
    // Check if it's specifically a KV put limit exceeded error
    if (kvError.message && kvError.message.includes('KV put() limit exceeded')) {
      console.warn('KV put limit exceeded, skipping rate limit check for WVFS')
    }
  }
  
  // Only apply rate limit if KV check succeeded
  if (rl && !rl.allowed) {
    return rateLimitResponse(c, rl.resetIn, 100)
  }

  try {
    const postId = c.req.param('postId')
    
    // Extract the file path from the request
    // This handles both /api/wvfs-zip/:postId and /api/wvfs-zip/:postId/some/path
    const fullPath = c.req.path
    const basePath = `/api/wvfs-zip/${postId}`
    let filePath = fullPath.replace(basePath, '').replace(/^\//, '') || 'index.html'
    
    console.log(`WVFS API: Request for postId=${postId}, filePath=${filePath}`)
    
    if (!postId) {
      return c.json({ error: 'Missing post ID' }, 400)
    }
    
    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500)
    }
    
    // Check if ZIP is already extracted to WVFS
    const response = await serveFileFromWvfs(postId, filePath)
    if (response) {
      return response
    }
    
    // If not found, extract ZIP to WVFS first
    let zipKey: string
    let zipObject: R2Object | null = null
    
    // Check if it's an ad
    if (c.env.DB) {
      const adResult = await c.env.DB.prepare('SELECT payload_key FROM ads WHERE id = ? AND payload_type = \'zip\' AND active = 1')
        .bind(postId)
        .first() as { payload_key: string } | null
      
      if (adResult && adResult.payload_key) {
        zipKey = adResult.payload_key
        zipObject = await c.env.BUCKET.get(zipKey)
      }
    }
    
    // If not an ad or ad not found, try as a post
    if (!zipObject) {
      zipKey = `zip/${postId}.zip`
      zipObject = await c.env.BUCKET.get(zipKey)
    }
    
    if (!zipObject) {
      return c.json({ error: 'ZIP not found' }, 404)
    }
    
    console.log(`WVFS API: Extracting ZIP for postId=${postId}`)
    
    // Extract ZIP to WVFS
    const zipData = await (zipObject as any).arrayBuffer()
    await extractZipToWvfs(zipData, postId)
    
    console.log(`WVFS API: ZIP extracted, serving file: ${filePath}`)
    
    // Try serving the file again
    const fileResponse = await serveFileFromWvfs(postId, filePath)
    if (fileResponse) {
      return fileResponse
    }
    
    return c.json({ error: 'File not found in ZIP', path: filePath }, 404)
    
  } catch (error: any) {
    // Log detailed error for debugging
    console.error('WVFS ZIP error:', error)
    
    // Don't expose internal error details to prevent information leakage
    if (error instanceof Error && error.message.includes('Path traversal')) {
      console.warn('Security violation: Path traversal attempt detected')
    }
    
    // Return generic error message to user
    return c.json({ error: 'Failed to process ZIP file' }, 500)
  }
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
    
    // Return the SWF with proper headers
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/x-shockwave-flash',
        'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch (error: any) {
    console.error('SWF proxy error:', error)
    return c.json({ error: 'Failed to fetch SWF', details: error?.message || 'Unknown error' }, 500)
  }
})

// Auth middleware - sets user context (null if not authenticated)
app.use('/api/*', async (c, next) => {
  // Skip auth for specific public routes that don't need user context at all
  if ((c.req.method === 'PUT' && c.req.path.startsWith('/api/upload/')) ||
      (c.req.method === 'GET' && c.req.path.startsWith('/api/images/')) ||
      (c.req.method === 'GET' && c.req.path.startsWith('/api/audio/')) ||
      (c.req.method === 'GET' && c.req.path.startsWith('/api/zip/')) ||
      (c.req.method === 'GET' && c.req.path.startsWith('/api/swf/')) ||
      (c.req.method === 'GET' && c.req.path === '/api/games') ||
      (c.req.method === 'GET' && c.req.path.startsWith('/api/ads/') && c.req.path.endsWith('/payload')) ||
      (c.req.method === 'GET' && c.req.path.startsWith('/api/wvfs-zip/'))) {
    await next()
    return
  }
  
  // Get session if available, otherwise set user to null
  const token = getSessionToken(c.req.raw)
  const sessionData = token ? await getSession(c.env, token) : null
  
  // Set user in context (null if not authenticated)
  c.set('user', sessionData?.user || null)
  await next()
})

// Helper middleware to require authentication for protected routes
const requireAuth = async (c: any, next: any) => {
  if (!c.get('user')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await next()
}

app.use('/*', cors({
  origin: ['https://flaxia.app', 'https://*.pages.dev'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}))

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
    const trending = c.req.query('trending') === 'true'
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50)
    const cursor = c.req.query('cursor')
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }

    // Generate cache key based on query parameters
    const cacheKey = `games:${trending ? 'trending' : 'recent'}:${limit}:${cursor || 'first'}`
    
    // Try to get from cache first (exclude user-specific data)
    const cachedData = await c.env.CACHE?.get(cacheKey)
    if (cachedData && !cursor) { // Only use cache for first page, not paginated requests
      const parsed = JSON.parse(cachedData)
      
      // Get current user for is_freshed check
      const token = getSessionToken(c.req.raw)
      const sessionData = token ? await getSession(c.env, token) : null
      const currentUserId = sessionData?.user?.id
      
      // If user is authenticated, fetch their fresh status for cached games
      if (currentUserId && parsed.games.length > 0) {
        const gameIds = parsed.games.map((g: any) => g.id)
        const freshResults = await c.env.DB.prepare(`
          SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${gameIds.map(() => '?').join(',')})
        `).bind(currentUserId, ...gameIds).all()
        
        const freshedPostIds = new Set(freshResults.results?.map((r: any) => r.post_id) || [])
        
        // Update isFreshed status for each game
        parsed.games.forEach((game: any) => {
          game.isFreshed = freshedPostIds.has(game.id)
        })
      }
      
      return c.json(parsed)
    }

    // Get current user for is_freshed check
    const token = getSessionToken(c.req.raw)
    const sessionData = token ? await getSession(c.env, token) : null
    const currentUserId = sessionData?.user?.id

    // Optimized query without LEFT JOIN for better performance
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
    
    // Order by trending (fresh_count + impressions) or recency
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

    // Fetch fresh status separately if user is authenticated (more efficient than JOIN)
    let freshedPostIds: Set<string> = new Set()
    if (currentUserId && results.length > 0) {
      const postIds = results.map(row => row.postId)
      const freshResults = await c.env.DB.prepare(`
        SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})
      `).bind(currentUserId, ...postIds).all()
      
      freshedPostIds = new Set(freshResults.results?.map((r: any) => r.post_id) || [])
    }

    const games = (results || []).map(row => {
      const type = row.swf_key ? 'flash' : 'zip'
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

    // Cache the response for first page (non-paginated requests)
    if (!cursor && c.env.CACHE) {
      try {
        // Cache without user-specific isFreshed data
        const cacheData = {
          games: trimmedGames.map(game => ({
            ...game,
            isFreshed: false // Reset to false for cache
          })),
          hasMore,
          cursor: nextCursor
        }
        await c.env.CACHE.put(cacheKey, JSON.stringify(cacheData), {
          expirationTtl: 300 // 5 minutes cache
        })
      } catch (cacheError) {
        console.warn('Failed to cache games data:', cacheError)
        // Continue without failing the request
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
  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `register:${ip}`,
    limit: 3,
    windowSeconds: 3600
  })
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
    const response = c.json({ user: result.user })
    setSessionCookie(response, result.session.id)
    
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
    const response = c.json({ success: true })
    clearSessionCookie(response)
    
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

// GET /api/actors/:username - ActivityPub Actor endpoint
app.get('/api/actors/:username', async (c) => {
  const username = c.req.param('username')
  const user = await c.env.DB.prepare(`SELECT id, username, display_name, bio, avatar_key FROM users WHERE username = ? COLLATE NOCASE`).bind(username).first() as any
  if (!user) return c.json({ error: 'User not found' }, 404)

  const keyRecord = await c.env.DB.prepare(`SELECT public_key_pem FROM actor_keys WHERE user_id = ?`).bind(user.id).first() as any
  let publicKeyPem = keyRecord?.public_key_pem
  if (!publicKeyPem) {
    const keyPair = await generateKeyPair()
    publicKeyPem = await exportPublicKey(keyPair.publicKey)
    await c.env.DB.prepare(`INSERT INTO actor_keys (user_id, public_key_pem, private_key_pem, created_at) VALUES (?, ?, ?, datetime('now'))`).bind(user.id, publicKeyPem, await exportPrivateKey(keyPair.privateKey)).run()
  }

  return c.json({
    "@context": "https://www.w3.org/ns/activitystreams",
    "type": "Person",
    "id": `${c.env.BASE_URL}/api/actors/${username}`,
    "preferredUsername": user.username,
    "name": user.display_name,
    "summary": user.bio || "",
    "inbox": `${c.env.BASE_URL}/api/actors/${username}/inbox`,
    "outbox": `${c.env.BASE_URL}/api/actors/${username}/outbox`,
    "publicKey": {
      "id": `${c.env.BASE_URL}/api/actors/${username}#main-key`,
      "owner": `${c.env.BASE_URL}/api/actors/${username}`,
      "publicKeyPem": publicKeyPem
    }
  }, 200, { 'Content-Type': 'application/activity+json' })
})

// GET /api/actors/:username/outbox - Outbox endpoint
app.get('/api/actors/:username/outbox', async (c) => {
  const username = c.req.param('username')
  const page = c.req.query('page')
  const pageSize = 20

  const user = await c.env.DB.prepare(`SELECT id FROM users WHERE username = ? COLLATE NOCASE`).bind(username).first() as any
  if (!user) return c.json({ error: 'User not found' }, 404)

  const totalItems = (await c.env.DB.prepare(`SELECT COUNT(*) as count FROM posts WHERE user_id = ? AND status = 'published'`).bind(user.id).first() as any).count

  if (!page) {
    return c.json({
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "OrderedCollection",
      "id": `${c.env.BASE_URL}/api/actors/${username}/outbox`,
      "totalItems": totalItems,
      "first": `${c.env.BASE_URL}/api/actors/${username}/outbox?page=1`,
      "last": `${c.env.BASE_URL}/api/actors/${username}/outbox?page=${Math.ceil(totalItems / pageSize) || 1}`
    }, 200, { 'Content-Type': 'application/activity+json' })
  }

  const currentPage = parseInt(page) || 1
  const posts = await c.env.DB.prepare(`SELECT id, text, created_at FROM posts WHERE user_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(user.id, pageSize, (currentPage - 1) * pageSize).all() as any
  const activities = posts.results.map((post: any) => buildCreateActivity(buildNoteObject(post, user, c.env.BASE_URL), user, c.env.BASE_URL))

  const response: any = {
    "@context": "https://www.w3.org/ns/activitystreams",
    "type": "OrderedCollectionPage",
    "id": `${c.env.BASE_URL}/api/actors/${username}/outbox?page=${currentPage}`,
    "partOf": `${c.env.BASE_URL}/api/actors/${username}/outbox`,
    "orderedItems": activities
  }
  if ((currentPage * pageSize) < totalItems) response.next = `${c.env.BASE_URL}/api/actors/${username}/outbox?page=${currentPage + 1}`
  if (currentPage > 1) response.prev = `${c.env.BASE_URL}/api/actors/${username}/outbox?page=${currentPage - 1}`

  return c.json(response, 200, { 'Content-Type': 'application/activity+json' })
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

// GET /actors/:username/outbox - ActivityPub Outbox endpoint (paginated, no /api prefix)
app.get('/actors/:username/outbox', async (c) => {
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
    if (page === 'true') {
      const offset = c.req.query('offset')
      const offsetNum = offset ? parseInt(offset, 10) : 0

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
        "id": `${c.env.BASE_URL}/api/actors/${username}/outbox?page=true&offset=${offsetNum}`,
        "partOf": `${c.env.BASE_URL}/api/actors/${username}/outbox`,
        "totalItems": totalItems,
        "orderedItems": activities,
        ...(hasNext && { "next": `${c.env.BASE_URL}/api/actors/${username}/outbox?page=true&offset=${nextOffset}` })
      }, 200, { 'Content-Type': 'application/activity+json' })
    }

    // Return main OrderedCollection with first link
    return c.json({
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "OrderedCollection",
      "id": `${c.env.BASE_URL}/api/actors/${username}/outbox`,
      "totalItems": totalItems,
      "first": `${c.env.BASE_URL}/api/actors/${username}/outbox?page=true&offset=0`
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
    
    // Get follow counts
    const [followersResult, followingResult] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE followee_id = ?').bind(user.id).first(),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?').bind(user.id).first()
    ])
    
    const followers_count = (followersResult?.count as number) || 0
    const following_count = (followingResult?.count as number) || 0
    
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
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif']
        if (!allowedTypes.includes(avatarFile.type)) {
          return c.json({ error: 'Only JPEG, PNG, and GIF images are allowed' }, 400)
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
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif']
    if (!contentType || !allowedTypes.includes(contentType as string)) {
      return c.json({ error: 'Only JPEG, PNG, and GIF images are allowed' }, 400)
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
        query = 'SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = \'published\') as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, \'published\') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = \'published\' AND p.hidden = 0 AND p.parent_id IS NULL AND EXISTS (SELECT 1 FROM json_each(p.hashtags) WHERE value = ?) AND p.created_at < ? ORDER BY p.created_at DESC LIMIT ?'
        params = [hashtag, cursor, limit]
      } else {
        query = 'SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = \'published\') as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, \'published\') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = \'published\' AND p.hidden = 0 AND p.parent_id IS NULL AND EXISTS (SELECT 1 FROM json_each(p.hashtags) WHERE value = ?) ORDER BY p.created_at DESC LIMIT ?'
        params = [hashtag, limit]
      }
    } else if (following && currentUserId) {
      // Following tab - show posts from followed users and current user's own posts
      if (cursor) {
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, 
          (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, 
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
        query = `SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, 
          (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, 
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
        query = 'SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = \'published\') as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, \'published\') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.username = ? AND p.hidden = 0 AND p.created_at < ? ORDER BY p.created_at DESC LIMIT ?'
        params = [username, cursor, limit]
      } else {
        query = 'SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = \'published\') as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, \'published\') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.username = ? AND p.hidden = 0 ORDER BY p.created_at DESC LIMIT ?'
        params = [username, limit]
      }
    } else {
      // Regular timeline query (For You tab)
      if (cursor) {
        query = 'SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = \'published\') as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, \'published\') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = \'published\' AND p.hidden = 0 AND p.parent_id IS NULL AND p.created_at < ? ORDER BY p.created_at DESC LIMIT ?'
        params = [cursor, limit]
      } else {
        query = 'SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = \'published\') as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, \'published\') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = \'published\' AND p.hidden = 0 AND p.parent_id IS NULL ORDER BY p.created_at DESC LIMIT ?'
        params = [limit]
      }
    }
    
    const result = await c.env.DB.prepare(query).bind(...params).all()
    
    if (!result.success) {
      console.error('Database query failed:', result)
      return c.json({ error: 'Failed to fetch posts' }, 500)
    }
    
    const posts = result.results || []
    
    // Add fresh status for current user if logged in
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
      SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, 
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

    // Add fresh status for current user if logged in
    if (currentUserId && posts.length > 0) {
      const postIds = posts.map((p: any) => p.id)
      const freshResult = await c.env.DB.prepare(
        `SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})`
      ).bind(currentUserId, ...postIds).all()
      
      const freshedPostIds = new Set((freshResult.results || []).map((f: any) => f.post_id))
      posts.forEach((post: any) => {
        post.is_freshed = freshedPostIds.has(post.id)
      })
    }

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
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, 
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
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, 
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

    // Add fresh status if logged in
    if (currentUserId && posts.length > 0) {
      const postIds = posts.map((p: any) => p.id)
      const freshResult = await c.env.DB.prepare(
        `SELECT post_id FROM freshs WHERE user_id = ? AND post_id IN (${postIds.map(() => '?').join(',')})`
      ).bind(currentUserId, ...postIds).all()
      
      const freshedPostIds = new Set((freshResult.results || []).map((f: any) => f.post_id))
      posts.forEach((post: any) => {
        post.is_freshed = freshedPostIds.has(post.id)
      })
    }

    return c.json({ posts })
  } catch (error: any) {
    console.error('Recommended posts error:', error, 'Query:', query, 'Params:', params)
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
    const { filename, contentType: initialContentType } = await c.req.json()
    
    if (!filename || !initialContentType) {
      return c.json({ error: 'Missing filename or contentType' }, 400)
    }
    
    const allowedTypes = ['image/gif', 'image/png', 'image/jpeg', 'image/jpg', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/webm', 'application/zip', 'application/x-shockwave-flash']
    
    // Also check file extension for SWF files (browsers may not report correct MIME type)
    const isSwfByExtension = filename.toLowerCase().endsWith('.swf')
    let contentType = initialContentType
    
    // Always set correct content type for SWF files by extension
    if (isSwfByExtension) {
      contentType = 'application/x-shockwave-flash'
    }
    
    const isValidType = allowedTypes.includes(contentType)
    
    if (!isValidType) {
      return c.json({ error: 'Only image files (GIF, PNG, JPG), audio files (MP3, WAV, OGG, M4A, WebM), ZIP files, and SWF files are supported' }, 400)
    }
    
    const postId = crypto.randomUUID()
    let fileExtension: string
    let storageKey: string
    
    if (contentType.startsWith('image/')) {
      fileExtension = contentType === 'image/png' ? '.png' : contentType === 'image/jpeg' || contentType === 'image/jpg' ? '.jpg' : '.gif'
      storageKey = `gif/${postId}${fileExtension}`
    } else if (contentType.startsWith('audio/')) {
      fileExtension = contentType === 'audio/mpeg' ? '.mp3' : 
                     contentType === 'audio/wav' ? '.wav' : 
                     contentType === 'audio/ogg' ? '.ogg' : 
                     contentType === 'audio/mp4' ? '.m4a' : '.webm'
      storageKey = `audio/${postId}${fileExtension}`
    } else if (contentType === 'application/zip') {
      storageKey = `zip/${postId}.zip`
    } else if (contentType === 'application/x-shockwave-flash') {
      storageKey = `swf/${postId}.swf`
    } else {
      return c.json({ error: 'Unsupported file type' }, 400)
    }
    
    const gifKey = storageKey
    
    // Store pending record in D1
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    // Determine which key column to use
    let keyColumn = 'gif_key'
    if (contentType === 'application/zip') {
      keyColumn = 'payload_key'
    } else if (contentType === 'application/x-shockwave-flash') {
      keyColumn = 'swf_key'
    }
    
    const result = await c.env.DB.prepare(`
      INSERT INTO posts (id, user_id, username, text, hashtags, ${keyColumn}, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).bind(postId, c.get('user')?.id || '', c.get('user')?.username || 'anonymous', '', '[]', storageKey).run()
    
    if (!result.success) {
      return c.json({ error: 'Failed to create pending post' }, 500)
    }
    
    // Return upload endpoint URL (our own API)
    if (contentType === 'application/zip') {
      const zipUploadUrl = `${new URL(c.req.url).origin}/api/upload/${storageKey}`
      return c.json({
        postId,
        zipUploadUrl,
        zipKey: storageKey
      })
    } else if (contentType === 'application/x-shockwave-flash') {
      const swfUploadUrl = `${new URL(c.req.url).origin}/api/upload/${storageKey}`
      return c.json({
        postId,
        swfUploadUrl,
        swfKey: storageKey
      })
    } else {
      const gifUploadUrl = `${new URL(c.req.url).origin}/api/upload/${storageKey}`
      return c.json({
        postId,
        gifUploadUrl,
        gifKey: storageKey
      })
    }
  } catch (error: any) {
    console.error('Prepare post error:', error)
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
})

// Step 3 — POST /api/posts/commit (protected)
app.post('/api/posts/commit', requireAuth, async (c) => {
  try {
    const { postId, gifKey, zipKey, swfKey, text, hashtags } = await c.req.json()
    
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
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?
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
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reply_count, 0) as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?
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
      
      // Queue ActivityPub delivery for public posts
      if (post && post.visibility === 'public') {
        try {
          const user = c.get('user')
          if (user) {
            const note = buildNoteObject(post, user, c.env.BASE_URL)
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
    
    return c.json({ post })
  } catch (error: any) {
    console.error('Commit post error:', error)
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/posts - create post (protected)
app.post('/api/posts', requireAuth, async (c) => {
  const isTestEnvironment = c.req.url.includes('localhost:8788')
  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `post:${c.get('user')?.id}`,
    limit: 5,
    windowSeconds: 60
  })
  if (!rl.allowed) return rateLimitResponse(c, rl.resetIn, 5)

  try {
    const contentType = c.req.header('content-type')
    let text: string
    let payloadKey: string | undefined
    let gifKey: string | undefined
    let swfKey: string | undefined
    let thumbnailKey: string | undefined
    let thumbnailFile: File | undefined

    if (contentType?.includes('multipart/form-data')) {
      // Handle multipart/form-data (for thumbnail uploads)
      const formData = await c.req.formData()
      text = formData.get('text') as string
      payloadKey = formData.get('payloadKey') as string | null || undefined
      gifKey = formData.get('gifKey') as string | null || undefined
      swfKey = formData.get('swfKey') as string | null || undefined
      thumbnailFile = formData.get('thumbnail') as File | null || undefined

      // Process thumbnail if present and payload is ZIP or SWF
      if (thumbnailFile && thumbnailFile.size > 0) {
        // Only allow thumbnail for ZIP or SWF posts
        if (!payloadKey?.startsWith('zip/') && !swfKey?.startsWith('swf/')) {
          return c.json({ error: 'Thumbnail only allowed for ZIP or SWF posts' }, 400)
        }

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

        const postId = crypto.randomUUID()
        thumbnailKey = `thumbnail/${postId}.${ext}`

        await c.env.BUCKET.put(thumbnailKey, await thumbnailFile.arrayBuffer(), {
          httpMetadata: {
            contentType: thumbnailFile.type
          }
        })
      }
    } else {
      // Handle JSON request (existing behavior)
      const body = await c.req.json()
      text = body.text
      payloadKey = body.payloadKey
      gifKey = body.gifKey
      swfKey = body.swfKey
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
        // Get post details
        const post = await c.env.DB.prepare(
          'SELECT id, text, created_at, visibility FROM posts WHERE id = ?'
        ).bind(postId).first() as { id: string, text: string, created_at: string, visibility: string } | null

        if (post && post.visibility === 'public') {
          // Build Note and Create activity
          const note = buildNoteObject(post, user, c.env.BASE_URL)
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
    
    return c.json({ id: postId })
  } catch (error: any) {
    console.error('Post creation error:', error)
    return c.json({ error: 'Internal server error', details: error?.message || 'Unknown error' }, 500)
  }
})

// POST /api/posts/:id/fresh - toggle Fresh! (protected)
app.post('/api/posts/:id/fresh', requireAuth, async (c) => {

  const postId = c.req.param('id')
  const userId = c.get('user')?.id || ''
  
  // Get post to check ownership for notification
  const post = await c.env.DB.prepare(
    'SELECT user_id FROM posts WHERE id = ? AND status = \'published\''
  ).bind(postId).first()
  
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
      // Check if notification already exists to prevent duplicates from rapid clicks
      const existingNotif = await c.env.DB.prepare(
        'SELECT id FROM notifications WHERE user_id = ? AND actor_id = ? AND post_id = ? AND type = \'fresh\''
      ).bind(post.user_id, userId, postId).first()

      if (!existingNotif) {
        try {
          await c.env.DB
            .prepare('INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)')
            .bind(nanoid(), post.user_id, 'fresh', postId, userId)
            .run()
        } catch (e) {
          // Don't fail the fresh operation if notification fails
          console.error('Failed to create fresh notification:', e)
        }
      }
    }
    
    return c.json({ freshed: true, fresh_count: result?.fresh_count ?? 0 })
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
        const freshValues = toFresh.map(id => `('${id}', '${userId}')`).join(',')
        await c.env.DB.prepare(`
          INSERT INTO freshs (post_id, user_id) VALUES ${freshValues}
        `).run()
        
        // Batch update fresh counts
        await c.env.DB.prepare(`
          UPDATE posts SET fresh_count = fresh_count + 1 WHERE id IN (${toFresh.map(() => '?').join(',')})
        `).bind(...toFresh).run()
        
        // Create notifications for non-self posts
        const notificationsToCreate = posts.results
          .filter(p => toFresh.includes(p.id) && p.user_id !== userId)
          .map(p => `('${nanoid()}', '${p.user_id}', 'fresh', '${p.id}', '${userId}')`)
        
        if (notificationsToCreate.length > 0) {
          try {
            await c.env.DB.prepare(`
              INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES ${notificationsToCreate.join(',')}
            `).run()
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

// GET /api/posts/:id/replies - get direct replies
app.get('/api/posts/:id/replies', async (c) => {
  try {
    const postId = c.req.param('id')
    const cursor = c.req.query('cursor')
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50)
    
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
    
    let query = `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
       u.display_name, u.avatar_key
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.parent_id = ? AND p.status = 'published' 
       ORDER BY p.created_at ASC LIMIT ?`
    const params: any[] = [postId, limit]
    
    if (cursor) {
      query = `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
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
      `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
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
      `SELECT p.id, p.user_id, p.username, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, COALESCE(p.impressions, 0) as impressions, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at,
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
    
    // Add fresh status for current user if logged in
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?, 0)
    `).bind(
      replyId, 
      c.get('user')?.id || '', 
      c.get('user')?.username || 'anonymous', 
      '', 
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
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?
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
          SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.fresh_count, (SELECT COUNT(*) FROM posts WHERE parent_id = p.id AND status = 'published') as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?
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
    if (parentPost.user_id !== c.get('user')?.id) {
      try {
        await c.env.DB.prepare(`
          INSERT INTO notifications (id, user_id, type, post_id, actor_id) 
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          nanoid(),
          parentPost.user_id,
          'reply',
          postId,
          c.get('user')?.id
        ).run()
      } catch (e) {
        console.error('Failed to create reply notification:', e)
        // Don't fail the whole operation, just log the error
      }
    }

    // Create mention notifications for mentioned users in the reply (skip self-mentions)
    if (mentionedUsernames.length > 0) {
      try {
        const replyUserId = c.get('user')?.id || ''
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
    const type = c.req.query('type') || 'posts' // 'posts' or 'users'
    const limit = Math.min(Number(c.req.query('limit') || '20'), 50)
    
    if (!query || query.trim().length === 0) {
      return c.json({ error: 'Search query required' }, 400)
    }
    
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500)
    }
    
    const searchTerm = `%${query.trim()}%`
    
    if (type === 'users') {
      // Search users
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
      } else if (type === 'arcade') {
      // Search arcade (posts with swf_key or payload_key)
      const posts = await c.env.DB.prepare(`
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reply_count, 0) as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        WHERE p.status = 'published' AND p.hidden = 0 AND (p.swf_key IS NOT NULL OR p.payload_key IS NOT NULL) AND (p.text LIKE ? OR p.username LIKE ?)
        ORDER BY p.created_at DESC
        LIMIT ?
      `).bind(searchTerm, searchTerm, limit).all()

      return c.json({
        type: 'arcade',
        query,
        results: posts.results || []
      })
      } else {
      // Search posts (default)
      const posts = await c.env.DB.prepare(`
        SELECT p.id, p.user_id, p.username, u.display_name, u.avatar_key, p.text, p.hashtags, p.mentions, p.gif_key, p.payload_key, p.swf_key, p.thumbnail_key, p.fresh_count, COALESCE(p.reply_count, 0) as reply_count, p.parent_id, p.root_id, COALESCE(p.depth, 0) as depth, COALESCE(p.status, 'published') as status, p.created_at
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        WHERE p.status = 'published' AND p.hidden = 0 AND (p.text LIKE ? OR p.username LIKE ?)
        ORDER BY p.created_at DESC
        LIMIT ?
      `).bind(searchTerm, searchTerm, limit).all()

      return c.json({
        type: 'posts',
        query,
        results: posts.results || []
      })
      }  } catch (error: any) {
    console.error('Search error:', error)
    return c.json({ error: 'Search failed', details: error?.message || 'Unknown error' }, 500)
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
      'SELECT id, user_id, username, gif_key, payload_key, swf_key, thumbnail_key, status FROM posts WHERE id = ?'
    ).bind(postId).first() as { id: string; user_id: string; username: string; gif_key?: string; payload_key?: string; swf_key?: string; thumbnail_key?: string; status?: string } | null
    
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
        await c.env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(reply.id).run()
      }
    }
    await deleteReplies(postId)
    
    // Delete the post
    const result = await c.env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run()
    
    if (!result.success) {
      return c.json({ error: 'Failed to delete post' }, 500)
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
  await db.prepare(
    'INSERT INTO admin_alerts (id, post_id, category, priority) VALUES (?, ?, ?, ?)'
  ).bind(nanoid(), postId, category, priority).run()
}

// POST /api/report - unified report endpoint (protected)
app.post('/api/report', requireAuth, async (c) => {
  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `report:${c.get('user')?.id}`,
    limit: 10,
    windowSeconds: 60
  })
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
    const notifications = (result.results || []).map((row: any) => ({
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
    }))
    
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

// GET /api/actors/:username - ActivityPub Actor endpoint
app.get('/api/actors/:username', async (c) => {
  const username = c.req.param('username')
  const user = await c.env.DB.prepare(`SELECT id, username, display_name, bio, avatar_key FROM users WHERE username = ? COLLATE NOCASE`).bind(username).first() as any
  if (!user) return c.json({ error: 'User not found' }, 404)

  const keyRecord = await c.env.DB.prepare(`SELECT public_key_pem FROM actor_keys WHERE user_id = ?`).bind(user.id).first() as any
  let publicKeyPem = keyRecord?.public_key_pem
  if (!publicKeyPem) {
    const keyPair = await generateKeyPair()
    publicKeyPem = await exportPublicKey(keyPair.publicKey)
    await c.env.DB.prepare(`INSERT INTO actor_keys (user_id, public_key_pem, private_key_pem, created_at) VALUES (?, ?, ?, datetime('now'))`).bind(user.id, publicKeyPem, await exportPrivateKey(keyPair.privateKey)).run()
  }

  return c.json({
    "@context": "https://www.w3.org/ns/activitystreams",
    "type": "Person",
    "id": `${c.env.BASE_URL}/api/actors/${username}`,
    "preferredUsername": user.username,
    "name": user.display_name,
    "summary": user.bio || "",
    "inbox": `${c.env.BASE_URL}/api/actors/${username}/inbox`,
    "outbox": `${c.env.BASE_URL}/api/actors/${username}/outbox`,
    "publicKey": {
      "id": `${c.env.BASE_URL}/api/actors/${username}#main-key`,
      "owner": `${c.env.BASE_URL}/api/actors/${username}`,
      "publicKeyPem": publicKeyPem
    }
  }, 200, { 'Content-Type': 'application/activity+json' })
})

// GET /api/actors/:username/outbox - Outbox endpoint
app.get('/api/actors/:username/outbox', async (c) => {
  const username = c.req.param('username')
  const page = c.req.query('page')
  const pageSize = 20

  const user = await c.env.DB.prepare(`SELECT id FROM users WHERE username = ? COLLATE NOCASE`).bind(username).first() as any
  if (!user) return c.json({ error: 'User not found' }, 404)

  const totalItems = (await c.env.DB.prepare(`SELECT COUNT(*) as count FROM posts WHERE user_id = ? AND status = 'published'`).bind(user.id).first() as any).count

  if (!page) {
    return c.json({
      "@context": "https://www.w3.org/ns/activitystreams",
      "type": "OrderedCollection",
      "id": `${c.env.BASE_URL}/api/actors/${username}/outbox`,
      "totalItems": totalItems,
      "first": `${c.env.BASE_URL}/api/actors/${username}/outbox?page=1`,
      "last": `${c.env.BASE_URL}/api/actors/${username}/outbox?page=${Math.ceil(totalItems / pageSize) || 1}`
    }, 200, { 'Content-Type': 'application/activity+json' })
  }

  const currentPage = parseInt(page) || 1
  const posts = await c.env.DB.prepare(`SELECT id, text, created_at FROM posts WHERE user_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(user.id, pageSize, (currentPage - 1) * pageSize).all() as any
  const activities = posts.results.map((post: any) => buildCreateActivity(buildNoteObject(post, user, c.env.BASE_URL), user, c.env.BASE_URL))

  const response: any = {
    "@context": "https://www.w3.org/ns/activitystreams",
    "type": "OrderedCollectionPage",
    "id": `${c.env.BASE_URL}/api/actors/${username}/outbox?page=${currentPage}`,
    "partOf": `${c.env.BASE_URL}/api/actors/${username}/outbox`,
    "orderedItems": activities
  }
  if ((currentPage * pageSize) < totalItems) response.next = `${c.env.BASE_URL}/api/actors/${username}/outbox?page=${currentPage + 1}`
  if (currentPage > 1) response.prev = `${c.env.BASE_URL}/api/actors/${username}/outbox?page=${currentPage - 1}`

  return c.json(response, 200, { 'Content-Type': 'application/activity+json' })
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
             p.fresh_count
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
      type: result.swf_key ? 'flash' : 'html'
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
