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

      const callbackType = url.searchParams.get('type');
      const db = (context.env as { DB: D1Database }).DB;

      if (status === 'done') {
        const resultObj = result as Record<string, unknown> | undefined;
        const output = resultObj?.output;

        if (callbackType === 'translation') {
          if (!output) {
            return new Response(JSON.stringify({ received: true }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          const postId = url.searchParams.get('postId');
          const lang = url.searchParams.get('lang');
          if (postId && lang) {
            const translationText = Array.isArray(output)
              ? (output[0] as Record<string, unknown> | undefined)?.translation_text
              : (output as Record<string, unknown> | undefined)?.translation_text;
            if (typeof translationText === 'string') {
              await db
                .prepare('UPDATE post_translations SET translated_text = ? WHERE post_id = ? AND language = ?')
                .bind(translationText, postId, lang)
                .run();
              console.log(`Translation webhook done for post ${postId} → ${lang}`);
            }
          }
        } else if (callbackType === 'vector-embed') {
          const postId = url.searchParams.get('postId');
          const vectorResult = (output && typeof output === 'object' ? output : resultObj) as
            | Record<string, unknown>
            | undefined;
          if (postId && vectorResult) {
            const vector = vectorResult.vector as number[] | undefined;
            const model = (vectorResult.model as string) || 'Qwen/Qwen3-Embedding-0.6B';
            const dimensions = (vectorResult.dimensions as number) || 1024;
            if (vector && Array.isArray(vector)) {
              const vectorize = (context.env as Record<string, unknown>).VECTORIZE as
                | { upsert(vectors: Array<{ id: string; values: number[] }>): Promise<unknown> }
                | undefined;
              if (vectorize) {
                try {
                  await vectorize.upsert([{ id: postId, values: vector }]);
                } catch (ve) {
                  console.error('Vectorize upsert failed:', ve);
                }
              }
              await db
                .prepare(
                  'INSERT OR REPLACE INTO post_embeddings (post_id, embedding, model, dimensions) VALUES (?, ?, ?, ?)',
                )
                .bind(postId, JSON.stringify(vector), model, dimensions)
                .run();
              console.log(`Vector embed webhook done for post ${postId}: dims=${dimensions}`);
            }
          }
        }
      } else if (status === 'failed') {
        console.log(`Task failed: taskId=${taskId}, type=${callbackType || 'unknown'}, error=${error || 'unknown'}`);
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
        'Access-Control-Allow-Origin': 'https://flaxia.app',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    console.error('Crowd proxy error:', e);
    return new Response('Proxy error', { status: 502 });
  }
}
