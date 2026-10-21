const API_ORIGIN = 'https://flaxia.app';

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
    isCapacitorNativePlatform() || (typeof window !== 'undefined' && window.location.protocol.startsWith('capacitor'))
  );
}

/** Resolve API paths to the first-party origin for native Capacitor apps. */
export function nativeApiHref(input: string | URL): string {
  const url = new URL(input.toString(), typeof window === 'undefined' ? API_ORIGIN : window.location.href);
  if (isNativeApp() && url.pathname.startsWith('/api/')) {
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
  if (!url.pathname.startsWith('/api/')) return input;
  const destination = new URL(nativeApiHref(url));
  if (requestInput instanceof Request) return new Request(destination, requestInput);
  if (typeof requestInput === 'string' || requestInput instanceof URL) return destination.href;
  return new Request(destination, requestInput as RequestInit);
}
