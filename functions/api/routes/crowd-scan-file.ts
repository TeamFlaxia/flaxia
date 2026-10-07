import { verifyFileScanTicket } from '../../lib/crowd.ts';
import { getFileScan } from '../../lib/scan/db.ts';
import type { Bindings } from '../types.ts';

const SCAN_FILE_PATH = '/api/crowd/scan-file';

function allowedOrigins(env: Bindings): Set<string> {
  const origins = new Set<string>();
  try {
    origins.add(new URL(env.BASE_URL || 'https://flaxia.app').origin);
  } catch {
    origins.add('https://flaxia.app');
  }
  for (const value of (env.CROWD_NODE_ORIGINS || '').split(',')) {
    const candidate = value.trim();
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.origin === candidate && parsed.protocol === 'https:') {
        origins.add(parsed.origin);
      }
    } catch {
      // Ignore malformed origin entries; the bearer ticket remains the authority.
    }
  }
  return origins;
}

function responseHeaders(request: Request, env: Bindings): Headers {
  const headers = new Headers({
    'Cache-Control': 'no-store, private',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });
  const origin = request.headers.get('Origin');
  if (origin && allowedOrigins(env).has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization');
    headers.set('Access-Control-Max-Age', '600');
  }
  return headers;
}

function isAllowedOrigin(request: Request, env: Bindings): boolean {
  const origin = request.headers.get('Origin');
  return !origin || allowedOrigins(env).has(origin);
}

function bearerTicket(request: Request): string | null {
  const header = request.headers.get('Authorization');
  const match = header?.match(/^Bearer ([A-Za-z0-9_-]+\.[a-f0-9]{64})$/);
  return match?.[1] ?? null;
}

function notFound(headers: Headers): Response {
  return new Response('Not found', { status: 404, headers });
}

/** Serve a single pending R2 object to a Crowd node holding its scoped ticket. */
export async function handleCrowdScanFileRequest(request: Request, env: Bindings): Promise<Response> {
  const headers = responseHeaders(request, env);
  if (request.method === 'OPTIONS') {
    if (!isAllowedOrigin(request, env)) return new Response('Origin not allowed', { status: 403, headers });
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'GET' || new URL(request.url).pathname !== SCAN_FILE_PATH) {
    return new Response('Not found', { status: 404, headers });
  }
  if (!isAllowedOrigin(request, env)) return new Response('Origin not allowed', { status: 403, headers });

  const token = bearerTicket(request);
  if (!token) return new Response('Unauthorized', { status: 401, headers });

  const ticket = await verifyFileScanTicket(env, token);
  if (!ticket) return notFound(headers);

  try {
    const scan = await getFileScan(env.DB, ticket.key);
    if (
      !scan ||
      scan.sha256.toLowerCase() !== ticket.sha256 ||
      (scan.status !== 'pending' && scan.status !== 'submitted' && scan.status !== 'clean')
    ) {
      return notFound(headers);
    }

    const object = await env.BUCKET.get(ticket.key);
    if (!object || object.size !== ticket.size) return notFound(headers);

    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Disposition', 'attachment; filename="scan-input"');
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { status: 200, headers });
  } catch (error) {
    console.error('Crowd scan-file retrieval failed:', error instanceof Error ? error.message : 'unknown error');
    return new Response('Scan file unavailable', { status: 503, headers });
  }
}
