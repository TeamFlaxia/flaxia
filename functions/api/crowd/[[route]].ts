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

      if (status === 'done' && (result as any)?.output?.[0]) {
        const output = (result as any).output[0] as { label: string; score: number };
        const labelScoreMap: Record<string, number> = {
          very_negative: 0.0,
          negative: 0.25,
          neutral: 0.5,
          positive: 0.75,
          very_positive: 1.0,
        };
        const score = labelScoreMap[output.label] ?? output.score;
        const db = (context.env as any).DB;
        const row = (await db.prepare('SELECT id FROM posts WHERE sentiment_task_id = ?').bind(taskId).first()) as {
          id: string;
        } | null;
        const postId = row?.id;
        if (postId) {
          await db.prepare('UPDATE posts SET sentiment_score = ? WHERE id = ?').bind(score, postId).run();
          console.log(`Sentiment webhook done for post ${postId}: label=${output.label}, score=${score}`);
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
