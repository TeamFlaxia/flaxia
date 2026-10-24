import { isFirstPartyApiUrl, isNativeApp, isTauriNativePlatform, nativeApiUrl } from './native-api.ts';

type TauriFetch = typeof import('@tauri-apps/plugin-http').fetch;
type CapacitorRequest = typeof import('@capacitor/core').CapacitorHttp.request;

function hideSessionHeaders(response: Response, url = response.url): Response {
  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  headers.delete('set-cookie2');
  const result = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

/** Preserve Request + init semantics, including multipart bodies and aborts. */
export function createNativeFetch(
  browserFetch: typeof fetch,
  loadTauriFetch: () => Promise<TauriFetch> = async () => (await import('@tauri-apps/plugin-http')).fetch,
  loadCapacitorHttp: () => Promise<{ request: CapacitorRequest; platform: string }> = async () => {
    const { Capacitor, CapacitorHttp } = await import('@capacitor/core');
    return { request: (options) => CapacitorHttp.request(options), platform: Capacitor.getPlatform() };
  },
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString(), window.location.href);
    if (!isNativeApp() || !isFirstPartyApiUrl(url)) return browserFetch(input, init);
    const request = new Request(nativeApiUrl(input), init);
    if (!isTauriNativePlatform()) {
      if (request.method === 'GET' || request.method === 'HEAD') {
        // Capacitor's fetch GET path is a WebView-local proxy, unlike mutations.
        // Use the plugin directly so reads share the native jar and timeouts,
        // and do not depend on browser proxy/encoding behavior.
        const http = await loadCapacitorHttp();
        if (request.signal.aborted) throw new DOMException('The request was aborted', 'AbortError');
        const headers = new Headers(request.headers);
        let abort: () => void = () => {};
        try {
          const response = await Promise.race([
            http.request({
              url: request.url,
              method: request.method,
              headers: Object.fromEntries(headers),
              responseType: 'arraybuffer',
              disableRedirects: true,
              connectTimeout: 10000,
              readTimeout: 30000,
            }),
            new Promise<never>((_, reject) => {
              abort = () => reject(new DOMException('The request was aborted', 'AbortError'));
              request.signal.addEventListener('abort', abort, { once: true });
            }),
          ]);
          if (request.signal.aborted) throw new DOMException('The request was aborted', 'AbortError');
          const responseHeaders = new Headers(response.headers);
          const json = (responseHeaders.get('Content-Type') ?? '').includes('application/json');
          let body: BodyInit | null = null;
          if (request.method !== 'HEAD' && ![204, 205, 304].includes(response.status)) {
            if (json || typeof response.data !== 'string') body = JSON.stringify(response.data);
            else if (response.status >= 400 && http.platform === 'android') body = response.data;
            else body = Uint8Array.from(atob(response.data), (character) => character.charCodeAt(0));
          }
          responseHeaders.delete('Content-Encoding');
          responseHeaders.delete('Content-Length');
          return hideSessionHeaders(
            new Response(body, { status: response.status, headers: responseHeaders }),
            response.url,
          );
        } finally {
          request.signal.removeEventListener('abort', abort);
        }
      }
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
      return hideSessionHeaders(
        await browserFetch(request.url, {
          method: request.method,
          headers,
          body,
          credentials: 'include',
          signal: request.signal,
          redirect: request.redirect,
          cache: request.cache,
        }),
      );
    }
    const nativeFetch = await loadTauriFetch();
    const response = await nativeFetch(request, {
      signal: request.signal,
      maxRedirections: 0,
      connectTimeout: 10000,
    });
    // Match browser fetch: session cookies stay in the native jar, not JS.
    return hideSessionHeaders(response);
  };
}
