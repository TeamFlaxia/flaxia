import { Hono } from 'hono';
import { clampLimit } from '../../lib/pagination';
import { checkRateLimit, getClientIp } from '../../lib/rate-limit';
import { requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const multiplayer = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/** Room creation throttle: minting a room also instantiates a Durable Object. */
async function checkRoomRateLimit(c: { req: { raw: Request }; env: Bindings }, userId: string): Promise<boolean> {
  const ip = getClientIp(c.req.raw);
  const byUser = await checkRateLimit(c.env.CACHE, `mp:rooms:user:${userId}`, { maxRequests: 10, windowSeconds: 60 });
  if (!byUser) return false;
  return checkRateLimit(c.env.CACHE, `mp:rooms:ip:${ip}`, { maxRequests: 30, windowSeconds: 60 });
}

// POST /api/multiplayer/rooms - Create a room
multiplayer.post('/rooms', requireAuth, async (c) => {
  try {
    const user = c.get('user')!;
    let body: {
      gameId: string;
      maxPlayers?: number;
      isPublic?: boolean;
      metadata?: Record<string, unknown>;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.gameId) {
      return c.json({ error: 'gameId is required' }, 400);
    }
    if (typeof body.gameId !== 'string' || body.gameId.length > 128) {
      return c.json({ error: 'Invalid gameId' }, 400);
    }
    if (body.metadata !== undefined) {
      let metadataSize = 0;
      try {
        metadataSize = JSON.stringify(body.metadata).length;
      } catch {
        return c.json({ error: 'Invalid metadata' }, 400);
      }
      if (metadataSize > 4096) {
        return c.json({ error: 'Metadata too large' }, 400);
      }
    }
    if (!(await checkRoomRateLimit(c, user.id))) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const roomId = crypto.randomUUID();
    const now = new Date().toISOString();
    // Clamp player count: unbounded maxPlayers breaks capacity checks and DO sizing.
    const maxPlayers = Math.min(Math.max(Math.floor(Number(body.maxPlayers) || 2), 2), 8);
    const isPublic = body.isPublic !== false;

    await c.env.DB.prepare(`
      INSERT INTO multiplayer_rooms (id, game_id, host_id, status, max_players, is_public, metadata, created_at)
      VALUES (?, ?, ?, 'lobby', ?, ?, ?, ?)
    `)
      .bind(
        roomId,
        body.gameId,
        user.id,
        maxPlayers,
        isPublic ? 1 : 0,
        body.metadata ? JSON.stringify(body.metadata) : null,
        now,
      )
      .run();

    // The host occupies the first player slot.
    await c.env.DB.prepare(`
      INSERT OR REPLACE INTO multiplayer_room_participants (room_id, user_id, username, display_name, avatar_key, joined_at, is_host)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `)
      .bind(roomId, user.id, user.username, user.display_name || null, user.avatar_key || null, now)
      .run();

    // Create DO instance for the room (lazy — will be instantiated on first WebSocket connection)
    const roomDoId = c.env.MULTIPLAYER_ROOM!.idFromName(roomId);
    c.env.MULTIPLAYER_ROOM!.get(roomDoId);

    return c.json(
      {
        roomId,
        gameId: body.gameId,
        hostId: user.id,
        maxPlayers,
        isPublic,
        createdAt: now,
      },
      201,
    );
  } catch (error: unknown) {
    console.error('Create room error:', error);
    return c.json({ error: 'Failed to create room' }, 500);
  }
});

// GET /api/multiplayer/rooms - List public rooms
multiplayer.get('/rooms', requireAuth, async (c) => {
  try {
    const gameId = c.req.query('gameId');
    const status = c.req.query('status') || 'lobby';

    let query = `
      SELECT r.id, r.game_id, r.host_id, r.status, r.max_players,
             r.is_public, r.metadata, r.created_at,
             (SELECT COUNT(*) FROM multiplayer_room_participants WHERE room_id = r.id AND left_at IS NULL) as player_count
      FROM multiplayer_rooms r
      WHERE r.is_public = 1 AND r.status = ?
    `;
    const params: unknown[] = [status];

    if (gameId) {
      query += ' AND r.game_id = ?';
      params.push(gameId);
    }

    query += ' ORDER BY r.created_at DESC LIMIT 50';

    const result = (await c.env.DB.prepare(query)
      .bind(...params)
      .all()) as {
      results: Record<string, unknown>[];
    };

    return c.json({ rooms: result.results || [] });
  } catch (error: unknown) {
    console.error('List rooms error:', error);
    return c.json({ error: 'Failed to list rooms' }, 500);
  }
});

// GET /api/multiplayer/rooms/:id - Room details
multiplayer.get('/rooms/:id', requireAuth, async (c) => {
  try {
    const roomId = c.req.param('id');
    const room = await c.env.DB.prepare(`
      SELECT r.*, u.username as host_username, u.display_name as host_display_name, u.avatar_key as host_avatar_key, u.badge_type as host_badge_type
      FROM multiplayer_rooms r
      JOIN users u ON u.id = r.host_id
      WHERE r.id = ?
    `)
      .bind(roomId)
      .first();

    if (!room) return c.json({ error: 'Room not found' }, 404);

    // Private rooms are confidential: only the host and participants may read them.
    const roomRow = room as { is_public?: number; host_id?: string };
    if (!roomRow.is_public) {
      const user = c.get('user')!;
      const member =
        roomRow.host_id === user.id
          ? { ok: true }
          : await c.env.DB.prepare(
              'SELECT 1 FROM multiplayer_room_participants WHERE room_id = ? AND user_id = ? AND left_at IS NULL',
            )
              .bind(roomId, user.id)
              .first();
      if (!member) return c.json({ error: 'Forbidden' }, 403);
    }

    const participantsResult = (await c.env.DB.prepare(`
      SELECT p.user_id, p.username, p.display_name, p.avatar_key, p.joined_at, p.is_host
      FROM multiplayer_room_participants p
      WHERE p.room_id = ? AND p.left_at IS NULL
      ORDER BY p.joined_at ASC
    `)
      .bind(roomId)
      .all()) as { results: Record<string, unknown>[] };

    return c.json({ room, participants: participantsResult.results || [] });
  } catch (error: unknown) {
    console.error('Get room error:', error);
    return c.json({ error: 'Failed to get room' }, 500);
  }
});

// POST /api/multiplayer/rooms/:id/join - Join a room
multiplayer.post('/rooms/:id/join', requireAuth, async (c) => {
  try {
    const user = c.get('user')!;
    const roomId = c.req.param('id');

    const room = (await c.env.DB.prepare('SELECT * FROM multiplayer_rooms WHERE id = ?')
      .bind(roomId)
      .first()) as Record<string, unknown> | null;
    if (!room) return c.json({ error: 'Room not found' }, 404);
    if (room.status !== 'lobby') return c.json({ error: 'Game already in progress' }, 400);

    // No invite system exists: private rooms are joinable only by members
    // (rejoin). Anyone else learning the UUID must not enter.
    if (!room.is_public) {
      const member = await c.env.DB.prepare(
        'SELECT 1 FROM multiplayer_room_participants WHERE room_id = ? AND user_id = ?',
      )
        .bind(roomId, user.id)
        .first();
      if (!member) return c.json({ error: 'Forbidden' }, 403);
    }

    const playerCount = (await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM multiplayer_room_participants WHERE room_id = ? AND left_at IS NULL',
    )
      .bind(roomId)
      .first()) as { count: number };

    if (playerCount.count >= (room.max_players as number)) {
      return c.json({ error: 'Room is full' }, 400);
    }

    const now = new Date().toISOString();
    await c.env.DB.prepare(`
      INSERT OR REPLACE INTO multiplayer_room_participants (room_id, user_id, username, display_name, avatar_key, joined_at, is_host)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `)
      .bind(roomId, user.id, user.username, user.display_name || null, user.avatar_key || null, now)
      .run();

    return c.json({
      success: true,
      roomId,
      userId: user.id,
      wsUrl: `/api/ws/multiplayer?roomId=${roomId}&gameId=${room.game_id as string}`,
    });
  } catch (error: unknown) {
    console.error('Join room error:', error);
    return c.json({ error: 'Failed to join room' }, 500);
  }
});

