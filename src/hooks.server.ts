import { AsyncLocalStorage } from 'node:async_hooks';
import type { Handle } from '@sveltejs/kit/hooks';
import { type LocaleData, setLocaleResolver } from './lib/i18n.ts';

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

const LOCALE_COOKIE = 'flaxia_locale';
const SUPPORTED_LOCALES = new Set(['en', 'ja']);
const localeCache = new Map<string, Promise<LocaleData>>();
const localeStore = new AsyncLocalStorage<LocaleData>();

setLocaleResolver(() => localeStore.getStore() ?? null);

function pickLocale(request: Request): string {
  const cookie = request.headers.get('cookie') ?? '';
  const stored = cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`))?.[1];
  if (stored && SUPPORTED_LOCALES.has(decodeURIComponent(stored))) return decodeURIComponent(stored);
  const accept = request.headers.get('accept-language') ?? '';
  return accept.toLowerCase().startsWith('ja') ? 'ja' : 'en';
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
  const redirect = legacyRedirect(event.url.pathname);
  if (redirect) {
    return withSecurityHeaders(
      new Response(null, {
        status: redirect.status,
        headers: { Location: `${redirect.location}${event.url.search}` },
      }),
    );
  }

  const locale = await loadLocale(pickLocale(event.request), event.fetch);
  const response = await localeStore.run(locale, () => resolve(event));
  return withSecurityHeaders(response);
};
