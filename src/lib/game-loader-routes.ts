import type { Context } from 'hono';

const ALLOWED_ASSETS = new Set([
  'prototype.html',
  'prototype.js',
  'launch.js',
  'public-player.js',
  'prototype.css',
  'protocol.js',
  'cache.js',
  'sw.js',
  'runtime.js',
  'game-shell.html',
  'game-shell.js',
  'generated/unzip-worker.js',
]);
const ANCESTORS =
  "frame-ancestors 'self' https://flaxia.app https://*.pages.dev http://localhost:5173 http://localhost:8787 http://localhost:8788";
const LOADER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "worker-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  ANCESTORS,
].join('; ');
const GAME_CSP = [
  'sandbox allow-scripts allow-pointer-lock',
  "default-src 'none'",
  "script-src 'self' blob: 'unsafe-inline' 'unsafe-eval'",
  "style-src blob: 'unsafe-inline'",
  'img-src blob: data:',
  'media-src blob: data:',
  'font-src blob: data:',
  'connect-src blob: data:',
  'worker-src blob:',
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  ANCESTORS,
].join('; ');

export async function serveGameLoaderAsset<B extends { ASSETS?: { fetch: (request: Request) => Promise<Response> } }>(
  c: Context<{ Bindings: B }>,
): Promise<Response> {
  const path = c.req.path.slice('/game-loader/'.length);
  const asset = ['prototype', 'player'].includes(path) ? 'prototype.html' : path;
  // CacheStorage keys and arbitrary uploaded content are never HTTP routes.
  if (!ALLOWED_ASSETS.has(asset)) return c.text('Not found', 404);
  if (!c.env.ASSETS) return c.text('Loader assets unavailable', 503);
  const response = await c.env.ASSETS.fetch(new Request(new URL(`/game-loader/${asset}`, c.req.url)));
  if (!response.ok) return c.text('Loader asset not found; run npm run build:game-loader', 404);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  // The opaque game shell imports its trusted bootstrap with Origin: null.
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Content-Security-Policy', asset === 'game-shell.html' ? GAME_CSP : LOADER_CSP);
  if (asset.endsWith('.js')) headers.set('Content-Type', 'text/javascript; charset=utf-8');
  if (asset === 'sw.js') headers.set('Service-Worker-Allowed', '/game-loader/');
  return new Response(response.body, { status: response.status, headers });
}
