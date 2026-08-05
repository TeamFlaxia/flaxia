import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { MULTIPLAYER_SDK_IIFE } from './lib/multiplayer-sdk.generated';
import {
  copyHtmlToWvfs,
  ensureFileInWvfs,
  injectBaseTag,
  persistFileToWvfsR2,
  serveFileFromR2,
  serveFileFromWvfs,
} from './lib/wvfs-zip-server';

type Bindings = {
  BUCKET: R2Bucket;
  DB: D1Database;
};

function buildCsp(origin: string): string {
  return [
    "default-src 'self'",
    // Sandboxed (opaque-origin) frames can't match 'self', so also allow the
    // sandbox origin explicitly so games can still load their relative assets.
    `script-src 'self' ${origin} 'unsafe-inline' 'unsafe-eval' data: blob:`,
    `style-src 'self' ${origin} 'unsafe-inline' data: blob: https:`,
    `worker-src 'self' ${origin} blob:`,
    `img-src 'self' ${origin} data: blob: https:`,
    `media-src 'self' ${origin} data: blob: https:`,
    `font-src 'self' ${origin} data: https:`,
    `connect-src 'self' ${origin} data: blob: https: wss:`,
    'frame-ancestors https://flaxia.app',
  ].join('; ');
}

function withCsp(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', buildCsp(origin));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
    const origin = new URL(c.req.url).origin;
    let response = await serveFileFromR2(c.env.BUCKET, postId, filePath);
    if (response) return withCsp(response, origin);

    // 2. Try in-memory cache (second fast path)
    response = await serveFileFromWvfs(postId, filePath);
    if (response) return withCsp(response, origin);

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
        `html/${postId}.html`,
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
      return c.text('Not found', 404);
    }

    // 3a. Direct HTML file — serve from R2 directly (not a ZIP)
    if (zipKey.endsWith('.html')) {
      const obj = await c.env.BUCKET.get(zipKey);
      if (obj) {
        const htmlContent = await obj.text();
        const withoutCsp = htmlContent.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*\/?>/gi, '');
        const modifiedHtml = injectBaseTag(withoutCsp, postId);
        c.executionCtx.waitUntil(copyHtmlToWvfs(c.env.BUCKET, zipKey, postId));
        return withCsp(
          new Response(modifiedHtml, {
            headers: {
              'Content-Type': 'text/html',
              'Cache-Control': 'public, max-age=3600',
              'Access-Control-Allow-Origin': '*',
            },
          }),
          origin,
        );
      }
    }

    // 4. Try progressive extraction: parse central dir + extract just this file
    const loaded = await ensureFileInWvfs(c.env.BUCKET, zipKey, postId, filePath);
    if (loaded) {
      response = await serveFileFromWvfs(postId, filePath);
      if (response) {
        // Persist just this file to R2 so subsequent requests skip extraction.
        // Deliberately not a full-archive extraction: that would exceed the
        // CPU/subrequest limits on the free plan.
        c.executionCtx.waitUntil(persistFileToWvfsR2(c.env.BUCKET, postId, filePath));
        return withCsp(response, origin);
      }
    }

    // 5. Lazy extraction failed — the requested file is not present in this ZIP.
    // Avoid full-archive decompression in the request path (CPU time limit).
    console.warn(`WVFS: File not found after lazy extraction: ${filePath} (zipKey: ${zipKey})`);
    return c.text('Not found', 404);
  } catch (error: unknown) {
    console.error('WVFS error:', error);
    if (error instanceof Error && error.message.includes('Path traversal')) {
      console.warn('Security violation: Path traversal attempt detected');
    }
    return c.text('Internal server error', 500);
  }
});

app.get('/', (c) => c.json({ status: 'ok', worker: 'flaxia-sandbox' }, 200));

app.get('/favicon.ico', (c) => c.body(null, 204));

app.get('/sdk/multiplayer.js', (c) => {
  return c.body(MULTIPLAYER_SDK_IIFE, 200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'public, max-age=86400',
  });
});

app.notFound(async (c) => {
  const referer = c.req.header('Referer') || '';
  const wvfsMatch = referer.match(/\/api\/wvfs-zip\/([^/?#]+)/);
  if (wvfsMatch && c.env.BUCKET) {
    const postId = wvfsMatch[1];
    const filePath = c.req.path.replace(/^\//, '') || 'index.html';
    const origin = new URL(c.req.url).origin;
    let response = await serveFileFromR2(c.env.BUCKET, postId, filePath);
    if (response) return withCsp(response, origin);
    response = await serveFileFromWvfs(postId, filePath);
    if (response) return withCsp(response, origin);
  }
  return c.text('Not found', 404);
});

export default {
  fetch: (request: Request, env: Bindings, ctx: ExecutionContext) => {
    return app.fetch(request, env, ctx);
  },
};