// POST /api/multiplayer/rooms/:id/leave - Leave a room
multiplayer.post('/rooms/:id/leave', requireAuth, async (c) => {
  try {
    const user = c.get('user')!;
    const roomId = c.req.param('id');

    const now = new Date().toISOString();
    await c.env.DB.prepare(
      'UPDATE multiplayer_room_participants SET left_at = ? WHERE room_id = ? AND user_id = ? AND left_at IS NULL',
    )
      .bind(now, roomId, user.id)
      .run();

    return c.json({ success: true });
  } catch (error: unknown) {
    console.error('Leave room error:', error);
    return c.json({ error: 'Failed to leave room' }, 500);
  }
});

// POST /api/multiplayer/matchmaking - Join matchmaking queue
multiplayer.post('/matchmaking', requireAuth, async (c) => {
  try {
    const user = c.get('user')!;
    const { gameId, action } = (await c.req.json()) as { gameId: string; action: 'join' | 'leave' | 'check' };

    if (!gameId) return c.json({ error: 'gameId is required' }, 400);
    if (!c.env.MATCHMAKER) return c.json({ error: 'Matchmaking not available' }, 503);

    const doId = c.env.MATCHMAKER.idFromName(`matchmaker:${gameId}`);
    const stub = c.env.MATCHMAKER.get(doId);

    if (action === 'join') {
      const resp = await stub.fetch('http://internal/', {
        method: 'POST',
        body: JSON.stringify({
          action: 'join_queue',
          userId: user.id,
          username: user.username,
          gameId,
        }),
      });
      const data = (await resp.json()) as { status: string; position?: number };
      return c.json(data);
    }

    if (action === 'leave') {
      await stub.fetch('http://internal/', {
        method: 'POST',
        body: JSON.stringify({ action: 'leave_queue', userId: user.id, gameId }),
      });
      return c.json({ status: 'left_queue' });
    }

    if (action === 'check') {
      const resp = await stub.fetch('http://internal/', {
        method: 'POST',
        body: JSON.stringify({ action: 'check_match', userId: user.id, gameId, maxPlayers: 2 }),
      });
      const data = (await resp.json()) as { matched: boolean; players?: Array<{ userId: string; username: string }> };
      if (data.matched && data.players) {
        // Defense in depth (the DO also enforces this): only create a room
        // when the caller is one of the matched players.
        if (!data.players.some((p) => p.userId === user.id)) {
          return c.json({ error: 'Forbidden' }, 403);
        }
        // The consuming caller is the only player who receives the roomId,
        // so it must also be the recorded host. Pinning the host to
        // players[0] would leave the room unstartable when a later-queued
        // player wins the polling race (only the caller knows the room,
        // and only the host may start it).
        const roomId = crypto.randomUUID();
        const now = new Date().toISOString();
        await c.env.DB.prepare(`
          INSERT INTO multiplayer_rooms (id, game_id, host_id, status, max_players, is_public, created_at)
          VALUES (?, ?, ?, 'lobby', ?, 0, ?)
        `)
          .bind(roomId, gameId, user.id, data.players.length, now)
          .run();

        for (const p of data.players) {
          await c.env.DB.prepare(`
            INSERT INTO multiplayer_room_participants (room_id, user_id, username, display_name, avatar_key, joined_at, is_host)
            VALUES (?, ?, ?, NULL, NULL, ?, ?)
          `)
            .bind(roomId, p.userId, p.username, now, p.userId === user.id ? 1 : 0)
            .run();
        }

        return c.json({ matched: true, roomId, players: data.players });
      }
      return c.json({ matched: false });
    }

    return c.json({ error: 'Unknown action' }, 400);
  } catch (error: unknown) {
    console.error('Matchmaking error:', error);
    return c.json({ error: 'Failed to process matchmaking' }, 500);
  }
});

