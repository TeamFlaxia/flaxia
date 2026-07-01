import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  ensureFileInWvfs,
  extractZipToR2,
  extractZipToWvfs,
  serveFileFromR2,
  serveFileFromWvfs,
} from './lib/wvfs-zip-server';

type Bindings = {
  BUCKET: R2Bucket;
  DB: D1Database;
};

const SANDBOX_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob: https:",
  'frame-ancestors https://flaxia.app',
].join('; ');

function withCsp(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', SANDBOX_CSP);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function persistExtractionToR2(bucket: R2Bucket, zipKey: string, postId: string): Promise<void> {
  try {
    await extractZipToR2(bucket, zipKey, postId);
  } catch (e) {
    console.error('Background R2 extraction failed:', e);
  }
}

const app = new Hono<{ Bindings: Bindings }>();

app.use('/*', cors());

app.get('/api/wvfs-zip/:postId/*', async (c) => {
  try {
    const postId = c.req.param('postId');
    const fullPath = c.req.path;
    const basePath = `/api/wvfs-zip/${postId}`;
    const filePath = fullPath.replace(basePath, '').replace(/^\//, '') || 'index.html';

    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    // 1. Try pre-extracted R2 files (fast path — persists across workers, CDN-cacheable)
    let response = await serveFileFromR2(c.env.BUCKET, postId, filePath);
    if (response) return withCsp(response);

    // 2. Try in-memory cache (second fast path)
    response = await serveFileFromWvfs(postId, filePath);
    if (response) return withCsp(response);

    // 3. Find the ZIP key in R2
    let zipKey: string | null = null;

    if (c.env.DB) {
      try {
        const adResult = (await c.env.DB.prepare(
          "SELECT payload_key FROM ads WHERE id = ? AND payload_type = 'zip' AND active = 1",
        )
          .bind(postId)
          .first()) as { payload_key: string } | null;
        if (adResult?.payload_key) {
          const obj = await c.env.BUCKET.head(adResult.payload_key);
          if (obj) zipKey = adResult.payload_key;
        }
      } catch {
        // proceed without ad lookup on DB failure
      }
    }

    if (!zipKey) {
      const keysToTry = [
        `zip/${postId}.zip`,
        `dos/${postId}.zip`,
        `jsdos/${postId}.jsdos`,
        `dm/zip/${postId}.zip`,
        `dm/dos/${postId}.zip`,
      ];
      for (const key of keysToTry) {
        const obj = await c.env.BUCKET.head(key);
        if (obj) {
          zipKey = key;
          break;
        }
      }
    }

    if (!zipKey) {
      return c.json({ error: 'ZIP not found' }, 404);
    }

    // 4. Try progressive extraction: parse central dir + extract just this file
    const loaded = await ensureFileInWvfs(c.env.BUCKET, zipKey, postId, filePath);
    if (loaded) {
      response = await serveFileFromWvfs(postId, filePath);
      if (response) {
        // Persist to R2 so subsequent requests skip extraction entirely
        c.executionCtx.waitUntil(persistExtractionToR2(c.env.BUCKET, zipKey, postId));
        return withCsp(response);
      }
    }

    // 5. Fallback: full extraction
    const obj = await c.env.BUCKET.get(zipKey);
    if (!obj) {
      return c.json({ error: 'ZIP not found' }, 404);
    }

    const zipData = await obj.arrayBuffer();
    await extractZipToWvfs(zipData, postId);

    response = await serveFileFromWvfs(postId, filePath);
    if (response) {
      c.executionCtx.waitUntil(persistExtractionToR2(c.env.BUCKET, zipKey, postId));
      return withCsp(response);
    }

    return c.json({ error: 'File not found in ZIP', path: filePath }, 404);
  } catch (error: unknown) {
    console.error('WVFS error:', error);
    if (error instanceof Error && error.message.includes('Path traversal')) {
      console.warn('Security violation: Path traversal attempt detected');
    }
    return c.json({ error: 'Failed to process ZIP file' }, 500);
  }
});

app.get('/favicon.ico', (c) => c.body(null, 204));

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default {
  fetch: (request: Request, env: Bindings, ctx: ExecutionContext) => {
    return app.fetch(request, env, ctx);
  },
};
