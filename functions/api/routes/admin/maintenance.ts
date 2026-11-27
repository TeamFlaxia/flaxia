import { Hono } from 'hono';
import { stripPostColors } from '../../../../shared/post-colors.ts';
import { postTextSha } from '../../../lib/ai-index.ts';
import { drainPendingEmbeds, enqueuePendingEmbed, ensureNsfwScansTable, submitDetectNsfw } from '../../../lib/crowd';
import {
  addBlocklistEntry,
  listBlocklist,
  removeBlocklistEntry,
  validateBlocklistEntry,
} from '../../../lib/scan/blocklist';
import { rescreenQuarantinedObject } from '../../../lib/scan/rescreen';
import { requireAdmin, requireAuth } from '../../helpers';
import type { Bindings, Variables } from '../../types';
import { extractGameDescription, IMAGE_EXTENSION_LIKE } from './post-helpers.ts';

export const maintenance = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ─── Admin Backfill Operations ────────────────────────────────────────────────

// POST /api/admin/backfill-game-descriptions - extract descriptions for existing game posts (admin only)
maintenance.post('/backfill-game-descriptions', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB || !c.env.BUCKET) {
      return c.json({ error: 'Database or bucket not available' }, 500);
    }

    const url = new URL(c.req.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 1000);

    const games = (await c.env.DB.prepare(`
      SELECT id, payload_key
      FROM posts
      WHERE payload_key IS NOT NULL
        AND (payload_key LIKE '%.zip')
        AND (game_description IS NULL OR game_description = '')
      ORDER BY created_at DESC
      LIMIT ?
    `)
      .bind(limit)
      .all()) as { results: Array<{ id: string; payload_key: string }> };

    for (const game of games.results) {
      await extractGameDescription(c.env.BUCKET, c.env.DB, game.payload_key, game.id);
    }

    return c.json({ success: true, processed: games.results.length });
  } catch (error: unknown) {
    console.error('Backfill game descriptions error:', error);
    return c.json({ error: 'Failed to backfill game descriptions' }, 500);
  }
});

// POST /api/admin/backfill-nsfw - submit NudeNet screening for existing image posts (admin only)
maintenance.post('/backfill-nsfw', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const url = new URL(c.req.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 500);

    await ensureNsfwScansTable(c.env.DB);

    // One candidate per (post, image): a 4-image post needs 4 verdicts and
    // post_nsfw_scans now tracks them individually.
    const candidates = (await c.env.DB.prepare(`
      SELECT post_id, media_key
      FROM (
        SELECT id AS post_id, gif_key AS media_key, created_at
        FROM posts
        WHERE gif_key IS NOT NULL
          AND status = 'published'
          AND (${IMAGE_EXTENSION_LIKE})
        UNION ALL
        SELECT p.id, a.r2_key AS media_key, p.created_at
        FROM posts p
        JOIN post_attachments a ON a.post_id = p.id AND a.kind = 'image'
        WHERE p.status = 'published'
      ) cand
      WHERE NOT EXISTS (
        SELECT 1 FROM post_nsfw_scans s
        WHERE s.post_id = cand.post_id AND s.media_key = cand.media_key
          AND (s.status = 'submitted' OR (s.status = 'done' AND s.ai_passed IS NOT NULL))
      )
      GROUP BY post_id, media_key
      ORDER BY MAX(created_at) DESC
      LIMIT ?
    `)
      .bind(limit)
      .all()) as { results: Array<{ post_id: string; media_key: string }> };

    // The global 10s ceiling lets one image through per call by default;
    // ?throttle=false is the admin's explicit way to flush a backlog.
    const respectThrottle = url.searchParams.get('throttle') !== 'false';
    let submitted = 0;
    for (const cand of candidates.results) {
      if (
        await submitDetectNsfw(c.env.DB, c.env, cand.post_id, cand.media_key, {
          respectThrottle,
          recheckCompleted: true,
        })
      )
        submitted++;
    }

    return c.json({ success: true, submitted, remaining: candidates.results.length - submitted });
  } catch (error: unknown) {
    console.error('Backfill nsfw error:', error);
    return c.json({ error: 'Failed to backfill nsfw screening' }, 500);
  }
});

