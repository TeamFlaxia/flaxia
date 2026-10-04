import type { D1Database } from '@cloudflare/workers-types';
import {
  type BanditPrior,
  applyReward as banditApplyReward,
  project as banditProject,
  createProjection,
  createState,
  createStateFromPrior,
  eventReward,
  type LinUCBConfig,
  type LinUCBState,
  parseBanditConfig,
  parseBanditPrior,
  projConfigKey,
  serializeState,
} from '../../lib/linucb';

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

const PROFILE_TTL_MS = 5 * 60 * 1000;

// Materialized weighted interest vector persisted in user_profiles so the
// recommender avoids re-deriving it on every request. Returns null when the
// user has no positive signal history yet.
async function loadOrComputeInterestVector(
  db: D1Database,
  userId: string,
): Promise<{ vector: number[]; sourceCount: number } | null> {
  const cached = await db
    .prepare(
      `SELECT interest_vec, source_count, updated_at FROM user_profiles
       WHERE user_id = ?`,
    )
    .bind(userId)
    .first<{ interest_vec: string; source_count: number; updated_at: string }>();

  if (cached) {
    const age = Date.now() - new Date(cached.updated_at).getTime();
    if (age < PROFILE_TTL_MS) {
      try {
        const v = JSON.parse(cached.interest_vec);
        if (Array.isArray(v) && v.length > 0) {
          return { vector: v, sourceCount: cached.source_count };
        }
      } catch {
        /* fall through to recompute */
      }
    }
  }

  const dim = 1024;
  const freshRows = await db
    .prepare(
      `SELECT f.post_id FROM freshs f JOIN posts p ON p.id = f.post_id
       WHERE f.user_id = ? ORDER BY p.created_at DESC LIMIT 50`,
    )
    .bind(userId)
    .all<{ post_id: string }>();
  const freshIds = (freshRows.results || []).map((r) => r.post_id);

  const gamePlayRows = await db
    .prepare(
      `SELECT post_id, dwell_ms FROM user_game_plays
       WHERE user_id = ? AND dwell_ms > 5000
       ORDER BY created_at DESC LIMIT 50`,
    )
    .bind(userId)
    .all<{ post_id: string; dwell_ms: number }>();
  const gamePlays = gamePlayRows.results || [];

  const allSourceIds = [...freshIds, ...gamePlays.map((r) => r.post_id)];
  const dwellMap = new Map(gamePlays.map((r) => [r.post_id, r.dwell_ms]));

  let vector: number[] | null = null;
  let sourceCount = 0;

  if (allSourceIds.length > 0) {
    const embedRows = await db
      .prepare(
        `SELECT post_id, embedding FROM post_embeddings WHERE post_id IN (${allSourceIds.map(() => '?').join(',')})`,
      )
      .bind(...allSourceIds)
      .all<{ post_id: string; embedding: string }>();
    const weightedEmbeds: Array<{ vec: number[]; weight: number }> = [];
    for (const row of embedRows.results || []) {
      try {
        const v = JSON.parse(row.embedding);
        if (!Array.isArray(v)) continue;
        const dwellW = dwellMap.get(row.post_id);
        // Fresh = weight 1.0, game play with dwell = weight min(dwell_ms / 30000, 1.0)
        const w = dwellW ? Math.min(dwellW / 30000, 1.0) : 1.0;
        weightedEmbeds.push({ vec: v, weight: w });
      } catch {
        /* skip malformed */
      }
    }
    if (weightedEmbeds.length > 0) {
      const totalWeight = weightedEmbeds.reduce((s, e) => s + e.weight, 0);
      vector = new Array(dim).fill(0);
      for (const { vec, weight } of weightedEmbeds) {
        for (let i = 0; i < dim; i++) vector[i] += (vec[i] || 0) * weight;
      }
      for (let i = 0; i < dim; i++) vector[i] /= totalWeight;
      sourceCount = weightedEmbeds.length;
    }
  }

  if (vector) {
    await db
      .prepare(
        `INSERT INTO user_profiles (user_id, interest_vec, source_count, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET interest_vec = excluded.interest_vec,
           source_count = excluded.source_count, updated_at = excluded.updated_at`,
      )
      .bind(userId, JSON.stringify(vector), sourceCount, new Date().toISOString())
      .run();
  }

  return vector ? { vector, sourceCount } : null;
}

