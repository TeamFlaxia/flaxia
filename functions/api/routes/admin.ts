// already queued.
admin.post('/backfill-embeddings', requireAuth, requireAdmin, async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const url = new URL(c.req.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 2_147_483_647);
    const drain = url.searchParams.get('drain') !== 'false';

    const candidates = (await c.env.DB.prepare(`
      SELECT p.id, p.text, CASE WHEN pe.post_id IS NULL THEN 0 ELSE 1 END AS pending
      FROM posts p
      LEFT JOIN post_embeddings e ON p.id = e.post_id
      LEFT JOIN pending_embeddings pe ON pe.post_id = p.id
      WHERE p.status = 'published'
        AND p.hidden = 0
        AND p.parent_id IS NULL
        AND p.text IS NOT NULL
        AND p.text != ''
        AND (e.post_id IS NULL OR e.source_sha IS NULL)
      ORDER BY p.created_at DESC
      LIMIT ?
    `)
      .bind(limit)
      .all()) as { results: Array<{ id: string; text: string; pending: number }> };

    let enqueued = 0;
    for (const post of candidates.results) {
      // Posts already in the outbox are counted but not re-enqueued, so failed
      // retry state (attempts/last_error) is preserved.
      if (!post.pending) await enqueuePendingEmbed(c.env.DB, post.id, post.text);
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
            maxBatch: enqueued || 50,
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