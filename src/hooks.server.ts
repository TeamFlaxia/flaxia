import { AsyncLocalStorage } from 'node:async_hooks';
import type { Handle, HandleFetch } from '@sveltejs/kit/hooks';
import { type LocaleData, localeFromCookie, setLocaleResolver } from './lib/i18n.ts';

// Cloudflare Pages ignores the root `functions/` directory once the adapter
// emits `_worker.js`, so the old `functions/_middleware.ts` responsibilities
// (security headers, ActivityPub redirects) live here.

const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['X-Frame-Options', 'DENY'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
];

const VARY_ACCEPT_LANGUAGE = /(?:^|,)\s*accept-language\s*(?:,|$)/i;
const VARY_COOKIE = /(?:^|,)\s*cookie\s*(?:,|$)/i;

// SSR boot payload marker. The JSON block is injected in transformPageChunk,
// which runs after the CSP header was finalised; it must therefore stay inert.
const BOOT_DATA_MARKER = '<!--FLAXIA_BOOT_DATA-->';

// The only /api/me fields safe to embed in public HTML. Email, role, tokens,
// nsfw filters and SRP metadata must never reach the browser this way.
const SESSION_FIELDS = ['id', 'username', 'display_name', 'avatar_key', 'badge_type', 'name_color'] as const;

type BootSession = Partial<Record<(typeof SESSION_FIELDS)[number], string | null>>;

const LOCALE_COOKIE_OPTIONS = {
  path: '/',
  maxAge: 31536000,
  sameSite: 'lax',
} as const;