const DWELL_STATS_CACHE_KEY = 'arcade:dwell:stats:v2';
const DWELL_STATS_TTL_S = 60;

// Aggregate dwell stats are shared across all users, so cache them globally
// (60s) instead of re-scanning the whole user_game_plays table on every
// recommended-games request. The scan is also bounded to a recent window.
async function loadDwellStats(
  db: D1Database,
  cache: KVNamespace | undefined,
): Promise<{ dwellStats: Map<string, { avgDwell: number; playCount: number }>; maxAvgDwell: number }> {
  if (cache) {
    try {
      const raw = await cache.get(DWELL_STATS_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, { avgDwell: number; playCount: number }>;
        const dwellStats = new Map(Object.entries(parsed));
        let maxAvgDwell = 1;
        for (const d of dwellStats.values()) {
          if (d.avgDwell > maxAvgDwell) maxAvgDwell = d.avgDwell;
        }
        return { dwellStats, maxAvgDwell };
      }
    } catch {
      /* fall through to recompute */
    }
  }

  const dwellStats = new Map<string, { avgDwell: number; playCount: number }>();
  const dwellResult = await db
    .prepare(
      `SELECT post_id, AVG(dwell_ms) as avg_dwell, COUNT(*) as play_count
       FROM user_game_plays
       WHERE dwell_ms > 2000 AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
       GROUP BY post_id`,
    )
    .all<{ post_id: string; avg_dwell: number; play_count: number }>();
  let maxAvgDwell = 1;
  for (const row of dwellResult.results || []) {
    const avgDwell = Number(row.avg_dwell) || 0;
    dwellStats.set(row.post_id, { avgDwell, playCount: row.play_count });
    if (avgDwell > maxAvgDwell) maxAvgDwell = avgDwell;
  }
  if (cache) {
    try {
      await cache.put(DWELL_STATS_CACHE_KEY, JSON.stringify(Object.fromEntries(dwellStats)), {
        expirationTtl: DWELL_STATS_TTL_S,
      });
    } catch {
      /* ignore cache write failure */
    }
  }
  return { dwellStats, maxAvgDwell };
}

const BANDIT_CONFIG_KEY = 'arcade:bandit:config';
const BANDIT_PRIOR_KEY = 'arcade:bandit:prior';
const projectionCache = new Map<string, number[][]>();

function getProjection(config: LinUCBConfig): number[][] {
  const key = `${config.seed}:${config.srcDim}:${config.dim}`;
  let proj = projectionCache.get(key);
  if (!proj) {
    proj = createProjection(config.srcDim, config.dim, config.seed);
    projectionCache.set(key, proj);
  }
  return proj;
}

async function loadBanditConfig(cache: KVNamespace | undefined): Promise<LinUCBConfig> {
  if (!cache) return { ...parseBanditConfig(null) };
  try {
    return parseBanditConfig(await cache.get(BANDIT_CONFIG_KEY));
  } catch {
    return { ...parseBanditConfig(null) };
  }
}

// Learned global policy deployed from the offline training pipeline. Only used
// when its projection config (seed/srcDim/dim) matches the active bandit.
async function loadBanditPrior(cache: KVNamespace | undefined): Promise<BanditPrior | null> {
  if (!cache) return null;
  try {
    return parseBanditPrior(await cache.get(BANDIT_PRIOR_KEY));
  } catch {
    return null;
  }
}

