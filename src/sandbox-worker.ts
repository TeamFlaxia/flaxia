import type { Context } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { isKeyBlocked } from '../functions/lib/scan/db';
import { MULTIPLAYER_SDK_IIFE } from './lib/multiplayer-sdk.generated';
import { pdfViewerAssetBody, pdfViewerAssetHeaders } from './lib/pdf-viewer-page';
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
  CACHE?: KVNamespace;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
};

const SANDBOX_CSP = [
  'sandbox allow-scripts allow-pointer-lock allow-forms allow-popups',
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:",
  "style-src 'self' 'unsafe-inline' data: blob: https:",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data: blob: https:",
  "connect-src 'self' data: blob: https: wss:",
  "frame-src 'self' blob: data: https:",
  'frame-ancestors https://flaxia.app https://*.pages.dev http://localhost:5173 http://localhost:8787 http://localhost:8788',
].join('; ');

const ZIP_PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:",
  "style-src 'self' 'unsafe-inline' data: blob: https:",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data: blob: https:",
  "connect-src 'self' data: blob: https: wss:",
  'frame-src blob: data: https:',
  'frame-ancestors https://flaxia.app https://*.pages.dev http://localhost:5173 http://localhost:8787 http://localhost:8788',
].join('; ');

const PDF_VIEWER_CSP = [
  "default-src 'none'",
  "script-src 'self' 'sha256-G4/emu0SNnFJECp6THR3fUV6IVS9yM8Y/dhtETHdW+E=' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' blob: data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'frame-ancestors https://flaxia.app https://*.pages.dev http://localhost:5173 http://localhost:8787 http://localhost:8788',
].join('; ');

