import { Hono } from 'hono';
import { stripPostColors } from '../../../src/lib/post-colors.ts';
import {
  type EncodedVector,
  encodeVector,
  RECOMMENDATION_VECTOR_DIM,
} from '../../../src/lib/recommendation/vector-codec.ts';
import { getMeWithSession, getSessionToken } from '../../lib/auth';
import { clampLimit } from '../../lib/pagination';
import { checkRateLimit } from '../../lib/rate-limit';
import {
  ARCADE_EVENT_TYPES,
  batchGetFreshAndBookmarkStatus,
  MAX_ARCADE_EVENTS_PER_REQUEST,
  runBatched,
} from '../helpers';
import type { Bindings, Variables } from '../types';
import { loadDwellStats } from './recommender';

const games = new Hono<{ Bindings: Bindings; Variables: Variables }>();

interface ArcadeCandidateRow {
  postId: string;
  user_id: string;
  text: string;
  swf_key: string | null;
  payload_key: string | null;
  thumbnail_key: string | null;
  fresh_count: number;
  reply_count: number;
  bookmark_count: number;
  impressions: number;
  created_at: string;
  username: string;
  display_name: string | null;
  avatar_key: string | null;
  badge_type: string | null;
}

games.get('/games', async (c) => {
  try {
    const shuffle = c.req.query('shuffle') === 'true';
    const trending = c.req.query('trending') === 'true';
    const limit = clampLimit(c.req.query('limit'), 20, 50);
    const cursor = c.req.query('cursor');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Generate cache key based on query parameters. Caching applies only
    // to first pages (#143), so the client cursor never enters the key and
    // cannot inflate the KV keyspace.
    const cacheKey = `games:${shuffle ? 'shuffle' : trending ? 'trending' : 'recent'}:${limit}:first`;

    // Only first-page, non-shuffle requests can use this cache. A pinned
    // initialId must bypass it so the requested game is never dropped.
    if (!shuffle && !cursor && !c.req.query('initialId')) {
      let cachedData: string | null | undefined;
      try {
        cachedData = await c.env.CACHE?.get(cacheKey);
      } catch {
        // proceed without cache on KV failure
      }
      if (cachedData) {
        const parsed = JSON.parse(cachedData);

        const token = getSessionToken(c.req.raw);
        const sessionData = token ? await getMeWithSession(c.env, token) : null;
        const currentUserId = sessionData?.user?.id;

        if (currentUserId && parsed.games.length > 0) {
          const gameIds = parsed.games.map((g: Record<string, unknown>) => g.id as string);
          const { freshed, bookmarked } = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, gameIds);

          parsed.games.forEach((game: Record<string, unknown>) => {
            game.isFreshed = freshed.has(game.id as string);
            game.isBookmarked = bookmarked.has(game.id as string);
          });
        }

        return c.json(parsed);
      }
    }

    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token) : null;
    const currentUserId = sessionData?.user?.id;

    if (shuffle) {
      const shuffleToken = c.req.query('token');
      const offset = Math.max(0, Number(c.req.query('offset') || '0'));
      const initialId = c.req.query('initialId');

      let shuffledIds: string[] = [];
      let currentToken = shuffleToken;

      if (currentToken) {
        try {
          const cached = await c.env.CACHE?.get(`games:shuffle:${currentToken}`);
          if (cached) {
            shuffledIds = JSON.parse(cached);
          } else {
            currentToken = undefined;
          }
        } catch {
          currentToken = undefined;
        }
      }

      if (!currentToken) {
        const idResults = await c.env.DB.prepare(`
          SELECT p.id FROM posts p
          WHERE p.payload_key IS NOT NULL AND p.swf_key IS NULL
            AND p.status = 'published'
            AND p.hidden = 0
            AND p.parent_id IS NULL
          ORDER BY p.created_at DESC
        `).all();

        shuffledIds = (idResults.results || []).map((r: Record<string, unknown>) => r.id as string);

        for (let i = shuffledIds.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffledIds[i], shuffledIds[j]] = [shuffledIds[j], shuffledIds[i]];
        }

        // If initialId is provided, move it to the front
        if (initialId) {
          const idx = shuffledIds.indexOf(initialId);
          if (idx !== -1) {
            shuffledIds.splice(idx, 1);
            shuffledIds.unshift(initialId);
          } else {
            // Check if the initialId exists and is actually a game post
            const check = await c.env.DB.prepare(`
              SELECT id FROM posts 
              WHERE id = ? AND payload_key IS NOT NULL AND swf_key IS NULL
                AND status = 'published' AND hidden = 0
            `)
              .bind(initialId)
              .first();
            if (check) {
              shuffledIds.unshift(initialId);
            }
          }
        }

        currentToken = crypto.randomUUID();

        try {
          await c.env.CACHE?.put(`games:shuffle:${currentToken}`, JSON.stringify(shuffledIds), {
            expirationTtl: 300,
          });
        } catch (cacheError) {
          console.warn('Failed to cache shuffle order:', cacheError);
        }
      }

      const pageIds = shuffledIds.slice(offset, offset + limit);
      const newOffset = offset + pageIds.length;
      const hasMore = newOffset < shuffledIds.length;

      let shuffledGames: Array<Record<string, unknown>> = [];

      if (pageIds.length > 0) {
        const placeholders = pageIds.map(() => '?').join(',');
        const { results: sliceData } = await c.env.DB.prepare(`
          SELECT
            p.id as postId, p.user_id, p.text, p.swf_key, p.payload_key,
            p.thumbnail_key, p.fresh_count,
            COALESCE(p.reply_count, 0) as reply_count,
            COALESCE(p.bookmark_count, 0) as bookmark_count,
            p.impressions, p.created_at,
            u.username, u.display_name, u.avatar_key, u.badge_type, u.name_color
          FROM posts p
          JOIN users u ON p.user_id = u.id
          WHERE p.id IN (${placeholders})
        `)
          .bind(...pageIds)
          .all<{
            postId: string;
            user_id: string;
            text: string;
            swf_key: string | null;
            payload_key: string | null;
            thumbnail_key: string | null;
            fresh_count: number;
            reply_count: number;
            bookmark_count: number;
            impressions: number;
            created_at: string;
            username: string;
            display_name: string | null;
            avatar_key: string | null;
            badge_type: string | null;
          }>();

        const gameMap = new Map((sliceData || []).map((r) => [r.postId, r]));

        let sliceFreshedPostIds: Set<string> = new Set();
        let sliceBookmarkedPostIds: Set<string> = new Set();
        if (currentUserId && sliceData && sliceData.length > 0) {
          const slicePostIds = sliceData.map((r) => r.postId);
          const result = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, slicePostIds);
          sliceFreshedPostIds = result.freshed;
          sliceBookmarkedPostIds = result.bookmarked;
        }

        shuffledGames = pageIds
          .map((id) => {
            const row = gameMap.get(id);
            if (!row) return null;
            const type = 'zip';
            const game: Record<string, unknown> = {
              id: row.postId,
              postId: row.postId,
              title: stripPostColors(row.text || '').substring(0, 100) || `Game by @${row.username}`,
              username: row.username,
              displayName: row.display_name || undefined,
              avatarKey: row.avatar_key || undefined,
              badgeType: row.badge_type || undefined,
              type,
              swfKey: row.swf_key || undefined,
              payloadKey: row.payload_key || undefined,
              thumbnailKey: row.thumbnail_key || undefined,
              freshCount: row.fresh_count,
              replyCount: row.reply_count,
              bookmarkCount: row.bookmark_count,
              impressions: row.impressions,
              isFreshed: sliceFreshedPostIds.has(row.postId),
              isBookmarked: sliceBookmarkedPostIds.has(row.postId),
              createdAt: row.created_at,
            };
            return game;
          })
          .filter((x): x is Record<string, unknown> => x !== null);
      }

      return c.json({
        games: shuffledGames,
        hasMore,
        token: currentToken,
        offset: newOffset,
      });
    }

    // Recommended mode: personalized scoring based on interest vector + dwell time
    const recommended = c.req.query('recommended') === 'true';
    if (recommended && currentUserId) {
      const initialId = c.req.query('initialId');
      const clientRank = c.req.query('client_rank') === '1' || c.req.query('include_vectors') === '1';
      const resultLimit = clientRank ? clampLimit(c.req.query('limit'), 120, 200) : limit;

      // Get dwell stats for all games (shared across users, cached in KV)
      const { dwellStats, maxAvgDwell } = await loadDwellStats(c.env.DB, c.env.CACHE);

      // Get games the user has already played
      const playedSet = new Set<string>();
      const playedResult = await c.env.DB.prepare(`SELECT DISTINCT post_id FROM user_game_plays WHERE user_id = ?`)
        .bind(currentUserId)
        .all<{ post_id: string }>();
      for (const row of playedResult.results || []) {
        playedSet.add(row.post_id);
      }

      // Query candidate game posts
      const candidateQuery = `
        SELECT p.id as postId, p.user_id, p.text, p.swf_key, p.payload_key,
               p.thumbnail_key, p.fresh_count, COALESCE(p.reply_count, 0) as reply_count,
               COALESCE(p.bookmark_count, 0) as bookmark_count,
               p.impressions, p.created_at,
               u.username, u.display_name, u.avatar_key, u.badge_type, u.name_color
        FROM posts p
        JOIN users u ON p.user_id = u.id
        WHERE p.payload_key IS NOT NULL AND p.swf_key IS NULL
          AND p.status = 'published' AND p.hidden = 0 AND p.parent_id IS NULL
        ORDER BY p.created_at DESC
        LIMIT 200
      `;
      const candidates = await c.env.DB.prepare(candidateQuery).all<ArcadeCandidateRow>();
      const candidateRows = candidates.results || [];

      // The Arcade can be opened directly for any ZIP post (timeline, thread,
      // share link). Make sure that game is a candidate even when it falls
      // outside the window above or is a reply.
      if (initialId && !candidateRows.some((row) => row.postId === initialId)) {
        const initialRow = await c.env.DB.prepare(`
          SELECT p.id as postId, p.user_id, p.text, p.swf_key, p.payload_key,
                 p.thumbnail_key, p.fresh_count, COALESCE(p.reply_count, 0) as reply_count,
                 COALESCE(p.bookmark_count, 0) as bookmark_count,
                 p.impressions, p.created_at,
                 u.username, u.display_name, u.avatar_key, u.badge_type, u.name_color
          FROM posts p
          JOIN users u ON p.user_id = u.id
          WHERE p.id = ? AND p.payload_key IS NOT NULL AND p.swf_key IS NULL
            AND p.status = 'published' AND p.hidden = 0
        `)
          .bind(initialId)
          .first<ArcadeCandidateRow>();
        if (initialRow) candidateRows.push(initialRow);
      }

      // Public candidate embeddings. The personal interest vector stays in the
      // browser Vault, so the server only ships opaque post features.
      const candEmbeds = new Map<string, number[]>();
      if (candidateRows.length > 0) {
        const cIds = candidateRows.map((row) => row.postId);
        const eRows = await c.env.DB.prepare(
          'SELECT post_id, embedding FROM post_embeddings WHERE post_id IN (SELECT value FROM json_each(?))',
        )
          .bind(JSON.stringify(cIds))
          .all<{ post_id: string; embedding: string }>();
        for (const row of eRows.results || []) {
          try {
            const vector: unknown = JSON.parse(row.embedding);
            if (Array.isArray(vector) && vector.length === RECOMMENDATION_VECTOR_DIM) {
              candEmbeds.set(row.post_id, vector.map(Number));
            }
          } catch {
            /* skip malformed embedding */
          }
        }
      }

      const now = Date.now();
      const dayMs = 86400000;

      // Popularity fallback, normalized across the candidate set.
      let popMin = Number.POSITIVE_INFINITY;
      let popMax = Number.NEGATIVE_INFINITY;
      const popRaw = candidateRows.map((row) => {
        const pop =
          0.5 * Math.log1p(row.fresh_count || 0) +
          0.3 * Math.log1p(row.reply_count || 0) +
          0.2 * Math.log1p(row.bookmark_count || 0) +
          0.4 * Math.log1p(row.impressions || 0);
        if (pop < popMin) popMin = pop;
        if (pop > popMax) popMax = pop;
        return pop;
      });
      const popularityById = new Map<string, number>();
      candidateRows.forEach((row, i) => {
        const pop = popRaw[i];
        popularityById.set(row.postId, popMax > popMin ? (pop - popMin) / (popMax - popMin) : 0);
      });

      const scored = candidateRows.map((row) => {
        const dwellInfo = dwellStats.get(row.postId);
        const expectedDwellNorm = dwellInfo ? dwellInfo.avgDwell / maxAvgDwell : 0;
        const explorationBonus = playedSet.has(row.postId) ? 0 : 0.2;
        const age = now - new Date(row.created_at).getTime();
        const freshnessBonus = age < dayMs ? 0.1 : 0;
        const score =
          0.45 * expectedDwellNorm +
          0.3 * (popularityById.get(row.postId) || 0) +
          0.15 * explorationBonus +
          0.1 * freshnessBonus;
        return { row, score };
      });

      scored.sort((a, b) => b.score - a.score);

      // Old clients keep server-side ordering; the new client applies cosine
      // locally and handles initialId prominence itself.
      if (initialId && !clientRank) {
        const idx = scored.findIndex((s) => s.row.postId === initialId);
        if (idx !== -1) {
          const item = scored.splice(idx, 1)[0];
          scored.unshift(item);
        }
      }

      const offset = Math.max(0, Number(c.req.query('offset') || '0'));
      const page = scored.slice(offset, offset + resultLimit);
      const hasMore = offset + resultLimit < scored.length;

      let freshedPostIds: Set<string> = new Set();
      let bookmarkedPostIds: Set<string> = new Set();
      if (page.length > 0) {
        const pageIds = page.map((s) => s.row.postId);
        const result = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, pageIds);
        freshedPostIds = result.freshed;
        bookmarkedPostIds = result.bookmarked;
      }

      const vectors: Record<string, EncodedVector> = {};
      const baseScores: Record<string, number> = {};
      const games = page.map(({ row, score }) => {
        const type = 'zip';
        baseScores[row.postId] = score;
        const embedding = candEmbeds.get(row.postId);
        if (embedding) {
          const encoded = encodeVector(embedding);
          if (encoded) vectors[row.postId] = encoded;
        }
        return {
          id: row.postId,
          postId: row.postId,
          title: stripPostColors(row.text || '').substring(0, 100) || `Game by @${row.username}`,
          username: row.username,
          displayName: row.display_name || undefined,
          avatarKey: row.avatar_key || undefined,
          type,
          swfKey: row.swf_key || undefined,
          payloadKey: row.payload_key || undefined,
          thumbnailKey: row.thumbnail_key || undefined,
          freshCount: row.fresh_count,
          replyCount: row.reply_count,
          bookmarkCount: row.bookmark_count,
          impressions: row.impressions,
          isFreshed: freshedPostIds.has(row.postId),
          isBookmarked: bookmarkedPostIds.has(row.postId),
          createdAt: row.created_at,
        };
      });

      return c.json({
        games,
        hasMore,
        offset: offset + resultLimit,
        ...(clientRank
          ? {
              vectors,
              vector_meta: { dim: RECOMMENDATION_VECTOR_DIM, encoding: 'int8' },
              base_scores: baseScores,
              initial_id: initialId || null,
            }
          : {}),
      });
    }

    let sql = `
      SELECT
        p.id as postId,
        p.user_id,
        p.text,
        p.swf_key,
        p.payload_key,
        p.thumbnail_key,
        p.fresh_count,
        COALESCE(p.reply_count, 0) as reply_count,
        COALESCE(p.bookmark_count, 0) as bookmark_count,
        p.impressions,
        p.created_at,
        u.username,
        u.display_name,
        u.avatar_key, u.badge_type, u.name_color
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.payload_key IS NOT NULL AND p.swf_key IS NULL
        AND p.status = 'published'
        AND p.hidden = 0
        AND p.parent_id IS NULL
    `;

    const params: (string | number)[] = [];

    if (cursor) {
      sql += ' AND p.created_at < ?';
      params.push(cursor);
    }

    if (trending) {
      sql += ' ORDER BY (p.fresh_count + p.impressions) DESC, p.created_at DESC';
    } else {
      sql += ' ORDER BY p.created_at DESC';
    }

    sql += ' LIMIT ?';
    params.push(limit + 1);

    const { results } = await c.env.DB.prepare(sql)
      .bind(...params)
      .all<{
        postId: string;
        user_id: string;
        text: string;
        swf_key: string | null;
        payload_key: string | null;
        thumbnail_key: string | null;
        fresh_count: number;
        reply_count: number;
        bookmark_count: number;
        impressions: number;
        created_at: string;
        username: string;
        display_name: string | null;
        avatar_key: string | null;
        badge_type: string | null;
      }>();

    let freshedPostIds: Set<string> = new Set();
    let bookmarkedPostIds: Set<string> = new Set();
    if (currentUserId && results.length > 0) {
      const postIds = results.map((row) => row.postId);
      const result = await batchGetFreshAndBookmarkStatus(c.env.DB, currentUserId, postIds);
      freshedPostIds = result.freshed;
      bookmarkedPostIds = result.bookmarked;
    }

    const games = (results || []).map((row) => {
      const type = 'zip';
      return {
        id: row.postId,
        postId: row.postId,
        title: stripPostColors(row.text || '').substring(0, 100) || `Game by @${row.username}`,
        username: row.username,
        displayName: row.display_name || undefined,
        avatarKey: row.avatar_key || undefined,
        type,
        swfKey: row.swf_key || undefined,
        payloadKey: row.payload_key || undefined,
        thumbnailKey: row.thumbnail_key || undefined,
        freshCount: row.fresh_count,
        replyCount: row.reply_count,
        bookmarkCount: row.bookmark_count,
        impressions: row.impressions,
        isFreshed: freshedPostIds.has(row.postId),
        isBookmarked: bookmarkedPostIds.has(row.postId),
        createdAt: row.created_at,
      };
    });

    const hasMore = games.length > limit;
    const trimmedGames = hasMore ? games.slice(0, limit) : games;
    const nextCursor = hasMore ? trimmedGames[trimmedGames.length - 1]?.createdAt : null;

    const responseData = {
      games: trimmedGames,
      hasMore,
      cursor: nextCursor,
    };

    if (!cursor && c.env.CACHE) {
      try {
        const cacheData = {
          games: trimmedGames.map((game) => ({
            ...game,
            isFreshed: false,
            isBookmarked: false,
          })),
          hasMore,
          cursor: nextCursor,
        };
        await c.env.CACHE.put(cacheKey, JSON.stringify(cacheData), {
          expirationTtl: 300,
        });
      } catch (cacheError) {
        console.warn('Failed to cache games data:', cacheError);
      }
    }

    return c.json(responseData);
  } catch (error: unknown) {
    console.error('Games fetch error:', error);
    return c.json({ error: 'Failed to fetch games' }, 500);
  }
});
// D1 permits at most 100 bound parameters per query.
const GAME_VALIDATION_CHUNK_SIZE = 100;

