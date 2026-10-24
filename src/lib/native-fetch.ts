import { isFirstPartyApiUrl, isNativeApp, isTauriNativePlatform, nativeApiUrl } from './native-api.ts';

type TauriFetch = typeof import('@tauri-apps/plugin-http').fetch;

/** Preserve Request + init semantics, including multipart bodies and aborts. */
export function createNativeFetch(
  browserFetch: typeof fetch,
  loadTauriFetch: () => Promise<TauriFetch> = async () => (await import('@tauri-apps/plugin-http')).fetch,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString(), window.location.href);
    if (!isNativeApp() || !isFirstPartyApiUrl(url)) return browserFetch(input, init);
    const request = new Request(nativeApiUrl(input), init);
    if (!isTauriNativePlatform()) {
      // Capacitor's bridge must receive the actual FormData/File. Passing a
      // Request body stream makes its converter decode binary multipart data
      // as text, corrupting uploads. Reconstruct the body before bridging.
      const headers = new Headers(request.headers);
      let body: BodyInit | undefined;
      if (request.body) {
        const type = headers.get('Content-Type') ?? '';
        if (type.startsWith('multipart/form-data')) {
          body = await request.formData();
          headers.delete('Content-Type');
        } else if (
          type.includes('json') ||
          type.startsWith('text/') ||
          type.startsWith('application/x-www-form-urlencoded')
        ) {
          body = await request.text();
        } else {
          const blob = await request.blob();
          body = new File([blob], 'upload', { type: blob.type });
        }
      }
      return browserFetch(request.url, {
        method: request.method,
        headers,
        body,
        credentials: 'include',
        signal: request.signal,
        redirect: request.redirect,
        cache: request.cache,
      });
    }
    const nativeFetch = await loadTauriFetch();
    const response = await nativeFetch(request, {
      signal: request.signal,
      maxRedirections: 0,
      connectTimeout: 10000,
    });
    // Match browser fetch: session cookies stay in the native jar, not JS.
    const headers = new Headers(response.headers);
    headers.delete('set-cookie');
    headers.delete('set-cookie2');
    const result = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    Object.defineProperty(result, 'url', { value: response.url });
    return result;
  };
}
