const API_ORIGIN = 'https://flaxia.app';

function isNativeApp(): boolean {
  return typeof window !== 'undefined' && window.location.protocol.startsWith('capacitor');
}

export function nativeApiUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (!isNativeApp()) return input;

  let url: URL;
  if (typeof input === 'string' || input instanceof URL) {
    url = new URL(input.toString(), window.location.href);
  } else {
    url = new URL(input.url, window.location.href);
  }

  if (!url.pathname.startsWith('/api/')) return input;
  const destination = new URL(`${API_ORIGIN}${url.pathname}${url.search}${url.hash}`);
  if (typeof input === 'string' || input instanceof URL) return destination.href;
  if (input instanceof Request) {
    const headers = new Headers(input.headers);
    headers.set('X-Flaxia-Native-App', '1');
    if (input.method === 'GET' || input.method === 'HEAD') {
      return new Request(destination, { method: input.method, headers });
    }
    const rewritten = new Request(destination, input);
    rewritten.headers.set('X-Flaxia-Native-App', '1');
    return rewritten;
  }
  return destination.href;
}
