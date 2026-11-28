import type { Context } from 'hono';
import { arcadeGameTitle } from '../../../shared/game-title.ts';
import { batchGetFreshAndBookmarkStatus } from '../helpers';
import type { Bindings, Variables } from '../types';

type GamesContext = Context<{ Bindings: Bindings; Variables: Variables }>;
type Visibility = { sql: string; params: string[] };

/** Serve one page of the shuffled Arcade feed. */
export async function serveShuffledGames(
  c: GamesContext,
  visibility: Visibility,
  currentUserId: string | undefined,
  limit: number,
) {
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
        ${visibility.sql}
      ORDER BY p.created_at DESC
    `)
      .bind(...visibility.params)
      .all();

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
          SELECT p.id FROM posts p
          WHERE p.id = ? AND p.payload_key IS NOT NULL AND p.swf_key IS NULL
            AND p.status = 'published' AND p.hidden = 0
            ${visibility.sql}
        `)
          .bind(initialId, ...visibility.params)
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
        p.id as postId, p.user_id, p.text, p.game_title, p.swf_key, p.payload_key,
        p.thumbnail_key, p.fresh_count,
        COALESCE(p.reply_count, 0) as reply_count,
        COALESCE(p.bookmark_count, 0) as bookmark_count,
        p.impressions, p.created_at,
        u.username, u.display_name, u.avatar_key, u.badge_type, u.name_color
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.id IN (${placeholders}) ${visibility.sql}
    `)
      .bind(...pageIds, ...visibility.params)
      .all<{
        postId: string;
        user_id: string;
        text: string;
        game_title: string | null;
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
          title: arcadeGameTitle(row.game_title, row.text, row.username),
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
