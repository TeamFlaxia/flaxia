export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['X-Frame-Options', 'DENY'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
  [
    'Content-Security-Policy',
    "default-src 'self'; object-src 'none'; base-uri 'self'; worker-src 'self' blob: https://flaxia.app; connect-src 'self' https: wss: blob:; img-src * blob: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com blob:; font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net https://unpkg.com https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net https://www.google.com https://www.googletagmanager.com https://www.google-analytics.com; media-src 'self' https: blob:; frame-src 'self' blob: https://*.flaxia.app https://googleads.g.doubleclick.net https://www.youtube.com https://ep2.adtrafficquality.google https://www.google.com; frame-ancestors 'self'",
  ],
];

export function applySecurityHeaders(response: Response): Response {
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