export function withSecurityHeaders(response: Response, setCookie?: string): Response {
  // 101 responses carry a WebSocket and cannot be reconstructed with new headers.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of SECURITY_HEADERS) {
    if (!headers.has(name)) headers.set(name, value);
  }

  // SSR HTML is built with the viewer's Accept-Language and cookies (which are
  // forwarded to the internal API). Caches must neither share it keyed only on
  // the URL nor ignore the header that selected its locale/translations.
  // Data endpoints (which already set Cache-Control) keep their own policy.
  if ((headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
    const vary = headers.get('vary');
    if (!vary) headers.set('vary', 'Accept-Language');
    else if (!VARY_ACCEPT_LANGUAGE.test(vary)) headers.set('vary', `${vary}, Accept-Language`);
    if (!headers.has('cache-control')) headers.set('cache-control', 'private, no-store');
  }

  if (setCookie) headers.append('set-cookie', setCookie);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Static redirects live in `_redirects`; parameterised ones cannot be expressed
// there because adapter-cloudflare must list them in `_routes.json`.
export function legacyRedirect(pathname: string): { location: string; status: number } | null {
  let match = pathname.match(/^\/users\/([^/]+)\/inbox$/);
  if (match) return { location: `/api/actors/${match[1]}/inbox`, status: 308 };
  match = pathname.match(/^\/actors\/([^/]+)(\/(?:outbox|followers|following|liked|featured))?$/);
  if (match) return { location: `/api/actors/${match[1]}${match[2] ?? ''}`, status: 301 };
  match = pathname.match(/^\/notes\/([^/]+)$/);
  if (match) return { location: `/api/notes/${match[1]}`, status: 301 };
  return null;
}

const localeCache = new Map<string, Promise<LocaleData>>();
const localeStore = new AsyncLocalStorage<LocaleData>();

setLocaleResolver(() => localeStore.getStore() ?? null);

export function pickLocale(request: Request): string {
  // One cookie parser for SSR and hydration; malformed values are ignored.
  const fromCookie = localeFromCookie(request.headers.get('cookie') ?? '');
  if (fromCookie) return fromCookie;
  const accept = request.headers.get('accept-language') ?? '';
  return accept.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

/** Only rewrite the `lang` of the opening `<html>` tag, never page content. */
const HTML_LANG_EN = /(<html\b[^>]*?)(\slang="en")([^>]*>)/i;

export function applyHtmlLang(html: string, locale: string): string {
  if (typeof html !== 'string') return html;
  return html.replace(
    HTML_LANG_EN,
    (_match, before: string, _lang: string, after: string) => `${before} lang="${locale}"${after}`,
  );
}

/** JSON that cannot terminate the enclosing <script> or break JS line parsing. */
export function safeJson(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null';
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Replace the single SSR marker with an inert JSON block. `session === undefined`
 * means "unknown" (transient failure); the key is omitted so clients can retry.
 */
export function injectBootData(html: string, locale: LocaleData, session: unknown): string {
  if (typeof html !== 'string') return html;
  const payload = {
    locale: {
      locale: locale.locale,
      strings: { ...locale.fallback, ...locale.strings },
    },
    ...(session === undefined ? {} : { session }),
  };
  return html.replace(
    BOOT_DATA_MARKER,
    `<script type="application/json" id="__flaxia_boot__">${safeJson(payload)}</script>`,
  );
}

/** Only real document navigations get viewer-specific boot data. */
function isDocumentNavigation(event: Parameters<Handle>[0]['event']): boolean {
  // The native build has no server at runtime; its static fallback must keep
  // the marker so the client takes the original /api/me path.
  if (import.meta.env.BUILD_TARGET === 'native') return false;
  if (event.request.method !== 'GET') return false;
  if (event.url.pathname.startsWith('/api/')) return false;
  if ((event.request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') return false;
  if (event.request.headers.get('sec-fetch-dest') === 'document') return true;
  return (event.request.headers.get('accept') ?? '').toLowerCase().includes('text/html');
}

async function loadBootSession(event: Parameters<Handle>[0]['event']): Promise<BootSession | null | undefined> {
  try {
    const response = await event.fetch('/api/me', { signal: AbortSignal.timeout(1200) });
    if (response.status === 401) return null;
    if (!response.ok) return undefined;
    const body = (await response.json()) as { user?: Record<string, unknown> };
    const user = body?.user;
    if (!user || typeof user !== 'object') return undefined;
    const session: BootSession = {};
    for (const field of SESSION_FIELDS) {
      const value = user[field];
      if (typeof value === 'string' || value === null) session[field] = value;
    }
    return session;
  } catch {
    // A timeout or gateway error must not be interpreted as a signed-out user.
    return undefined;
  }
}

/** Cloudflare Pages serves auto-generated `*.pages.dev` hostnames publicly. */
export function isPreviewHostname(hostname: string): boolean {
  if (typeof hostname !== 'string') return false;
  // DNS root dots, whitespace and casing are not meaningful for this check.
  const normalized = hostname.trim().toLowerCase().replace(/\.+$/, '');
  return normalized.endsWith('.pages.dev');
}

function previewNotFound(): Response {
  return new Response(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>404 Not Found - Flaxia</title></head><body><main><h1>404</h1><p>Not Found</p></main></body></html>',
    {
      status: 404,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Robots-Tag': 'noindex',
      },
    },
  );
}

export async function loadLocale(locale: string, fetchFn: typeof fetch): Promise<LocaleData> {
  let promise = localeCache.get(locale);
  if (!promise) {
    promise = (async () => {
      const read = async (name: string): Promise<Record<string, string>> => {
        const response = await fetchFn(`/locales/${name}.json`);
        if (!response.ok) throw new Error(`Failed to load locale ${name}: ${response.status}`);
        return (await response.json()) as Record<string, string>;
      };
      const [strings, fallback] = await Promise.all([read(locale), read('en')]);
      return { locale, strings, fallback };
    })();
    localeCache.set(locale, promise);
    // A transient read failure must not be cached forever in this isolate.
    // Only a successful load remains in the map; the next request retries.
    void promise.catch(() => {
      if (localeCache.get(locale) === promise) localeCache.delete(locale);
    });
  }
  return promise;
}

// SvelteKit emits a `data-ttl` script for SSR subresponses with a max-age and
// seeds its client fetch cache from it during hydration, so later navigations
// to these routes reuse the serialized response with no network request. The
// TTL matches CLIENT_CACHE_TTL in src/lib/ssr-data.ts. Only public data is
// allowlisted; viewer-specific endpoints and mutations keep the API's headers.
const CACHEABLE_SSR_GET = [
  /^\/api\/posts\/?$/,
  /^\/api\/posts\/recommended\/?$/,
  /^\/api\/posts\/[^/]+\/thread\/?$/,
  /^\/api\/posts\/[^/]+\/replies\/?$/,
  /^\/api\/users\/[^/]+\/?$/,
  /^\/api\/games\/?$/,
];

export const handleFetch: HandleFetch = async ({ event, request, fetch }) => {
  const response = await fetch(request);
  if (request.method !== 'GET') return response;

  const url = new URL(request.url);
  if (url.origin !== event.url.origin || !CACHEABLE_SSR_GET.some((pattern) => pattern.test(url.pathname))) {
    return response;
  }

  // Clone with fresh headers: the public API handler's response must not be
  // mutated, and the exact private max-age replaces any upstream policy.
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, max-age=10');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const handle: Handle = async ({ event, resolve }) => {
  if (isPreviewHostname(event.url.hostname)) {
    return withSecurityHeaders(previewNotFound());
  }

  const redirect = legacyRedirect(event.url.pathname);
  if (redirect) {
    return withSecurityHeaders(
      new Response(null, {
        status: redirect.status,
        headers: { Location: `${redirect.location}${event.url.search}` },
      }),
    );
  }

  const localeName = pickLocale(event.request);
  // Start the bounded session read alongside the locale read so a slow auth
  // chain does not add a second serial network hop to every document request.
  const wantsBootData = isDocumentNavigation(event);
  const sessionPromise = wantsBootData ? loadBootSession(event) : Promise.resolve(undefined);
  // A missing/corrupt locale asset must degrade to translation keys, never 500.
  const locale = await loadLocale(localeName, event.fetch).catch(
    (): LocaleData => ({ locale: localeName, strings: {}, fallback: {} }),
  );
  const session = await sessionPromise;
  const response = await localeStore.run(locale, () =>
    resolve(event, {
      transformPageChunk: ({ html }) => injectBootData(applyHtmlLang(html, localeName), locale, session),
    }),
  );

  // The first paint must match the locale SSR picked, but only a rendered HTML
  // page is allowed to persist it. Data endpoints (sitemap.xml, WebFinger,
  // host-meta, /api/*) can be publicly cached; a Set-Cookie there would let an
  // edge cache replay one visitor's locale to everyone. A 101 upgrade must not
  // be reconstructed or gain headers at all.
  const isApiOrSocket = event.url.pathname.startsWith('/api/') || event.request.headers.get('upgrade') === 'websocket';
  const isHtmlPage = (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
  const persistedLocale = localeFromCookie(event.request.headers.get('cookie') ?? '');
  const shouldPersistLocale = !isApiOrSocket && response.status !== 101 && isHtmlPage && !persistedLocale;

  // Boot-bearing HTML embeds viewer-specific session data, so caches must not
  // reuse it across Cookie values. Keep every other response policy untouched.
  let pageResponse = response;
  if (wantsBootData && isHtmlPage && response.status !== 101 && !VARY_COOKIE.test(response.headers.get('vary') ?? '')) {
    const headers = new Headers(response.headers);
    const vary = headers.get('vary');
    headers.set('vary', vary ? `${vary}, Cookie` : 'Cookie');
    pageResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  let setCookie: string | undefined;
  if (shouldPersistLocale) {
    // cookies.set() is illegal after resolve() (it breaks the native SPA's
    // prerendered fallback), and SvelteKit has already flushed pending cookies
    // by now. Serialize the value directly onto the final response instead.
    setCookie =
      typeof event.cookies.serialize === 'function'
        ? event.cookies.serialize('flaxia_locale', localeName, LOCALE_COOKIE_OPTIONS)
        : `flaxia_locale=${encodeURIComponent(localeName)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;
  }
  return withSecurityHeaders(pageResponse, setCookie);
};
