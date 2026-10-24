export const API_ORIGIN = 'https://flaxia.app';

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

/** Resolve API paths to the first-party origin for bundled native apps. */
export function nativeApiHref(input: string | URL): string {
  const url = new URL(input.toString(), typeof window === 'undefined' ? API_ORIGIN : window.location.href);
  if (isNativeApp() && isFirstPartyApiUrl(url)) {
    return `${API_ORIGIN}${url.pathname}${url.search}${url.hash}`;
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
  if (!isFirstPartyApiUrl(url)) return input;
  const destination = new URL(nativeApiHref(url));
  if (requestInput instanceof Request) return new Request(destination, requestInput);
  if (typeof requestInput === 'string' || requestInput instanceof URL) return destination.href;
  return new Request(destination, requestInput as RequestInit);
}
