import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { extractZipToR2, serveFileFromR2 } from './lib/wvfs-zip-server';

type Bindings = {
  BUCKET: R2Bucket;
  DB: D1Database;
};

const SANDBOX_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' 'unsafe-inline' https:",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data: https:",
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

async function findZipKey(bucket: R2Bucket, db: D1Database | undefined, postId: string): Promise<string | null> {
  if (db) {
    try {
      const adResult = (await db
        .prepare("SELECT payload_key FROM ads WHERE id = ? AND payload_type = 'zip' AND active = 1")
        .bind(postId)
        .first()) as { payload_key: string } | null;
      if (adResult?.payload_key) {
        const obj = await bucket.head(adResult.payload_key);
        if (obj) return adResult.payload_key;
      }
    } catch {
      // proceed without ad lookup on DB failure
    }
  }

  const keysToTry = [
    `zip/${postId}.zip`,
    `dos/${postId}.zip`,
    `jsdos/${postId}.jsdos`,
    `dm/zip/${postId}.zip`,
    `dm/dos/${postId}.zip`,
  ];
  for (const key of keysToTry) {
    const obj = await bucket.head(key);
    if (obj) return key;
  }

  return null;
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

    // 1. Try pre-extracted R2 files — fast path
    let response = await serveFileFromR2(c.env.BUCKET, postId, filePath);
    if (response) return withCsp(response);

    // 2. Not in R2 yet — for new posts this shouldn't happen (commit-time extraction),
    //    but for old posts we do a one-time full extraction to R2.
    const zipKey = await findZipKey(c.env.BUCKET, c.env.DB, postId);
    if (!zipKey) {
      return c.json({ error: 'ZIP not found' }, 404);
    }

    const obj = await c.env.BUCKET.get(zipKey);
    if (!obj) {
      return c.json({ error: 'ZIP not found' }, 404);
    }

    // Extract the full ZIP to R2 synchronously, then serve the requested file
    await extractZipToR2(c.env.BUCKET, zipKey, postId);

    response = await serveFileFromR2(c.env.BUCKET, postId, filePath);
    if (response) return withCsp(response);

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

// Catch-all: serve root-level assets from ZIP context using Referer header.
// Vite-built apps in ZIPs use absolute paths like /assets/index-xxx.js
// which bypass the <base> tag. We extract postId from the Referer.
app.get('/*', async (c) => {
  const path = c.req.path;
  if (path.startsWith('/api/') || path === '/favicon.ico') {
    return c.notFound();
  }

  const referer = c.req.header('Referer');
  if (!referer) return c.notFound();

  const match = referer.match(/\/api\/wvfs-zip\/([^\/\?]+)/);
  if (!match) return c.notFound();

  const postId = match[1];
  const filePath = path.replace(/^\//, '');

  if (!c.env.BUCKET) return c.notFound();

  let response = await serveFileFromR2(c.env.BUCKET, postId, filePath);
  if (response) return withCsp(response);

  response = await serveFileFromWvfs(postId, filePath);
  if (response) return withCsp(response);

  let zipKey: string | null = null;
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

  if (!zipKey) return c.notFound();

  const loaded = await ensureFileInWvfs(c.env.BUCKET, zipKey, postId, filePath);
  if (loaded) {
    response = await serveFileFromWvfs(postId, filePath);
    if (response) {
      c.executionCtx.waitUntil(persistExtractionToR2(c.env.BUCKET, zipKey, postId));
      return withCsp(response);
    }
  }

  return c.notFound();
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default {
  fetch: (request: Request, env: Bindings, ctx: ExecutionContext) => {
    return app.fetch(request, env, ctx);
  },
};