function withPdfViewerCsp(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', PDF_VIEWER_CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withZipPreviewCsp(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', ZIP_PREVIEW_CSP);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withCsp(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', SANDBOX_CSP);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const app = new Hono<{ Bindings: Bindings }>();

app.use('/*', cors());

async function serveZipPreviewAsset(
  c: Context<{ Bindings: Bindings }>,
  path: '/zip-preview.html' | '/zip-preview.js' | '/zip-preview-protocol.js',
): Promise<Response> {
  if (!c.env.ASSETS) return c.text('ZIP preview assets unavailable', 503);
  const assetUrl = new URL(path, c.req.url);
  const response = await c.env.ASSETS.fetch(new Request(assetUrl));
  if (!response.ok) return c.text('ZIP preview asset not found', 404);
  return withZipPreviewCsp(response);
}

app.get('/zip-preview', (c) => serveZipPreviewAsset(c, '/zip-preview.html'));
app.get('/zip-preview.html', (c) => serveZipPreviewAsset(c, '/zip-preview.html'));
app.get('/zip-preview.js', (c) => serveZipPreviewAsset(c, '/zip-preview.js'));
app.get('/zip-preview-protocol.js', (c) => serveZipPreviewAsset(c, '/zip-preview-protocol.js'));

app.get('/api/wvfs-zip/:postId/*', async (c) => {
  try {
    const postId = c.req.param('postId');
    let versionId = c.req.query('v') ?? undefined;
    const fullPath = c.req.path;
    const basePath = `/api/wvfs-zip/${postId}`;
    const filePath = fullPath.replace(basePath, '').replace(/^\//, '') || 'index.html';

    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    // 1. Find the ZIP/payload key and fail closed before any fast path. The
    // CDN-cached WVFS files are immutable, so a blocked archive can otherwise
    // keep serving extracted bytes after the scan verdict lands.
    let zipKey: string | null = null;

    if (!versionId && c.env.DB) {
      try {
        const postResult = (await c.env.DB.prepare('SELECT payload_key FROM posts WHERE id = ?')
          .bind(postId)
          .first()) as { payload_key: string } | null;
        if (postResult?.payload_key) {
          const escapedPostId = postId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const versionMatch = postResult.payload_key.match(new RegExp(`^versions/${escapedPostId}/([^/]+)\\.zip$`));
          if (versionMatch) {
            // Resolve to the version-specific lookup path.
            versionId = versionMatch[1];
          } else {
            const obj = await c.env.BUCKET.head(postResult.payload_key);
            if (obj) zipKey = postResult.payload_key;
          }
        }
      } catch {
        // proceed without post lookup on DB failure
      }
    }

    if (c.env.DB && versionId) {
      try {
        const versionResult = (await c.env.DB.prepare(
          'SELECT payload_key FROM game_versions WHERE post_id = ? AND id = ?',
        )
          .bind(postId, versionId)
          .first()) as { payload_key: string } | null;
        if (versionResult?.payload_key) {
          const obj = await c.env.BUCKET.head(versionResult.payload_key);
          if (obj) zipKey = versionResult.payload_key;
        }
      } catch {
        // proceed without version lookup on DB failure
      }
    }

    if (!zipKey && c.env.DB) {
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
      // DM media is private and must be served by the main origin, which can
      // authorize the requester. The sandbox origin has no session context, so
      // it must never serve `dm/` keys.
      const keysToTry = [`zip/${postId}.zip`, `html/${postId}.html`];
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

    if (await isKeyBlocked(c.env.CACHE, zipKey, c.env.DB)) {
      return c.text('Not found', 404);
    }

    // 2. Try pre-extracted R2 files (fast path — persists across workers, CDN-cacheable)
    let response = await serveFileFromR2(c.env.BUCKET, postId, filePath, versionId);
    if (response) return withCsp(response);

    // 3. Try in-memory cache (second fast path)
    response = await serveFileFromWvfs(postId, filePath, versionId);
    if (response) return withCsp(response);

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
        );
      }
    }

    // 4. Try progressive extraction: parse central dir + extract just this file
    const loaded = await ensureFileInWvfs(c.env.BUCKET, zipKey, postId, filePath, versionId);
    if (loaded) {
      response = await serveFileFromWvfs(postId, filePath, versionId);
      if (response) {
        // Persist just this file to R2 so subsequent requests skip extraction.
        // Deliberately not a full-archive extraction: that would exceed the
        // CPU/subrequest limits on the free plan.
        c.executionCtx.waitUntil(persistFileToWvfsR2(c.env.BUCKET, postId, filePath, versionId));
        return withCsp(response);
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

// Trusted compatibility broker for game localStorage. This endpoint is kept
// outside the worker's CSP sandbox so it can read the sandbox origin's legacy
// storage; untrusted game documents continue to receive SANDBOX_CSP.
app.get('/api/game-storage', (c) => {
  const html = `<!doctype html><meta charset="utf-8"><script>
    (function(){
      'use strict';
      var allowedOrigins=new Set(['https://flaxia.app','http://localhost:5173','http://localhost:8787','http://localhost:8788']);
      function send(origin,message){try{window.parent.postMessage(message,origin)}catch{}}
      window.addEventListener('message',function(event){
        if(event.source!==window.parent||!allowedOrigins.has(event.origin))return;
        var message=event.data;
        if(!message||typeof message!=='object')return;
        var namespace=typeof message.namespace==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(message.namespace)?message.namespace:null;
        if(!namespace)return;
        var prefix='flaxia:game:'+namespace+':';
        try{
          if(message.type==='FLAXIA_STORAGE_READ'&&typeof message.requestId==='string'){
            var entries=[];
            for(var i=0;i<localStorage.length;i++){var key=localStorage.key(i);if(key!==null&&key.indexOf(prefix)===0){var value=localStorage.getItem(key);if(value!==null)entries.push([key.slice(prefix.length),value])}}
            send(event.origin,{type:'FLAXIA_STORAGE_SNAPSHOT',requestId:message.requestId,entries:entries});
          }else if(message.type==='FLAXIA_STORAGE_SET'&&typeof message.key==='string'&&typeof message.value==='string'){
            if(message.key.length>512||message.value.length>100000)return;
            localStorage.setItem(prefix+message.key,message.value);
          }else if(message.type==='FLAXIA_STORAGE_REMOVE'&&typeof message.key==='string'){
            localStorage.removeItem(prefix+message.key);
          }else if(message.type==='FLAXIA_STORAGE_CLEAR'){
            var doomed=[];
            for(var j=0;j<localStorage.length;j++){var k=localStorage.key(j);if(k!==null&&k.indexOf(prefix)===0)doomed.push(k)}
            for(var d=0;d<doomed.length;d++)localStorage.removeItem(doomed[d]);
          }
        }catch(error){send(event.origin,{type:'FLAXIA_STORAGE_ERROR',message:String(error)})}
      });
      window.parent.postMessage({type:'FLAXIA_STORAGE_BROKER_READY'},'*');
    })();
  </script>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors https://flaxia.app http://localhost:5173 http://localhost:8787 http://localhost:8788",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
});

app.get('/sdk/multiplayer.js', (c) => {
  return c.body(MULTIPLAYER_SDK_IIFE, 200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'public, max-age=86400',
  });
});

// PDF viewer page and the pdf.js files it imports. The viewer runs *inside*
// this origin so untrusted documents are parsed by pdf.js in a frame the main
// origin does not own — the browser's built-in PDF plugin can never be shown
// in a sandboxed frame (whatwg/html#6946), and main-origin parsing would turn
// a pdf.js bug into site-wide XSS. See src/lib/pdf-viewer-page.ts.
app.get('/pdf/*', (c) => {
  const asset = c.req.path.slice('/pdf/'.length);
  const body = pdfViewerAssetBody(asset);
  const headers = pdfViewerAssetHeaders(asset);
  if (body === null || headers === null) return c.text('Not found', 404);
  return withPdfViewerCsp(new Response(body, { headers }));
});

app.notFound(async (c) => {
  const referer = c.req.header('Referer') || '';
  const wvfsMatch = referer.match(/\/api\/wvfs-zip\/([^/?#]+)/);
  if (wvfsMatch && c.env.BUCKET) {
    const postId = wvfsMatch[1];
    const versionId = (() => {
      try {
        return new URL(referer).searchParams.get('v') ?? undefined;
      } catch {
        return undefined;
      }
    })();
    const filePath = c.req.path.replace(/^\//, '') || 'index.html';
    let response = await serveFileFromR2(c.env.BUCKET, postId, filePath, versionId);
    if (response) return withCsp(response);
    response = await serveFileFromWvfs(postId, filePath, versionId);
    if (response) return withCsp(response);
  }
  return c.text('Not found', 404);
});

export default {
  fetch: (request: Request, env: Bindings, ctx: ExecutionContext) => {
    return app.fetch(request, env, ctx);
  },
};
