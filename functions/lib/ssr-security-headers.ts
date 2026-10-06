const CSP_SCRIPT_HASHES = [
  // index.html theme, locale, analytics, and initial-loader bootstraps
  "'sha256-fHNVwPbW99e+pMNlG6l4u/Qa4ZXgCiY4NEErpg7xNKA='",
  "'sha256-8UZ1xbdoEGBJfbCFW7UdTEkjFZkH/d+8yO/eZ/JEOM0='",
  "'sha256-vUuU2Vr0x5KLfztNEae0/JgoGKIsMgHAm8i3fMzvHZo='",
  "'sha256-lf+0nM1TqVv41CHz3DTo1q7DzxErxegCLlYtVBZlTWg='",
  // Trusted SWF/Ruffle bootstrap, AdSense iframe bootstrap, and legacy sandbox wrapper.
  "'sha256-2noITtBmjNoi295cUQM1dJ7ioF61E0NeKuweqwK4O1M='",
  "'sha256-L9NtTqBLxf1z3sIza7z/JTtm01m91a8xVl07p4WTMYw='",
  "'sha256-9jpcqwJpr7kicF5b0vRUbAJtyA6CqjotdcnTjIv8i4U='",
].join(' ');

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; object-src 'none'; base-uri 'self'; worker-src 'self' blob: https://flaxia.app; connect-src 'self' https: wss: blob:; img-src * blob: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com blob:; font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com blob:; script-src 'self' " +
  CSP_SCRIPT_HASHES +
  " 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net https://unpkg.com https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net https://www.google.com https://www.googletagmanager.com https://www.google-analytics.com; script-src-attr 'none'; media-src 'self' https: blob:; frame-src 'self' blob: https://*.flaxia.app https://googleads.g.doubleclick.net https://www.youtube.com https://ep2.adtrafficquality.google https://www.google.com; frame-ancestors 'self'";

export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['X-Frame-Options', 'DENY'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
  ['Content-Security-Policy', CONTENT_SECURITY_POLICY],
];

export function applySecurityHeaders(response: Response, _pathname = '/'): Response {
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
