import { hmacHex, signatureEquals } from './hmac.ts';
import { checkRateLimit, getClientIp } from './rate-limit.ts';

export interface CcRangeEnv {
  CROWD_WEBHOOK_SECRET?: string;
  CROWD_API_KEY?: string;
  CACHE?: KVNamespace;
}

// Browser Crowd nodes cannot fetch Common Crawl byte ranges directly: sending a
// `Range` header cross-origin triggers a CORS preflight, and data.commoncrawl.org
// answers OPTIONS with 403 even though the actual GET would succeed. Flaxia
// therefore mints a short-lived, narrowly scoped ticket and streams the range
// itself. The node still performs all WARC/HTML extraction.
const CC_DATA_HOST = 'data.commoncrawl.org';
const CC_WARC_PATH_PATTERN =
  /^crawl-data\/CC-MAIN-\d{4}-\d{2}\/segments\/[A-Za-z0-9._-]+\/warc\/[A-Za-z0-9._-]+\.warc\.gz$/;
export const MAX_CC_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_TICKET_CHARS = 4096;
const CC_RANGE_TICKET_TTL_MS = 10 * 60 * 1000;
const CC_RANGE_SIGNING_PREFIX = 'flaxia-cc-range-v1';

export interface CcRangeInput {
  warcFilename: string;
  offset: number;
  length: number;
}

interface CcRangeClaims extends CcRangeInput {
  v: 1;
  exp: number;
}

export function isValidWarcPath(value: unknown): value is string {
  return typeof value === 'string' && CC_WARC_PATH_PATTERN.test(value);
}

function base64UrlEncodeText(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecodeText(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function validateInput(input: CcRangeInput): CcRangeClaims {
  if (!isValidWarcPath(input.warcFilename)) throw new Error('Invalid Common Crawl WARC path');
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) throw new Error('Invalid WARC offset');
  if (!Number.isSafeInteger(input.length) || input.length < 1 || input.length > MAX_CC_RECORD_BYTES) {
    throw new Error(`Invalid WARC length (1..${MAX_CC_RECORD_BYTES})`);
  }
  return {
    v: 1,
    warcFilename: input.warcFilename,
    offset: input.offset,
    length: input.length,
    exp: Date.now() + CC_RANGE_TICKET_TTL_MS,
  };
}

/**
 * Mint the URL a `cc-extract` record carries as `fetchUrl`. The signature is
 * domain-separated from webhook and file-scan tickets, and the claims bind the
 * exact WARC path and byte range.
 */
export async function createCcRangeUrl(secret: string, baseUrl: string, input: CcRangeInput): Promise<string> {
  if (!secret) throw new Error('Crowd CC range signing secret is not configured');
  const claims = validateInput(input);
  const body = base64UrlEncodeText(JSON.stringify(claims));
  const signature = await hmacHex(secret, `${CC_RANGE_SIGNING_PREFIX}.${body}`);
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/api/crowd/cc-range`);
  url.searchParams.set('ticket', `${body}.${signature}`);
  return url.toString();
}

/** Verify signature, scope and expiry before contacting Common Crawl. */
export async function verifyCcRangeTicket(
  secret: string,
  ticket: string,
  now = Date.now(),
): Promise<CcRangeClaims | null> {
  if (!secret || typeof ticket !== 'string' || ticket.length === 0 || ticket.length > MAX_TICKET_CHARS) {
    return null;
  }
  const parts = ticket.split('.');
  if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1]!)) return null;
  const [body, signature] = parts as [string, string];
  const expected = await hmacHex(secret, `${CC_RANGE_SIGNING_PREFIX}.${body}`);
  if (!signatureEquals(signature, expected)) return null;

  const decoded = base64UrlDecodeText(body);
  if (!decoded) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Partial<CcRangeClaims>;
  if (
    value.v !== 1 ||
    !isValidWarcPath(value.warcFilename) ||
    !Number.isSafeInteger(value.offset) ||
    (value.offset as number) < 0 ||
    !Number.isSafeInteger(value.length) ||
    (value.length as number) < 1 ||
    (value.length as number) > MAX_CC_RECORD_BYTES ||
    !Number.isSafeInteger(value.exp) ||
    (value.exp as number) <= now
  ) {
    return null;
  }
  return value as CcRangeClaims;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length',
  'Access-Control-Max-Age': '3600',
};

/**
 * Signed range proxy for `cc-extract`. Only Common Crawl object paths are
 * accepted and only the exact byte range in the ticket is fetched, so the
 * endpoint cannot be turned into a general-purpose fetch proxy.
 */
export async function handleCcRangeRequest(request: Request, env: CcRangeEnv): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
  }

  const ticket = new URL(request.url).searchParams.get('ticket') ?? '';
  const secret = env.CROWD_WEBHOOK_SECRET || env.CROWD_API_KEY || '';
  const claims = await verifyCcRangeTicket(secret, ticket);
  if (!claims) return new Response('Forbidden', { status: 401, headers: CORS_HEADERS });

  const allowed = await checkRateLimit(env.CACHE, `ccrange:${getClientIp(request)}`, {
    maxRequests: 240,
    windowSeconds: 60,
  });
  if (!allowed) return new Response('Too Many Requests', { status: 429, headers: CORS_HEADERS });

  const range = `bytes=${claims.offset}-${claims.offset + claims.length - 1}`;
  let upstream: Response;
  try {
    upstream = await fetch(`https://${CC_DATA_HOST}/${claims.warcFilename}`, {
      headers: {
        Range: range,
        Accept: 'application/octet-stream',
        'User-Agent': 'Flaxia-Crowd/0.6 (+https://flaxia.app/crowd)',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    console.error('CC range fetch failed:', error);
    return new Response('Bad Gateway', { status: 502, headers: CORS_HEADERS });
  }

  if (!upstream.ok) {
    return new Response('Upstream error', { status: 502, headers: CORS_HEADERS });
  }
  const contentRange = upstream.headers.get('content-range');
  if (contentRange) {
    const match = /^bytes\s+(\d+)-(\d+)\//i.exec(contentRange.trim());
    if (!match || Number(match[1]) !== claims.offset) {
      return new Response('Upstream range mismatch', { status: 502, headers: CORS_HEADERS });
    }
  } else if (upstream.status !== 206) {
    return new Response('Upstream ignored the range', { status: 502, headers: CORS_HEADERS });
  }

  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.byteLength !== claims.length) {
    return new Response('Upstream length mismatch', { status: 502, headers: CORS_HEADERS });
  }

  return new Response(request.method === 'HEAD' ? null : bytes, {
    status: 206,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'Content-Range': `bytes ${claims.offset}-${claims.offset + claims.length - 1}/${claims.offset + claims.length}`,
      'Cache-Control': 'private, max-age=60',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