async function loadBanditState(
  db: D1Database,
  userId: string,
  config: LinUCBConfig,
  cache?: KVNamespace | undefined,
): Promise<LinUCBState> {
  const row = await db
    .prepare(`SELECT a_inv, b, t FROM bandit_state WHERE user_id = ?`)
    .bind(userId)
    .first<{ a_inv: string; b: string; t: number }>();
  if (row) {
    try {
      const parsed = JSON.parse(row.a_inv) as number[];
      const b = JSON.parse(row.b) as number[];
      if (
        Array.isArray(parsed) &&
        parsed.length === config.dim * config.dim &&
        Array.isArray(b) &&
        b.length === config.dim
      ) {
        return { aInv: parsed.map(Number), b: b.map(Number), t: row.t || 0 };
      }
    } catch {
      /* fall through to fresh state */
    }
  }
  const prior = await loadBanditPrior(cache);
  if (
    prior &&
    prior.dim === config.dim &&
    prior.seed === config.seed &&
    prior.srcDim === config.srcDim &&
    prior.theta.length === config.dim
  ) {
    return createStateFromPrior(config.dim, prior.theta, prior.lambda0);
  }
  return createState(config.dim);
}

async function saveBanditState(db: D1Database, userId: string, state: LinUCBState): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bandit_state (user_id, a_inv, b, t, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET a_inv = excluded.a_inv, b = excluded.b,
         t = excluded.t, updated_at = excluded.updated_at`,
    )
    .bind(userId, serializeState(state), JSON.stringify(state.b), state.t, new Date().toISOString())
    .run();
}

// Apply bandit reward updates for a batch of Arcade events. Loads the game
// embeddings once per batch and performs a single state read + write per user.
async function applyBanditRewards(
  db: D1Database,
  cache: KVNamespace | undefined,
  userId: string,
  events: Array<{ postId: string; eventType: string; dwellMs: number }>,
): Promise<void> {
  const config = await loadBanditConfig(cache);
  if (!config.enabled || events.length === 0) return;

  const proj = getProjection(config);
  const cfgKey = projConfigKey(config);
  const distinctPostIds = Array.from(new Set(events.map((e) => e.postId)));
  if (distinctPostIds.length === 0) return;

  const embedRows = await db
    .prepare(
      `SELECT post_id, embedding, bandit_vec, bandit_cfg FROM post_embeddings WHERE post_id IN (${distinctPostIds.map(() => '?').join(',')})`,
    )
    .bind(...distinctPostIds)
    .all<{ post_id: string; embedding: string; bandit_vec: string | null; bandit_cfg: string | null }>();
  const embeds = new Map<string, { vec: number[]; banditVec: number[] | null; banditCfg: string | null }>();
  for (const row of embedRows.results || []) {
    try {
      const v = JSON.parse(row.embedding);
      if (!Array.isArray(v)) continue;
      let banditVec: number[] | null = null;
      if (row.bandit_vec) {
        try {
          const bv = JSON.parse(row.bandit_vec);
          if (Array.isArray(bv)) banditVec = bv;
        } catch {
          /* ignore malformed projection */
        }
      }
      embeds.set(row.post_id, { vec: v, banditVec, banditCfg: row.bandit_cfg ?? null });
    } catch {
      /* skip */
    }
  }

  const state = await loadBanditState(db, userId, config, cache);
  let dirty = false;
  for (const event of events) {
    const cand = embeds.get(event.postId);
    if (!cand || !cand.vec) continue;
    const x = cand.banditVec && cand.banditCfg === cfgKey ? cand.banditVec : banditProject(cand.vec, proj);
    banditApplyReward(state, x, eventReward(event.eventType, event.dwellMs));
    dirty = true;
  }
  if (dirty) {
    await saveBanditState(db, userId, state);
  }
}

export {
  applyBanditRewards,
  cosineSimilarity,
  getProjection,
  loadBanditConfig,
  loadBanditPrior,
  loadBanditState,
  loadDwellStats,
  loadOrComputeInterestVector,
  saveBanditState,
};
