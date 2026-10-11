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
  // Capacitor's Android build uses `androidScheme: 'https'`, so the WebView
  // protocol is `https:` rather than `capacitor:`. Detecting the native app by
  // protocol alone misses the Android build and routes API calls to
  // https://localhost, which has no server. The Capacitor native-platform flag
  // is the reliable signal.
  return (
    isCapacitorNativePlatform() || (typeof window !== 'undefined' && window.location.protocol.startsWith('capacitor'))
  );
}

export function nativeApiUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (!isNativeApp()) return input;

  const requestInput = input as RequestInfo | URL;
  let url: URL;
  if (typeof requestInput === 'string' || requestInput instanceof URL) {
    url = new URL(requestInput.toString(), window.location.href);
  } else {
    url = new URL(requestInput.url, window.location.href);
  }

  if (!url.pathname.startsWith('/api/')) return input;
  const destination = new URL(`${API_ORIGIN}${url.pathname}${url.search}${url.hash}`);
  if (requestInput instanceof Request) {
    const headers = new Headers(requestInput.headers);
    headers.set('X-Flaxia-Native-App', '1');
    return new Request(destination, {
      method: requestInput.method,
      headers,
      body: requestInput.body,
      credentials: requestInput.credentials,
      cache: requestInput.cache,
      mode: requestInput.mode,
      redirect: requestInput.redirect,
      referrer: requestInput.referrer,
      referrerPolicy: requestInput.referrerPolicy,
      integrity: requestInput.integrity,
      keepalive: requestInput.keepalive,
      signal: requestInput.signal,
    });
  }
  if (typeof requestInput === 'string' || requestInput instanceof URL) return destination.href;
  const init = requestInput as RequestInit;
  const headers = new Headers(init.headers);
  headers.set('X-Flaxia-Native-App', '1');
  return new Request(destination, { ...init, headers });
}