// POST /api/admin/backfill-embeddings - enqueue vector-embed tasks for existing
// posts that have no embedding yet, then drain as much of the backlog as the
// request budget allows. Idempotent: posts are skipped if already embedded or
// already queued.
maintenance.post('/backfill-embeddings', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const url = new URL(c.req.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 1_000);
    const drain = url.searchParams.get('drain') !== 'false';

    const candidates = (await c.env.DB.prepare(`
      SELECT p.id, p.text, e.source_sha, e.dimensions
      FROM posts p
      LEFT JOIN post_embeddings e ON p.id = e.post_id
      WHERE p.status = 'published'
        AND p.hidden = 0
        AND p.parent_id IS NULL
        AND p.text IS NOT NULL
        AND p.text != ''
      ORDER BY p.created_at DESC
      LIMIT ?
    `)
      .bind(limit)
      .all()) as { results: Array<{ id: string; text: string; source_sha: string | null; dimensions: number | null }> };

    let enqueued = 0;
    for (const post of candidates.results) {
      // A vector is only complete when its provenance matches the current text
      // and its dimensions match the live index. Both must be checked here.
      if (
        post.source_sha &&
        post.source_sha === (await postTextSha(stripPostColors(post.text))) &&
        post.dimensions === 768
      )
        continue;
      // Re-enqueueing an existing row refreshes its text while preserving the
      // retry budget for unchanged content.
      await enqueuePendingEmbed(c.env.DB, post.id, post.text);
      enqueued++;
    }

    const submitted = 0;
    const remaining = enqueued;
    const execCtx = (c as any).executionCtx;
    if (drain && execCtx?.waitUntil) {
      // Let the response return immediately; keep draining in the background.
      execCtx.waitUntil(
        (async () => {
          const result = await drainPendingEmbeds(c.env.DB, c.env, {
            maxBatch: Math.min(enqueued, 50) || 50,
            delayMs: 50,
            respectThrottle: false,
          }).catch((e) => {
            console.error('Backfill embed drain failed:', e);
            return { submitted: 0, remaining: enqueued };
          });
          console.log(`Backfill embed drain done: submitted=${result.submitted} remaining=${result.remaining}`);
        })(),
      );
    }

    return c.json({ success: true, enqueued, submitted, remaining });
  } catch (error: unknown) {
    console.error('Backfill embeddings error:', error);
    return c.json({ error: 'Failed to backfill embeddings' }, 500);
  }
});

