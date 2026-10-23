// Bump when HTML injection changes. Never reuse an older compatibility runtime.
const RESPONSE_REVISION = '2';
const EDGE_TTL = 86400;

interface WvfsResponseIdentity {
  postId: string;
  filePath: string;
  versionId?: string;
  payloadKey: string;
  payloadEtag?: string;
}

/** Call only after resolving the payload and checking its current scan verdict. */
export async function cacheWvfsResponse(
  request: Request,
  identity: WvfsResponseIdentity,
  load: () => Promise<Response>,
  waitUntil: (pending: Promise<unknown>) => void,
): Promise<Response> {
  // No reliable source revision => no persistent cache or synthetic validator.
  // This also keeps local runtimes without the Workers Cache API functional.
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !identity.payloadEtag) return load();

  const key = new URL('/__wvfs-response-cache', request.url);
  key.search = new URLSearchParams({
    revision: RESPONSE_REVISION,
    post: identity.postId,
    path: identity.filePath,
    version: identity.versionId ?? '',
    source: identity.payloadKey,
    etag: identity.payloadEtag,
  }).toString();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key.href));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const etag = `W/"wvfs-${hash}"`;
  const cacheKey = new Request(key);
  let cache: Cache | undefined;
  let response: Response | undefined;
  try {
    cache = typeof caches === 'undefined' ? undefined : await caches.open('wvfs-responses');
    response = await cache?.match(cacheKey);
  } catch {
    // Cache outages must not prevent a game from loading.
  }

  const hit = !!response;
  response ??= await load();
  if (response.status !== 200 || response.headers.has('Set-Cookie')) return response;

  const headers = new Headers(response.headers);
  headers.set('ETag', etag);
  headers.set('X-WVFS-Cache', hit ? 'HIT' : 'MISS');
  // Unversioned URLs can switch to another archive. Revalidate in the browser;
  // the edge entry below has a separate TTL and a source-specific cache key.
  const pinnedVersion = !!identity.versionId && new URL(request.url).searchParams.get('v') === identity.versionId;
  const browserCacheControl = pinnedVersion ? 'public, max-age=31536000, immutable' : 'public, no-cache';
  headers.set('Cache-Control', browserCacheControl);
  response = new Response(response.body, { status: response.status, headers });

  if (!hit && cache) {
    const stored = response.clone();
    stored.headers.set('Cache-Control', `public, max-age=${EDGE_TTL}`);
    waitUntil(cache.put(cacheKey, stored).catch(() => {}));
  }

  const validators = request.headers
    .get('If-None-Match')
    ?.split(',')
    .map((value) => value.trim());
  if (validators?.some((value) => value === '*' || value.replace(/^W\//, '') === etag.slice(2))) {
    if (response.body) waitUntil(response.body.cancel().catch(() => {}));
    headers.delete('Content-Length');
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') {
    if (response.body) waitUntil(response.body.cancel().catch(() => {}));
    return new Response(null, { status: response.status, headers });
  }
  return response;
}
