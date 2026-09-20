import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { sendPushToAll } from '../../lib/notify';
import { requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const calls = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// POST /api/calls/start - Start a voice/video call in a group
calls.post('/calls/start', requireAuth, async (c) => {
  try {
    const user = c.get('user')!;
    const { groupId, type } = (await c.req.json()) as {
      groupId?: string;
      type?: 'audio' | 'video';
    };

    if (!groupId) {
      return c.json({ error: 'groupId is required' }, 400);
    }

    // The DB is the source of truth for call state: an active call the user is
    // already a participant of means they cannot start another. (The realtime
    // Durable Object only reflects participants who have opened a socket, so it
    // must not be used to consider a freshly created call "stale".)
    const existingActive = await c.env.DB.prepare(
      `SELECT c.id FROM calls c JOIN call_participants cp ON cp.call_id = c.id
       WHERE cp.user_id = ? AND c.status = 'active' LIMIT 1`,
    )
      .bind(user.id)
      .first<{ id: string }>();
    if (existingActive) {
      return c.json({ error: 'You are already in an active call' }, 409);
    }

    const callType = type === 'video' ? 'video' : 'audio';
    const callId = nanoid();

    // Verify group membership
    const member = await c.env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, user.id)
      .first();
    if (!member) return c.json({ error: 'Not a member of this group' }, 403);

    // Create call record — immediately active
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      'INSERT INTO calls (id, group_id, initiator_id, status, type, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(callId, groupId, user.id, 'active', callType, now)
      .run();

    // Add initiator as first participant
    await c.env.DB.prepare('INSERT INTO call_participants (call_id, user_id, joined_at, muted) VALUES (?, ?, ?, 0)')
      .bind(callId, user.id, now)
      .run();

    // Notify other group members
    const members = (await c.env.DB.prepare(
      'SELECT gm.user_id FROM group_members gm WHERE gm.group_id = ? AND gm.user_id != ?',
    )
      .bind(groupId, user.id)
      .all()) as { results: { user_id: string }[] };

    const actorName = user.display_name || user.username || 'Someone';
    for (const m of members.results) {
      await sendPushToAll(
        c.env as unknown as Parameters<typeof sendPushToAll>[0],
        m.user_id,
        'call',
        user.username,
        actorName,
        `${callType === 'video' ? '📹' : '📞'} Group call in progress`,
        callId,
      );
    }

    return c.json({ id: callId, roomId: callId, type: callType });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Call start error:', error);
    return c.json({ error: 'Failed to start call', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/servers/:id/channels/:channelId/call - Start/join a voice call in a server voice channel
calls.post('/servers/:id/channels/:channelId/call', requireAuth, async (c) => {
  try {
    const user = c.get('user')!;
    const serverId = c.req.param('id');
    const channelId = c.req.param('channelId');
    const { type } = (await c.req.json().catch(() => ({}))) as { type?: 'audio' | 'video' };

    // Verify the user is a member of this server
    const member = await c.env.DB.prepare(
      'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL',
    )
      .bind(serverId, user.id)
      .first();
    if (!member) return c.json({ error: 'Not a member of this server' }, 403);

    // Verify the channel belongs to this server and is a voice channel
    const channel = (await c.env.DB.prepare(
      "SELECT id, name FROM server_channels WHERE id = ? AND server_id = ? AND type = 'voice'",
    )
      .bind(channelId, serverId)
      .first()) as { id: string; name: string } | null;
    if (!channel) return c.json({ error: 'Voice channel not found' }, 404);

    // Check the user is not already in another active call
    const existingActive = await c.env.DB.prepare(
      `SELECT c.id FROM calls c JOIN call_participants cp ON cp.call_id = c.id
       WHERE cp.user_id = ? AND c.status = 'active' LIMIT 1`,
    )
      .bind(user.id)
      .first<{ id: string }>();
    if (existingActive) {
      return c.json({ error: 'You are already in an active call' }, 409);
    }

    // Reuse an active call for this channel, or create one
    let call = (await c.env.DB.prepare(
      "SELECT id, type FROM calls WHERE server_channel_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    )
      .bind(channelId)
      .first()) as { id: string; type: string } | null;

    const now = new Date().toISOString();
    if (!call) {
      const callType = type === 'video' ? 'video' : 'audio';
      const callId = nanoid();
      await c.env.DB.prepare(
        'INSERT INTO calls (id, server_channel_id, initiator_id, status, type, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind(callId, channelId, user.id, 'active', callType, now)
        .run();
      call = { id: callId, type: callType };
    }

    // Add/refresh this user as a participant
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO call_participants (call_id, user_id, joined_at, muted) VALUES (?, ?, ?, 0)',
    )
      .bind(call.id, user.id, now)
      .run();

    return c.json({ id: call.id, roomId: call.id, type: call.type, channel_name: channel.name });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server call start error:', error);
    return c.json({ error: 'Failed to start call', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/calls/:id/join - Join an active call
calls.post('/calls/:id/join', requireAuth, async (c) => {
  try {
    const user = c.get('user')!;
    const callId = c.req.param('id');

    const call = (await c.env.DB.prepare('SELECT id, status, type FROM calls WHERE id = ?').bind(callId).first()) as {
      id: string;
      status: string;
      type: string;
    } | null;

    if (!call) return c.json({ error: 'Call not found' }, 404);
    if (call.status === 'ended' || call.status === 'missed') {
      return c.json({ error: 'Call has ended' }, 410);
    }

    // Check the user is not already in another active/ringing call
    const existingActive = await c.env.DB.prepare(
      `SELECT c.id FROM calls c JOIN call_participants cp ON cp.call_id = c.id
       WHERE cp.user_id = ? AND c.status IN ('ringing', 'active') LIMIT 1`,
    )
      .bind(user.id)
      .first<{ id: string }>();
    if (existingActive) {
      return c.json({ error: 'You are already in an active call' }, 409);
    }

    // Verify user is a participant
    const isMember = await c.env.DB.prepare('SELECT 1 FROM call_participants WHERE call_id = ? AND user_id = ?')
      .bind(callId, user.id)
      .first();

    if (!isMember) {
      // Check DM, group, or server channel membership
      const fullCall = (await c.env.DB.prepare(
        'SELECT conversation_id, group_id, server_channel_id FROM calls WHERE id = ?',
      )
        .bind(callId)
        .first()) as { conversation_id: string | null; group_id: string | null; server_channel_id: string | null };
      let authorized = false;
      if (fullCall.conversation_id) {
        const conv = await c.env.DB.prepare(
          'SELECT 1 FROM dm_conversations WHERE id = ? AND (user_a_id = ? OR user_b_id = ?)',
        )
          .bind(fullCall.conversation_id, user.id, user.id)
          .first();
        authorized = !!conv;
      } else if (fullCall.group_id) {
        const member = await c.env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
          .bind(fullCall.group_id, user.id)
          .first();
        authorized = !!member;
      } else if (fullCall.server_channel_id) {
        const member = await c.env.DB.prepare(
          `SELECT 1 FROM server_channels sc
           JOIN server_members sm ON sm.server_id = sc.server_id AND sm.user_id = ? AND sm.left_at IS NULL
           WHERE sc.id = ?`,
        )
          .bind(user.id, fullCall.server_channel_id)
          .first();
        authorized = !!member;
      }
      if (!authorized) return c.json({ error: 'Not a participant' }, 403);
    }

    // Update call status to active
    if (call.status === 'ringing') {
      await c.env.DB.prepare("UPDATE calls SET status = 'active' WHERE id = ?").bind(callId).run();
    }

    // Add as participant if not already
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO call_participants (call_id, user_id, joined_at, muted) VALUES (?, ?, ?, 0)',
    )
      .bind(callId, user.id, new Date().toISOString())
      .run();

    // Return WebSocket URL for signaling
    const wsProtocol = c.req.url.startsWith('https') ? 'wss:' : 'ws:';
    const wsHost = new URL(c.req.url).host;
    const _baseUrl = c.req.url.startsWith('https') ? 'https:' : 'http:';

    const wsUrl = `${wsProtocol}//${wsHost}/api/ws/call?roomId=${callId}&token=`;

    return c.json({
      id: call.id,
      roomId: callId,
      type: call.type,
      wsUrl,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Call join error:', error);
    return c.json({ error: 'Failed to join call', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/calls/:id/end - End a call
calls.post('/calls/:id/end', requireAuth, async (c) => {
  try {
    const user = c.get('user')!;
    const callId = c.req.param('id');

    const call = (await c.env.DB.prepare('SELECT id, initiator_id, status FROM calls WHERE id = ?')
      .bind(callId)
      .first()) as { id: string; initiator_id: string; status: string } | null;

    if (!call) return c.json({ error: 'Call not found' }, 404);

    // Anyone in the call can end it
    const participant = await c.env.DB.prepare('SELECT 1 FROM call_participants WHERE call_id = ? AND user_id = ?')
      .bind(callId, user.id)
      .first();

    if (!participant) return c.json({ error: 'Not in this call' }, 403);

    const now = new Date().toISOString();
    await c.env.DB.prepare("UPDATE calls SET status = 'ended', ended_at = ? WHERE id = ?").bind(now, callId).run();

    // Notify DO to end the call
    if (c.env.CALL_STREAM && callId) {
      try {
        const doId = c.env.CALL_STREAM.idFromName(callId);
        const stub = c.env.CALL_STREAM.get(doId);
        await stub.fetch('http://internal/end', {
          method: 'POST',
          body: JSON.stringify({ action: 'end-call', userId: user.id }),
        });
      } catch {
        // DO might not exist if no WebSocket was connected
      }
    }

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Call end error:', error);
    return c.json({ error: 'Failed to end call', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/calls/:id/mute - Toggle mute state
calls.post('/calls/:id/mute', requireAuth, async (c) => {
  try {
    const user = c.get('user')!;
    const callId = c.req.param('id');
    const { muted } = (await c.req.json()) as { muted: boolean };

    await c.env.DB.prepare('UPDATE call_participants SET muted = ? WHERE call_id = ? AND user_id = ?')
      .bind(muted ? 1 : 0, callId, user.id)
      .run();

    return c.json({ success: true, muted });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Call mute error:', error);
    return c.json({ error: 'Failed to toggle mute', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/calls/active - Get user's active calls
calls.get('/calls/active', requireAuth, async (c) => {
  try {
    const user = c.get('user')!;

    const activeCalls = (await c.env.DB.prepare(`
      SELECT c.id, c.conversation_id, c.group_id, c.type, c.status, c.created_at,
             c.initiator_id, u.username as initiator_username, u.display_name as initiator_display_name
      FROM calls c
      JOIN call_participants cp ON cp.call_id = c.id
      JOIN users u ON u.id = c.initiator_id
      WHERE cp.user_id = ? AND c.status IN ('ringing', 'active')
      ORDER BY c.created_at DESC
    `)
      .bind(user.id)
      .all()) as { results: Record<string, unknown>[] };

    return c.json({ calls: activeCalls.results || [] });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Active calls error:', error);
    return c.json({ error: 'Failed to fetch active calls', details: err.message || 'Unknown error' }, 500);
  }
});

export default calls;
