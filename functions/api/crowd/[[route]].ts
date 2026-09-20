// Serve the browser node SDK from a pinned, immutable version. 0.3.4 gates heavy
// WASM workloads behind a real measured WebAssembly.Memory probe: devices that
// cannot actually commit >= 2GB now register with empty capabilities, so the
// orchestrator routes nothing to them and the worker rejects every task before
// any model is loaded. The versioned path segment in client imports
// (e.g. /api/crowd/v0.3.4-0) is a cache-busting prefix stripped below.
const UPSTREAM = 'https://unpkg.com/@flaxia/node@0.3.4/dist';
const MIME: Record<string, string> = {
  js: 'application/javascript',
  wasm: 'application/wasm',
  json: 'application/json',
};

import type { NudeNetDetection } from '@flaxia/sdk';
import type { LinUCBConfig } from '../../lib/linucb';
import { createProjection, parseBanditConfig, projConfigKey, project } from '../../lib/linucb';
import { applyNsfwTags, resolveNsfwTags } from '../../lib/nsfw';

const BANDIT_CONFIG_KEY = 'arcade:bandit:config';
const projectionCache = new Map<string, number[][]>();

function getProjection(config: LinUCBConfig): number[][] {
  const key = projConfigKey(config);
  let proj = projectionCache.get(key);
  if (!proj) {
    proj = createProjection(config.srcDim, config.dim, config.seed);
    projectionCache.set(key, proj);
  }
  return proj;
}

async function loadBanditConfig(env: Record<string, unknown>): Promise<LinUCBConfig> {
  const cache = env.CACHE as KVNamespace | undefined;
  if (!cache) return { ...parseBanditConfig(null) };
  try {
    return parseBanditConfig(await cache.get(BANDIT_CONFIG_KEY));
  } catch {
    return { ...parseBanditConfig(null) };
  }
}

export async function onRequest(context: {
  request: Request;
  env: Record<string, unknown>;
  waitUntil(p: Promise<unknown>): void;
}) {
  const url = new URL(context.request.url);
  const method = context.request.method;
  let path = url.pathname.replace(/^\/api\/crowd\//, '');

  // Strip a leading version segment (e.g. /api/crowd/v0.3.0/index.js) so clients
  // can cache-bust the immutable assets by bumping the versioned path.
  path = path.replace(/^v[^/]+\//, '');

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

        if (callbackType === 'nsfw') {
          const postId = url.searchParams.get('postId');
          const detections = (resultObj?.detections as NudeNetDetection[] | undefined) ?? [];
          if (postId) {
            const { nsfw, tags } = resolveNsfwTags(detections);
            const applied = await applyNsfwTags(db, postId, tags);
            await db
              .prepare(
                `INSERT INTO post_nsfw_scans (post_id, status, scanned_at) VALUES (?, 'done', ?)
                 ON CONFLICT(post_id) DO UPDATE SET status = 'done', scanned_at = excluded.scanned_at`,
              )
              .bind(postId, new Date().toISOString())
              .run();
            console.log(
              `NSFW webhook for post ${postId}: nsfw=${nsfw}, tags=${tags.join(',') || 'none'}, applied=${applied}`,
            );
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
              const banditConfig = await loadBanditConfig(context.env as Record<string, unknown>);
              const proj = getProjection(banditConfig);
              const projected = project(vector, proj);
              await db
                .prepare(
                  'INSERT OR REPLACE INTO post_embeddings (post_id, embedding, model, dimensions, bandit_vec, bandit_cfg) VALUES (?, ?, ?, ?, ?, ?)',
                )
                .bind(
                  postId,
                  JSON.stringify(vector),
                  model,
                  dimensions,
                  JSON.stringify(projected),
                  projConfigKey(banditConfig),
                )
                .run();
              console.log(`Vector embed webhook done for post ${postId}: dims=${dimensions}`);
            }
          }
        }
      } else if (status === 'failed') {
        console.log(`Task failed: taskId=${taskId}, type=${callbackType || 'unknown'}, error=${error || 'unknown'}`);
        if (callbackType === 'nsfw') {
          const postId = url.searchParams.get('postId');
          if (postId) {
            await db
              .prepare('UPDATE post_nsfw_scans SET status = ?, scanned_at = ? WHERE post_id = ?')
              .bind('failed', new Date().toISOString(), postId)
              .run();
          }
        }
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
