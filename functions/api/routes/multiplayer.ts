import { Hono } from 'hono';
import { requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const multiplayer = new Hono<{ Bindings: Bindings; Variables: Variables }>();

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

    const roomId = crypto.randomUUID();
    const now = new Date().toISOString();
    const maxPlayers = body.maxPlayers || 2;
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
    const err = error as { message?: string };
    console.error('Create room error:', error);
    return c.json({ error: 'Failed to create room', details: err.message || 'Unknown error' }, 500);
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
    const err = error as { message?: string };
    console.error('List rooms error:', error);
    return c.json({ error: 'Failed to list rooms', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/multiplayer/rooms/:id - Room details
multiplayer.get('/rooms/:id', requireAuth, async (c) => {
  try {
    const roomId = c.req.param('id');
    const room = await c.env.DB.prepare(`
      SELECT r.*, u.username as host_username, u.display_name as host_display_name, u.avatar_key as host_avatar_key
      FROM multiplayer_rooms r
      JOIN users u ON u.id = r.host_id
      WHERE r.id = ?
    `)
      .bind(roomId)
      .first();

    if (!room) return c.json({ error: 'Room not found' }, 404);

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
    const err = error as { message?: string };
    console.error('Get room error:', error);
    return c.json({ error: 'Failed to get room', details: err.message || 'Unknown error' }, 500);
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
    const err = error as { message?: string };
    console.error('Join room error:', error);
    return c.json({ error: 'Failed to join room', details: err.message || 'Unknown error' }, 500);
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
    const err = error as { message?: string };
    console.error('Leave room error:', error);
    return c.json({ error: 'Failed to leave room', details: err.message || 'Unknown error' }, 500);
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
        // Create a room for the matched players
        const roomId = crypto.randomUUID();
        const now = new Date().toISOString();
        await c.env.DB.prepare(`
          INSERT INTO multiplayer_rooms (id, game_id, host_id, status, max_players, is_public, created_at)
          VALUES (?, ?, ?, 'lobby', ?, 0, ?)
        `)
          .bind(roomId, gameId, data.players[0].userId, data.players.length, now)
          .run();

        for (const p of data.players) {
          await c.env.DB.prepare(`
            INSERT INTO multiplayer_room_participants (room_id, user_id, username, display_name, avatar_key, joined_at, is_host)
            VALUES (?, ?, ?, NULL, NULL, ?, ?)
          `)
            .bind(roomId, p.userId, p.username, now, p.userId === data.players[0].userId ? 1 : 0)
            .run();
        }

        return c.json({ matched: true, roomId, players: data.players });
      }
      return c.json({ matched: false });
    }

    return c.json({ error: 'Unknown action' }, 400);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Matchmaking error:', error);
    return c.json({ error: 'Failed to process matchmaking', details: err.message || 'Unknown error' }, 500);
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
    const err = error as { message?: string };
    console.error('Score submit error:', error);
    return c.json({ error: 'Failed to submit score', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/multiplayer/scores/:gameId - Get leaderboard
multiplayer.get('/scores/:gameId', async (c) => {
  try {
    const gameId = c.req.param('gameId');
    const limit = Math.min(Number(c.req.query('limit')) || 50, 100);
    const userId = c.req.query('userId');

    let query = `
      SELECT s.id, s.game_id, s.user_id, s.score, s.label, s.metadata, s.created_at,
             u.username, u.display_name, u.avatar_key
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
    const err = error as { message?: string };
    console.error('Leaderboard error:', error);
    return c.json({ error: 'Failed to fetch leaderboard', details: err.message || 'Unknown error' }, 500);
  }
});

export default multiplayer;
