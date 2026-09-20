// Immutable asset proxy for the browser node bundle. Webhook handling lives in
// ./webhook.ts; this route only serves pinned `@flaxia/node` build artifacts
// from upstream so the SPA can import them with long-lived caching.
import { CROWD_NODE_VERSION } from '../../../src/lib/crowd-node';

const UPSTREAM = `https://unpkg.com/@flaxia/node@${CROWD_NODE_VERSION}/dist`;
const MIME: Record<string, string> = {
  js: 'application/javascript',
  wasm: 'application/wasm',
  json: 'application/json',
};

export async function onRequest(context: {
  request: Request;
  env: Record<string, unknown>;
  waitUntil(p: Promise<unknown>): void;
}) {
  const url = new URL(context.request.url);
  if (context.request.method !== 'GET') {
    return new Response('Not Found', { status: 404 });
  }

  // Strip a leading version segment (e.g. /api/crowd/v0.3.5-0/index.js) so
  // clients can cache-bust immutable assets by bumping the versioned path.
  const path = url.pathname.replace(/^\/api\/crowd\//, '').replace(/^v[^/]+\//, '');

  const upstream = `${UPSTREAM}/${path}`;
  try {
    const res = await fetch(upstream);
    const ext = path.split('.').pop() || '';
    const body = await res.arrayBuffer();
    return new Response(body, {
      status: res.status,
      headers: {
        'Content-Type': MIME[ext] || 'application/javascript',
        'Access-Control-Allow-Origin': 'https://flaxia.app',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    console.error('Crowd proxy error:', e);
    return new Response('Proxy error', { status: 502 });
  }
}
