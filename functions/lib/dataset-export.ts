// Anonymized Arcade dwell-time dataset export for external RL training
// (e.g. contextual bandit regression or a sequence model over the feed).
//
// Privacy model:
//   - user_id and session_id are hashed with a rotating salt (stored in KV)
//   - post_id is hashed to keep identity consistency while not exposing IDs
//   - no free-text, email, bio, or other PII is ever selected
//   - output contains numeric features + the content embedding of each game
//
// Upload to HuggingFace is optional and fails gracefully: without HF_TOKEN or
// HF_REPO the artifact is still written to R2 (when available) and skipped.

import { eventReward } from './linucb.ts';

export const DATASET_CHECKPOINT_KEY = 'arcade:dataset:checkpoint';
export const DATASET_SALT_KEY = 'arcade:dataset:salt';

export interface DatasetRecord {
  user_id: string;
  session_id: string;
  post_id: string;
  game_type: string;
  position: number;
  event_type: string;
  dwell_ms: number;
  did_skip: number;
  is_fullscreen: number;
  swipe_velocity: number;
  hour: string;
  post_embedding: number[] | null;
  label: number;
}

export interface DatasetEventRow {
  user_id: string;
  session_id: string;
  post_id: string;
  position: number;
  event_type: string;
  dwell_ms: number;
  did_skip: number;
  is_fullscreen: number;
  swipe_velocity: number;
  game_type: string;
  created_at: string;
}

