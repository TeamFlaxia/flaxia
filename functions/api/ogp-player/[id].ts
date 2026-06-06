type Env = {
  DB: D1Database;
  BASE_URL?: string;
};

export async function onRequest(context: { request: Request; env: Env; params: { id: string } }): Promise<Response> {
  const { env, params } = context;
  const baseUrl = env.BASE_URL ?? 'https://flaxia.app';
  const postId = params.id;

  if (!postId) {
    return new Response('Missing post ID', { status: 400 });
  }

  try {
    const result: Record<string, unknown> | null = (await env.DB.prepare(
      `SELECT payload_key, swf_key, thumbnail_key FROM posts WHERE id = ? AND status = 'published' AND hidden = 0`,
    )
      .bind(postId)
      .first()) as Record<string, unknown> | null;

    if (!result) {
      return new Response('Post not found', { status: 404 });
    }

    const swfKey = String(result.swf_key || '');
    const payloadKey = String(result.payload_key || '');

    if (swfKey) {
      return serveSwfPlayer(postId, baseUrl);
    }

    if (payloadKey.startsWith('dos/')) {
      return serveDosPlayer(postId, baseUrl);
    }

    if (payloadKey) {
      return serveZipPlayer(postId);
    }

    return new Response('No game found', { status: 404 });
  } catch (error) {
    console.error('OGP player error:', error);
    return new Response('Internal error', { status: 500 });
  }
}

function serveZipPlayer(postId: string): Response {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="robots" content="noindex">
  <title>Game</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
    iframe { width: 100%; height: 100%; border: none; }
  </style>
</head>
<body>
  <iframe src="https://sandbox.flaxia.app/api/wvfs-zip/${postId}"
    sandbox="allow-scripts allow-pointer-lock allow-fullscreen allow-same-origin"
    allow="fullscreen"
    referrerpolicy="no-referrer"></iframe>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

function serveSwfPlayer(postId: string, baseUrl: string): Response {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="robots" content="noindex">
  <title>Flash Game</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
  </style>
  <script src="https://unpkg.com/@ruffle-rs/ruffle"></script>
</head>
<body>
  <embed src="${baseUrl}/api/swf/${postId}"
    style="width:100%;height:100%"
    type="application/x-shockwave-flash">
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

function serveDosPlayer(postId: string, baseUrl: string): Response {
  return Response.redirect(`${baseUrl}/api/dos-player/${postId}`, 302);
}
