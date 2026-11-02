export const API_ORIGIN = 'https://flaxia.app';

/**
 * Flaxia service origins that need the native cookie-jar transport. Keep this
 * list in sync with the `http:default` allow list in
 * `src-tauri/capabilities/default.json`; tests assert both sides match.
 */
export const NATIVE_SERVICE_API_ORIGINS = ['https://auth.flaxia.app'] as const;

const NATIVE_SERVICE_API_ORIGIN_SET = new Set<string>(NATIVE_SERVICE_API_ORIGINS);

export function isTauriNativePlatform(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);
}

export function isCapacitorNativePlatform(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.Capacitor !== 'undefined' &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform()
  );
}

export function isNativeApp(): boolean {
  return (
    isCapacitorNativePlatform() ||
    isTauriNativePlatform() ||
    (typeof window !== 'undefined' && window.location.protocol.startsWith('capacitor'))
  );
}

/** Only app-relative / first-party API URLs may use the native transport. */
export function isFirstPartyApiUrl(url: URL): boolean {
  const appUrl = new URL(typeof window === 'undefined' ? API_ORIGIN : window.location.href);
  return (
    url.pathname.startsWith('/api/') &&
    (url.origin === API_ORIGIN || (url.host === appUrl.host && url.protocol === appUrl.protocol))
  );
}

/**
 * Allowlisted Flaxia service origins (auth.flaxia.app, etc.) are reachable
 * through the native HTTP plugin. Their browser CORS policy only trusts
 * flaxia.app, so routing them through the browser would break desktop sign-in.
 * The sandbox and arbitrary subdomains stay on the browser transport.
 */
function isFlaxiaServiceApiUrl(url: URL): boolean {
  return url.protocol === 'https:' && NATIVE_SERVICE_API_ORIGIN_SET.has(url.origin) && url.pathname.startsWith('/api/');
}

export function isNativeApiUrl(url: URL): boolean {
  return isFlaxiaServiceApiUrl(url) || isFirstPartyApiUrl(url);
}

/** Resolve first-party API paths for native apps; allowlisted service origins stay absolute. */
export function nativeApiHref(input: string | URL): string {
  const url = new URL(input.toString(), typeof window === 'undefined' ? API_ORIGIN : window.location.href);
  if (isNativeApp() && isNativeApiUrl(url)) {
    return isFlaxiaServiceApiUrl(url) ? url.href : `${API_ORIGIN}${url.pathname}${url.search}${url.hash}`;
  }
  return input instanceof URL || /^[a-z][a-z\d+.-]*:/i.test(input)
    ? url.href
    : `${url.pathname}${url.search}${url.hash}`;
}

export function nativeApiUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (!isNativeApp()) return input;

  const requestInput = input as RequestInfo | URL;
  const requestUrl = requestInput instanceof Request ? requestInput.url : requestInput.toString();
  const url = new URL(requestUrl, window.location.href);
  if (!isNativeApiUrl(url)) return input;
  const destination = new URL(nativeApiHref(url));
  if (requestInput instanceof Request) return new Request(destination, requestInput);
  if (typeof requestInput === 'string' || requestInput instanceof URL) return destination.href;
  return new Request(destination, requestInput as RequestInit);
}
