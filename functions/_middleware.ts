import { applySecurityHeaders } from './lib/ssr-security-headers.ts';

function renderNotFoundPage(): Response {
  return new Response(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>404 Not Found - Flaxia</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#0f1115;color:#e6e6e6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}main{text-align:center;padding:24px}h1{font-size:48px;margin:0 0 8px}p{color:#9ca3af}</style></head><body><main><h1>404</h1><p>Not Found</p></main></body></html>',
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

export async function onRequest(context: {
  request: Request;
  env: Record<string, unknown>;
  next: () => Promise<Response>;
}): Promise<Response> {
  // Cloudflare Pages の自動生成ドメイン (*.pages.dev) 経由では動作させない
  const url = new URL(context.request.url);
  const hostname = url.hostname;
  if (hostname.endsWith('.pages.dev')) {
    return applySecurityHeaders(renderNotFoundPage(), url.pathname);
  }

  return applySecurityHeaders(await context.next(), url.pathname);
}