/** Published, visible game posts (payload or swf present) among the given ids. */
async function loadValidGamePostIds(db: D1Database, postIds: unknown[]): Promise<Set<string>> {
  const unique = [...new Set(postIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const validIds = new Set<string>();
  for (let offset = 0; offset < unique.length; offset += GAME_VALIDATION_CHUNK_SIZE) {
    const chunk = unique.slice(offset, offset + GAME_VALIDATION_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db
      .prepare(
        `SELECT id FROM posts WHERE id IN (${placeholders}) AND status = 'published' AND hidden = 0 AND (payload_key IS NOT NULL OR swf_key IS NOT NULL)`,
      )
      .bind(...chunk)
      .all<{ id: string }>();
    for (const row of rows.results ?? []) validIds.add(row.id);
  }
  return validIds;
}

// POST /api/games/events - record raw Arcade interaction events (views incl. skips,
// fresh, reply, fullscreen, share). Superset of /api/games/dwell: positive-dwell
// views are also mirrored into user_game_plays so the existing dwell-based
// recommendation keeps working.

games.post('/games/events', async (c) => {
  try {
    const currentUserId = c.get('user')?.id;
    if (!currentUserId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (
      !(await checkRateLimit(c.env.CACHE, `arcade-events:${currentUserId}`, { maxRequests: 120, windowSeconds: 60 }))
    ) {
      return c.json({ error: 'Too many requests' }, 429);
    }

    const { sessionId, events } = await c.req.json<{
      sessionId: string;
      events: Array<{
        postId: string;
        eventType: string;
        dwellMs: number;
        swipeVelocity: number;
        didSkip: number;
        isFullscreen: number;
        position: number;
        gameType: string;
      }>;
    }>();

    if (!events || events.length === 0) {
      return c.json({ error: 'No events' }, 400);
    }
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
      return c.json({ error: 'Invalid sessionId' }, 400);
    }

    const eventStmt = c.env.DB.prepare(
      `INSERT INTO arcade_events
         (id, user_id, post_id, session_id, position, event_type, dwell_ms,
          swipe_velocity, did_skip, is_fullscreen, game_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const dwellStmt = c.env.DB.prepare(
      `INSERT INTO user_game_plays (id, user_id, post_id, dwell_ms, is_fullscreen, game_type, source)
       VALUES (?, ?, ?, ?, ?, ?, 'arcade')`,
    );

    const statements: D1PreparedStatement[] = [];
    const eventList = events.slice(0, MAX_ARCADE_EVENTS_PER_REQUEST);

    // Only real, published games may accumulate events; unknown or hidden ids
    // are dropped instead of poisoning arcade/dwell rankings.
    const validGamePostIds = await loadValidGamePostIds(
      c.env.DB,
      eventList.map((event) => event?.postId),
    );

    for (const event of eventList) {
      if (typeof event?.postId !== 'string' || event.postId.length === 0) continue;
      if (!validGamePostIds.has(event.postId)) continue;
      if (typeof event?.eventType !== 'string' || !ARCADE_EVENT_TYPES.has(event.eventType)) continue;

      const dwellMs = Math.max(0, Math.min(Math.round(Number(event.dwellMs) || 0), 86400000));
      const position = Math.max(0, Math.min(Math.round(Number(event.position) || 0), 100000));
      const swipeVelocity = Math.max(0, Math.min(Number(event.swipeVelocity) || 0, 1000));
      const didSkip = event.didSkip ? 1 : 0;
      const isFullscreen = event.isFullscreen ? 1 : 0;
      const gameType = typeof event.gameType === 'string' ? event.gameType.slice(0, 32) : '';

      statements.push(
        eventStmt.bind(
          crypto.randomUUID(),
          currentUserId,
          event.postId,
          sessionId,
          position,
          event.eventType,
          dwellMs,
          swipeVelocity,
          didSkip,
          isFullscreen,
          gameType,
        ),
      );

      // Mirror positive-dwell views into the existing dwell aggregate table.
      if (event.eventType === 'view' && dwellMs > 2000) {
        statements.push(
          dwellStmt.bind(crypto.randomUUID(), currentUserId, event.postId, dwellMs, isFullscreen, gameType),
        );
      }
    }

    await runBatched(c.env.DB, statements);

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Arcade events record error:', error);
    return c.json({ error: 'Failed to record events' }, 500);
  }
});
// POST /api/games/dwell - record game play dwell time
games.post('/games/dwell', async (c) => {
  try {
    const currentUserId = c.get('user')?.id;
    if (!currentUserId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (!(await checkRateLimit(c.env.CACHE, `arcade-dwell:${currentUserId}`, { maxRequests: 60, windowSeconds: 60 }))) {
      return c.json({ error: 'Too many requests' }, 429);
    }

    const { plays } = await c.req.json<{
      plays: Array<{ postId: string; dwellMs: number; isFullscreen: number; gameType: string }>;
    }>();
    if (!plays || plays.length === 0) {
      return c.json({ error: 'No plays' }, 400);
    }

    const stmt = c.env.DB.prepare(
      `INSERT INTO user_game_plays (id, user_id, post_id, dwell_ms, is_fullscreen, game_type, source)
       VALUES (?, ?, ?, ?, ?, ?, 'arcade')`,
    );

    const playList = plays.slice(0, MAX_ARCADE_EVENTS_PER_REQUEST);
    const validGamePostIds = await loadValidGamePostIds(
      c.env.DB,
      playList.map((play) => play?.postId),
    );

    const statements: D1PreparedStatement[] = [];
    for (const play of playList) {
      if (!validGamePostIds.has(play.postId)) continue;
      const id = crypto.randomUUID();
      const dwellMs = Math.max(0, Math.min(Math.round(Number(play.dwellMs) || 0), 86400000));
      const isFullscreen = play.isFullscreen ? 1 : 0;
      const gameType = typeof play.gameType === 'string' ? play.gameType.slice(0, 32) : '';
      statements.push(stmt.bind(id, currentUserId, play.postId, dwellMs, isFullscreen, gameType));
    }
    await runBatched(c.env.DB, statements);

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Dwell record error:', error);
    return c.json({ error: 'Failed to record dwell' }, 500);
  }
});

export default games;