// POST /api/multiplayer/scores - Submit a score
multiplayer.post('/scores', requireAuth, async (c) => {
  try {
    const user = c.get('user')!;
    const { gameId, score, label, metadata } = (await c.req.json()) as {
      gameId: string;
      score: number;
      label?: string;
      metadata?: Record<string, unknown>;
    };

    if (!gameId || typeof score !== 'number' || Number.isNaN(score)) {
      return c.json({ error: 'Invalid score data' }, 400);
    }
    if (typeof gameId !== 'string' || gameId.length === 0 || gameId.length > 128) {
      return c.json({ error: 'Invalid gameId' }, 400);
    }
    // Scores are client-asserted (no server-side game result exists yet):
    // bound them so forged leaderboard entries stay within sane ranges.
    if (!Number.isFinite(score) || score < 0 || score > 1000000000) {
      return c.json({ error: 'Invalid score value' }, 400);
    }
    if (label !== undefined && (typeof label !== 'string' || label.length > 64)) {
      return c.json({ error: 'Invalid label' }, 400);
    }
    if (metadata !== undefined) {
      let metadataSize = 0;
      try {
        metadataSize = JSON.stringify(metadata).length;
      } catch {
        return c.json({ error: 'Invalid metadata' }, 400);
      }
      if (metadataSize > 2048) {
        return c.json({ error: 'Metadata too large' }, 400);
      }
    }
    if (!(await checkRateLimit(c.env.CACHE, `mp:scores:${user.id}`, { maxRequests: 30, windowSeconds: 60 }))) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    // #122: bound rows per user/game/day on top of the rate limit so a
    // sustained script cannot grow the table without bound.
    const todayCount = (await c.env.DB.prepare(
      `SELECT COUNT(*) as n FROM multiplayer_scores
       WHERE user_id = ? AND game_id = ? AND created_at >= date('now')`,
    )
      .bind(user.id, gameId)
      .first()) as { n: number } | null;
    if ((todayCount?.n ?? 0) >= 100) {
      return c.json({ error: 'Daily score limit reached' }, 429);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await c.env.DB.prepare(`
      INSERT INTO multiplayer_scores (id, game_id, user_id, score, label, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(id, gameId, user.id, score, label || null, metadata ? JSON.stringify(metadata) : null, now)
      .run();

    return c.json({ id, score, label: label || null }, 201);
  } catch (error: unknown) {
    console.error('Score submit error:', error);
    return c.json({ error: 'Failed to submit score' }, 500);
  }
});

// GET /api/multiplayer/scores/:gameId - Get leaderboard
multiplayer.get('/scores/:gameId', async (c) => {
  try {
    const gameId = c.req.param('gameId');
    const limit = clampLimit(c.req.query('limit'), 50, 100);
    const userId = c.req.query('userId');

    let query = `
      SELECT s.id, s.game_id, s.user_id, s.score, s.label, s.metadata, s.created_at,
             u.username, u.display_name, u.avatar_key, u.badge_type
      FROM multiplayer_scores s
      JOIN users u ON u.id = s.user_id
      WHERE s.game_id = ?
    `;
    const params: unknown[] = [gameId];

    if (userId) {
      query += ' AND s.user_id = ?';
      params.push(userId);
    }

    query += ' ORDER BY s.score DESC LIMIT ?';
    params.push(limit);

    const result = (await c.env.DB.prepare(query)
      .bind(...params)
      .all()) as {
      results: Record<string, unknown>[];
    };

    return c.json({ scores: result.results || [] });
  } catch (error: unknown) {
    console.error('Leaderboard error:', error);
    return c.json({ error: 'Failed to fetch leaderboard' }, 500);
  }
});

export default multiplayer;
