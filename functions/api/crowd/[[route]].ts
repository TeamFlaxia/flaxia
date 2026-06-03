const UPSTREAM = 'https://unpkg.com/@flaxia/node@0.1.2/dist';
const MIME: Record<string, string> = {
  js: 'application/javascript',
  wasm: 'application/wasm',
  json: 'application/json',
};

export async function onRequest(context: {
  request: Request;
  env: Record<string, unknown>;
  waitUntil(p: Promise<unknown>): void;
}) {
  const url = new URL(context.request.url);
  const method = context.request.method;
  const path = url.pathname.replace(/^\/api\/crowd\//, '');

  if (method === 'POST' && path === 'webhook') {
    try {
      const body = (await context.request.json()) as Record<string, unknown>;
      const { taskId, status, result, error } = body;
      if (!taskId) return new Response('Bad Request', { status: 400 });

      if (status === 'done') {
        const resultObj = result as Record<string, unknown> | undefined;
        const output = resultObj?.output;

        if (output) {
          const starScoreMap: Record<string, number> = {
            '1 star': 0.0,
            '2 stars': 0.25,
            '3 stars': 0.5,
            '4 stars': 0.75,
            '5 stars': 1.0,
          };

          let score: number | undefined;

          if (Array.isArray(output)) {
            let total = 0;
            for (const item of output) {
              const entry = item as { label: string; score: number } | undefined;
              if (entry?.label && typeof entry.score === 'number') {
                total += (starScoreMap[entry.label] ?? 0.5) * entry.score;
              }
            }
            score = total;
          } else {
            const entry = output as { label: string; score: number } | undefined;
            if (entry?.label && typeof entry.score === 'number') {
              score = starScoreMap[entry.label] ?? entry.score;
            }
          }

          const db = (context.env as { DB: D1Database }).DB;
          const row = await db
            .prepare('SELECT id FROM posts WHERE sentiment_task_id = ?')
            .bind(taskId)
            .first<{ id: string }>();
          const postId = row?.id;
          if (postId && score !== undefined) {
            await db.prepare('UPDATE posts SET sentiment_score = ? WHERE id = ?').bind(score, postId).run();
            console.log(`Sentiment webhook done for post ${postId}: score=${score}`);
          }
        }
      } else if (status === 'failed') {
        console.log(`Sentiment task failed: taskId=${taskId}, error=${error || 'unknown'}`);
      }

      return new Response(JSON.stringify({ received: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      console.error('Webhook error:', e);
      return new Response(JSON.stringify({ received: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  if (method !== 'GET') {
    return new Response('Not Found', { status: 404 });
  }

  const upstream = `${UPSTREAM}/${path}`;
  try {
    const res = await fetch(upstream);
    const ext = path.split('.').pop() || '';
    const body = await res.arrayBuffer();
    return new Response(body, {
      status: res.status,
      headers: {
        'Content-Type': MIME[ext] || 'application/javascript',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    console.error('Crowd proxy error:', e);
    return new Response('Proxy error', { status: 502 });
  }
}