export interface ExportEnv {
  DB: D1Database;
  EXPORT_KV?: KVNamespace;
  EXPORT_BUCKET?: R2Bucket;
  HF_TOKEN?: string;
  HF_REPO?: string;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function anonymizeId(id: string, salt: string): Promise<string> {
  return (await sha256Hex(`${salt}:${id}`)).slice(0, 24);
}

export async function loadOrCreateSalt(kv: KVNamespace | undefined): Promise<string> {
  if (!kv) {
    // No KV means no persistent salt: mint an ephemeral one per run so
    // hashes are never derived under a publicly known constant. Records
    // from such a run are unlinkable across runs by design.
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const existing = await kv.get(DATASET_SALT_KEY);
  if (existing) return existing;
  const salt = crypto.randomUUID();
  await kv.put(DATASET_SALT_KEY, salt);
  return salt;
}

// Truncate a created_at timestamp to the top of the hour (ISO-8601 UTC).
export function truncateToHour(createdAt: string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return createdAt;
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export async function buildDatasetRecords(
  events: DatasetEventRow[],
  embeddings: Map<string, number[]>,
  salt: string,
): Promise<DatasetRecord[]> {
  const records: DatasetRecord[] = [];
  for (const event of events) {
    const embedding = embeddings.get(event.post_id) || null;
    records.push({
      user_id: await anonymizeId(event.user_id, salt),
      session_id: await anonymizeId(event.session_id, salt),
      post_id: await anonymizeId(event.post_id, salt),
      game_type: event.game_type,
      position: event.position,
      event_type: event.event_type,
      dwell_ms: event.dwell_ms,
      did_skip: event.did_skip,
      is_fullscreen: event.is_fullscreen,
      swipe_velocity: event.swipe_velocity,
      hour: truncateToHour(event.created_at),
      post_embedding: embedding,
      label: eventReward(event.event_type, event.dwell_ms),
    });
  }
  return records;
}

export function serializeRecords(records: DatasetRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
}

export const DATASET_CARD = `---
license: cc-by-4.0
task_categories:
  - text-scoring
tags:
  - reinforcement-learning
  - recommendation
  - dwell-time
language:
  - en
  - ja
---
# Flaxia Arcade dwell-time dataset

Anonymized interactions from the Flaxia Arcade (a TikTok/Shorts-style fullscreen
game feed). Each row is a single *shown game* within a user's browsing session,
including quick skips as negative feedback.

## Fields

- \`user_id\` — salted SHA-256 of the user id (consistent within a salt epoch)
- \`session_id\` — salted SHA-256 of the browsing session id
- \`post_id\` — salted SHA-256 of the game post id (consistent across users)
- \`game_type\` — zip | html5
- \`position\` — index within the session feed
- \`event_type\` — view | fresh | reply | fullscreen | share
- \`dwell_ms\` — time the game was shown
- \`did_skip\` — 1 when the game was skipped quickly (<2s)
- \`is_fullscreen\`, \`swipe_velocity\` — UI signals
- \`hour\` — event time truncated to the top of the hour (full precision is
  never exported: exact timestamps enable re-identification by joining
  public interaction times)
- \`post_embedding\` — 1024-d content embedding of the game
- \`label\` — reward used for RL (normalized dwell, or engagement boosts)

## Suggested use

Train a contextual bandit (LinUCB over \`post_embedding\`) or a sequence model
that predicts \`label\` and learns to maximize cumulative dwell across a feed.
`;

// Export one batch of events into a JSONL artifact. Returns the JSONL string.
export async function fetchBatchEvents(db: D1Database, since: string, limit: number): Promise<DatasetEventRow[]> {
  const rows = await db
    .prepare(
      `SELECT user_id, session_id, post_id, position, event_type, dwell_ms,
              did_skip, is_fullscreen, swipe_velocity, game_type, created_at
       FROM arcade_events
       WHERE created_at > ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(since, limit)
    .all<DatasetEventRow>();
  return rows.results || [];
}

export async function fetchEmbeddings(db: D1Database, postIds: string[]): Promise<Map<string, number[]>> {
  const embeddings = new Map<string, number[]>();
  if (postIds.length === 0) return embeddings;
  const chunkSize = 200;
  for (let i = 0; i < postIds.length; i += chunkSize) {
    const chunk = postIds.slice(i, i + chunkSize);
    const rows = await db
      .prepare(`SELECT post_id, embedding FROM post_embeddings WHERE post_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ post_id: string; embedding: string }>();
    for (const row of rows.results || []) {
      try {
        const v = JSON.parse(row.embedding);
        if (Array.isArray(v)) embeddings.set(row.post_id, v);
      } catch {
        /* skip */
      }
    }
  }
  return embeddings;
}

// Push a JSONL file + dataset card to a HuggingFace dataset repo.
// Fails gracefully: returns false when config is missing or upload errors.
export async function pushToHuggingFace(env: ExportEnv, jsonl: string, filename: string): Promise<boolean> {
  const token = env.HF_TOKEN;
  const repo = env.HF_REPO;
  if (!token || !repo) {
    console.log(`dataset-export: skipping HF upload (token=${token ? 'set' : 'missing'}, repo=${repo || 'missing'})`);
    return false;
  }

  const files: Array<{ name: string; content: string }> = [
    { name: filename, content: jsonl },
    { name: 'README.md', content: DATASET_CARD },
  ];

  try {
    for (const file of files) {
      const form = new FormData();
      form.append('file', new Blob([file.content], { type: 'application/json' }), file.name);
      form.append('commitMessage', `Export Arcade dwell dataset (${filename})`);
      const res = await fetch(`https://huggingface.co/api/datasets/${repo}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (!res.ok) {
        console.error(`dataset-export: HF upload failed for ${file.name}: ${res.status} ${await res.text()}`);
        return false;
      }
    }
    return true;
  } catch (error) {
    console.error('dataset-export: HF upload error:', (error as { message?: string })?.message || error);
    return false;
  }
}

export async function writeArtifact(env: ExportEnv, jsonl: string, filename: string): Promise<void> {
  if (!env.EXPORT_BUCKET) return;
  try {
    await env.EXPORT_BUCKET.put(`datasets/arcade-dwell/${filename}`, jsonl, {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch (error) {
    console.error('dataset-export: R2 artifact write failed:', (error as { message?: string })?.message || error);
  }
}

// Orchestrates one export run. Returns the number of records exported (0 if
// skipped/empty). Resumable via a KV checkpoint of the last exported timestamp.
export async function runDatasetExport(env: ExportEnv, maxRecords = 50000): Promise<number> {
  const checkpointJson = env.EXPORT_KV ? await env.EXPORT_KV.get(DATASET_CHECKPOINT_KEY) : null;
  let since = '1970-01-01T00:00:00.000Z';
  if (checkpointJson) {
    try {
      since = (JSON.parse(checkpointJson) as { last_created_at: string }).last_created_at;
    } catch {
      /* ignore malformed checkpoint */
    }
  }

  const salt = await loadOrCreateSalt(env.EXPORT_KV);
  const events = await fetchBatchEvents(env.DB, since, maxRecords);
  if (events.length === 0) return 0;

  const postIds = Array.from(new Set(events.map((e) => e.post_id)));
  const embeddings = await fetchEmbeddings(env.DB, postIds);
  const records = await buildDatasetRecords(events, embeddings, salt);
  const jsonl = serializeRecords(records);

  const lastCreatedAt = events[events.length - 1]?.created_at || since;
  const filename = `arcade-dwell-${Date.now()}.jsonl`;

  await writeArtifact(env, jsonl, filename);
  const uploaded = await pushToHuggingFace(env, jsonl, filename);

  if (env.EXPORT_KV) {
    await env.EXPORT_KV.put(
      DATASET_CHECKPOINT_KEY,
      JSON.stringify({ last_created_at: lastCreatedAt, uploaded, exported_at: new Date().toISOString() }),
    );
  }

  return records.length;
}