// GET /auth-migration — progress of the plaintext-password retirement.
//
// Two independent counters, because they retire at different times:
//   no_srp       accounts that can only use the deprecated POST /auth/login.
//                Hits 0 as every remaining legacy account signs in once.
//   plaintext_hash accounts still carrying password_hash (PBKDF2). Non-empty
//                for the same set; it is blanked by the upgrade itself.
// `cutoffReached` is the signal that POST /api/auth/login can be deleted (see
// the comment on that route). srp_v1 rows are verifiers still derived with a
// single SHA-256; they migrate at the next password-holding event.
maintenance.get('/auth-migration', requireAuth, requireAdmin, async (c) => {
  try {
    const row = await c.env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN password_hash <> '' THEN 1 ELSE 0 END), 0) AS plaintext_hash,
         COALESCE(SUM(CASE WHEN srp_salt IS NULL THEN 1 ELSE 0 END), 0) AS no_srp,
         COALESCE(SUM(CASE WHEN srp_kdf = 'sha256-v1' THEN 1 ELSE 0 END), 0) AS srp_v1,
         COALESCE(SUM(CASE WHEN srp_kdf = 'pbkdf2-600k-v2' THEN 1 ELSE 0 END), 0) AS srp_v2,
         COALESCE(SUM(CASE WHEN srp_salt IS NOT NULL AND srp_kdf IS NULL THEN 1 ELSE 0 END), 0) AS srp_kdf_unlabelled
       FROM users`,
    ).first<{
      total: number;
      plaintext_hash: number;
      no_srp: number;
      srp_v1: number;
      srp_v2: number;
      srp_kdf_unlabelled: number;
    }>();

    const stats = row ?? {
      total: 0,
      plaintext_hash: 0,
      no_srp: 0,
      srp_v1: 0,
      srp_v2: 0,
      srp_kdf_unlabelled: 0,
    };
    return c.json({ ...stats, cutoff_reached: stats.plaintext_hash === 0 && stats.no_srp === 0 });
  } catch (error: unknown) {
    console.error('Auth migration stats error:', error);
    return c.json({ error: 'Failed to read migration stats' }, 500);
  }
});

// ─── File blocklist ──────────────────────────────────────────────────────────

// POST /api/admin/rescreen-quarantined — retry skipped image scans after confirming
// their current R2 bytes still match the D1 row.
maintenance.post('/rescreen-quarantined', requireAuth, requireAdmin, async (c) => {
  if (!c.env.DB || !c.env.BUCKET) return c.json({ error: 'Database or bucket unavailable' }, 500);

  let body: { limit?: unknown } = {};
  try {
    body = await c.req.json<{ limit?: unknown }>();
  } catch {
    // An empty request body is allowed; the default batch is small.
  }
  const requested = typeof body.limit === 'number' ? body.limit : Number(body.limit ?? 25);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 1), 100) : 25;

  try {
    const rows = await c.env.DB.prepare(
      `SELECT r2_key FROM file_scans
       WHERE status = 'skipped' AND detail IN ('too_large', 'orchestrator_unconfigured')
         AND kind = 'image'
       ORDER BY created_at ASC LIMIT ?`,
    )
      .bind(limit)
      .all<{ r2_key: string }>();

    const results: Record<string, number> = {};
    for (const row of rows.results ?? []) {
      const result = await rescreenQuarantinedObject(c.env.DB, c.env.BUCKET, c.env, row.r2_key);
      results[result] = (results[result] ?? 0) + 1;
    }
    return c.json({ success: true, considered: rows.results?.length ?? 0, results });
  } catch (error: unknown) {
    console.error('Quarantined media rescreen error:', error);
    return c.json({ error: 'Failed to rescreen quarantined media' }, 500);
  }
});

// GET /api/admin/file-blocklist — list all entries.
maintenance.get('/file-blocklist', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }
    const entries = await listBlocklist(c.env.DB);
    return c.json({ entries });
  } catch (error: unknown) {
    console.error('File blocklist list error:', error);
    return c.json({ error: 'Failed to list blocklist' }, 500);
  }
});

// POST /api/admin/file-blocklist — add (or refresh) one entry.
maintenance.post('/file-blocklist', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }
    const body = await c.req.json<{ kind?: unknown; value?: unknown; signature?: unknown; reason?: unknown }>();
    const parsed = validateBlocklistEntry(body.kind, body.value);
    if ('error' in parsed) {
      return c.json({ error: parsed.error }, 400);
    }
    await addBlocklistEntry(c.env.DB, {
      ...parsed,
      signature: typeof body.signature === 'string' ? body.signature.slice(0, 200) : null,
      reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null,
      addedBy: c.get('user')?.id ?? 'admin',
    });
    return c.json({ ok: true, ...parsed }, 201);
  } catch (error: unknown) {
    console.error('File blocklist add error:', error);
    return c.json({ error: 'Failed to add blocklist entry' }, 500);
  }
});

// DELETE /api/admin/file-blocklist/:id — remove one entry.
maintenance.delete('/file-blocklist/:id', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'Invalid id' }, 400);
    }
    const removed = await removeBlocklistEntry(c.env.DB, id);
    if (!removed) {
      return c.json({ error: 'Entry not found' }, 404);
    }
    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('File blocklist delete error:', error);
    return c.json({ error: 'Failed to delete blocklist entry' }, 500);
  }
});
