import { AsyncLocalStorage } from 'node:async_hooks';
import type { Handle } from '@sveltejs/kit/hooks';
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

export function withSecurityHeaders(response: Response): Response {
  // 101 responses carry a WebSocket and cannot be reconstructed with new headers.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of SECURITY_HEADERS) {
    if (!headers.has(name)) headers.set(name, value);
  }
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

async function loadLocale(locale: string, fetchFn: typeof fetch): Promise<LocaleData> {
  let promise = localeCache.get(locale);
  if (!promise) {
    promise = (async () => {
      const read = async (name: string): Promise<Record<string, string>> => {
        try {
          const response = await fetchFn(`/locales/${name}.json`);
          if (!response.ok) return {};
          return (await response.json()) as Record<string, string>;
        } catch {
          return {};
        }
      };
      const [strings, fallback] = await Promise.all([read(locale), read('en')]);
      return { locale, strings, fallback };
    })();
    localeCache.set(locale, promise);
  }
  return promise;
}

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
  const locale = await loadLocale(localeName, event.fetch);
  const response = await localeStore.run(locale, () =>
    resolve(event, { transformPageChunk: ({ html }) => applyHtmlLang(html, localeName) }),
  );
  return withSecurityHeaders(response);
};
