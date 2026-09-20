import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { validateImageDimensions } from '../../lib/image-dimensions';
import { detectMimeType, isAllowedImageMime, requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const servers = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const SERVER_MAX_MEMBERS = 200;

// GET /api/servers - list my servers with unread + last message info
servers.get('/servers', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';

    const serversList = await c.env.DB.prepare(`
      SELECT
        s.id, s.name, s.description, s.icon_key, s.owner_id, s.created_at,
        sm.role as my_role,
        (SELECT COUNT(*) FROM server_members WHERE server_id = s.id AND left_at IS NULL) as member_count,
        COALESCE((
          SELECT SUM(r.unread_count)
          FROM server_read_states r
          JOIN server_channels sc ON r.channel_id = sc.id
          WHERE r.user_id = ? AND sc.server_id = s.id
        ), 0) as unread_count,
        (SELECT CASE WHEN m.enc_version IS NOT NULL THEN '[Encrypted message]' ELSE m.content END FROM server_messages m
          JOIN server_channels sc ON m.channel_id = sc.id
          WHERE sc.server_id = s.id
          ORDER BY m.created_at DESC LIMIT 1) as last_message_content,
        (SELECT m.created_at FROM server_messages m
          JOIN server_channels sc ON m.channel_id = sc.id
          WHERE sc.server_id = s.id
          ORDER BY m.created_at DESC LIMIT 1) as last_message_created_at
      FROM server_conversations s
      JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = ? AND sm.left_at IS NULL
      ORDER BY COALESCE(
        (SELECT MAX(m.created_at) FROM server_messages m
          JOIN server_channels sc ON m.channel_id = sc.id
          WHERE sc.server_id = s.id),
        s.created_at
      ) DESC
    `)
      .bind(userId, userId)
      .all();

    return c.json({
      servers: (serversList.results || []).map((row: Record<string, unknown>) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        icon_key: row.icon_key,
        owner_id: row.owner_id,
        created_at: row.created_at,
        my_role: row.my_role,
        member_count: row.member_count,
        unread_count: row.unread_count,
        last_message: row.last_message_content
          ? {
              content: row.last_message_content,
              created_at: row.last_message_created_at,
            }
          : null,
      })),
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Servers list error:', error);
    return c.json({ error: 'Failed to fetch servers', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/servers - create a server
servers.post('/servers', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const { name, description, iconKey } = (await c.req.json()) as {
      name?: string;
      description?: string;
      iconKey?: string;
    };

    if (!name || name.trim().length === 0) {
      return c.json({ error: 'Server name is required' }, 400);
    }
    if (name.trim().length > 80) {
      return c.json({ error: 'Server name must be 80 characters or less' }, 400);
    }

    const now = new Date().toISOString();
    const serverId = nanoid();

    await c.env.DB.prepare(
      'INSERT INTO server_conversations (id, name, description, icon_key, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(serverId, name.trim(), (description || '').trim(), iconKey || null, userId, now)
      .run();

    await c.env.DB.prepare("INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)")
      .bind(serverId, userId, now)
      .run();

    // Create the default #general text channel so the server is usable right away.
    const generalChannelId = nanoid();
    await c.env.DB.prepare(
      "INSERT INTO server_channels (id, server_id, name, category, position, type, key_version, created_at) VALUES (?, ?, 'general', NULL, 0, 'text', 1, ?)",
    )
      .bind(generalChannelId, serverId, now)
      .run();

    return c.json({ id: serverId, general_channel_id: generalChannelId });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server create error:', error);
    return c.json({ error: 'Failed to create server', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/servers/unread-count
servers.get('/servers/unread-count', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const result = (await c.env.DB.prepare(`
      SELECT COALESCE(SUM(r.unread_count), 0) as count
      FROM server_read_states r
      JOIN server_channels sc ON r.channel_id = sc.id
      WHERE r.user_id = ?
    `)
      .bind(userId)
      .first()) as { count: number };
    return c.json({ unread_count: result?.count || 0 });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server unread count error:', error);
    return c.json({ error: 'Failed to get unread count', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/servers/:id - server detail with channels + members
servers.get('/servers/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const serverId = c.req.param('id');

    const server = (await c.env.DB.prepare(`
      SELECT s.id, s.name, s.description, s.icon_key, s.owner_id, s.created_at,
        COALESCE((SELECT COUNT(*) FROM server_members WHERE server_id = s.id AND left_at IS NULL), 0) as member_count
      FROM server_conversations s
      JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = ? AND sm.left_at IS NULL
      WHERE s.id = ?
    `)
      .bind(userId, serverId)
      .first()) as Record<string, unknown> | null;

    if (!server) {
      return c.json({ error: 'Server not found' }, 404);
    }

    const myMember = (await c.env.DB.prepare('SELECT role FROM server_members WHERE server_id = ? AND user_id = ?')
      .bind(serverId, userId)
      .first()) as { role: string } | null;

    const channels = await c.env.DB.prepare(`
      SELECT
        sc.id, sc.name, sc.category, sc.position, sc.key_version, sc.type, sc.created_at,
        COALESCE(rs.unread_count, 0) as unread_count
      FROM server_channels sc
      LEFT JOIN server_read_states rs ON rs.channel_id = sc.id AND rs.user_id = ?
      WHERE sc.server_id = ?
      ORDER BY sc.position ASC, sc.created_at ASC
    `)
      .bind(userId, serverId)
      .all();

    const members = await c.env.DB.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar_key, sm.role, sm.joined_at
      FROM server_members sm
      JOIN users u ON sm.user_id = u.id
      WHERE sm.server_id = ? AND sm.left_at IS NULL
      ORDER BY sm.joined_at ASC
    `)
      .bind(serverId)
      .all();

    return c.json({
      id: server.id,
      name: server.name,
      description: server.description,
      icon_key: server.icon_key,
      owner_id: server.owner_id,
      created_at: server.created_at,
      member_count: server.member_count,
      my_role: myMember?.role || 'member',
      channels: (channels.results || []).map((row: Record<string, unknown>) => ({
        id: row.id,
        name: row.name,
        category: row.category || null,
        position: row.position,
        key_version: row.key_version || 1,
        type: row.type || 'text',
        unread_count: row.unread_count,
        created_at: row.created_at,
      })),
      members: (members.results || []).map((row: Record<string, unknown>) => ({
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        avatar_key: row.avatar_key,
        role: row.role,
        joined_at: row.joined_at,
      })),
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server get error:', error);
    return c.json({ error: 'Failed to fetch server', details: err.message || 'Unknown error' }, 500);
  }
});

// PATCH /api/servers/:id - update server name/description/icon (owner/admin)
servers.patch('/servers/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const serverId = c.req.param('id');
    const { name, description, iconKey } = (await c.req.json()) as {
      name?: string;
      description?: string;
      iconKey?: string | null;
    };

    const member = (await c.env.DB.prepare(
      "SELECT role FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL AND role IN ('owner', 'admin')",
    )
      .bind(serverId, userId)
      .first()) as { role: string } | null;

    if (!member) {
      return c.json({ error: 'Not authorized to edit this server' }, 403);
    }

    if (name !== undefined) {
      if (name.trim().length === 0) return c.json({ error: 'Server name cannot be empty' }, 400);
      if (name.trim().length > 80) return c.json({ error: 'Server name must be 80 characters or less' }, 400);
      await c.env.DB.prepare('UPDATE server_conversations SET name = ? WHERE id = ?').bind(name.trim(), serverId).run();
    }
    if (description !== undefined) {
      await c.env.DB.prepare('UPDATE server_conversations SET description = ? WHERE id = ?')
        .bind(description.trim().slice(0, 500), serverId)
        .run();
    }
    if (iconKey !== undefined) {
      await c.env.DB.prepare('UPDATE server_conversations SET icon_key = ? WHERE id = ?').bind(iconKey, serverId).run();
    }

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server update error:', error);
    return c.json({ error: 'Failed to update server', details: err.message || 'Unknown error' }, 500);
  }
});

// DELETE /api/servers/:id - delete server (owner only)
servers.delete('/servers/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const serverId = c.req.param('id');

    const member = (await c.env.DB.prepare(
      "SELECT role FROM server_members WHERE server_id = ? AND user_id = ? AND role = 'owner'",
    )
      .bind(serverId, userId)
      .first()) as { role: string } | null;

    if (!member) {
      return c.json({ error: 'Only the owner can delete the server' }, 403);
    }

    if (c.env.BUCKET) {
      const msgs = await c.env.DB.prepare(`
        SELECT m.gif_key, m.payload_key, m.swf_key
        FROM server_messages m
        JOIN server_channels sc ON m.channel_id = sc.id
        WHERE sc.server_id = ? AND (m.gif_key IS NOT NULL OR m.payload_key IS NOT NULL OR m.swf_key IS NOT NULL)
      `)
        .bind(serverId)
        .all();
      for (const row of msgs.results || []) {
        const m = row as Record<string, string | null>;
        for (const key of [m.gif_key, m.payload_key, m.swf_key]) {
          if (key)
            try {
              await c.env.BUCKET.delete(key);
            } catch {
              /* ignore */
            }
        }
      }
    }

    await c.env.DB.prepare('DELETE FROM server_conversations WHERE id = ?').bind(serverId).run();
    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server delete error:', error);
    return c.json({ error: 'Failed to delete server', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/servers/:id/members - add members (owner/admin)
servers.post('/servers/:id/members', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const serverId = c.req.param('id');
    const { memberIds } = (await c.req.json()) as { memberIds?: string[] };

    if (!memberIds || memberIds.length === 0) {
      return c.json({ error: 'memberIds is required' }, 400);
    }

    const member = (await c.env.DB.prepare(
      "SELECT role FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL AND role IN ('owner', 'admin')",
    )
      .bind(serverId, userId)
      .first()) as { role: string } | null;

    if (!member) {
      return c.json({ error: 'Not authorized to add members' }, 403);
    }

    const memberCount = (await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM server_members WHERE server_id = ? AND left_at IS NULL',
    )
      .bind(serverId)
      .first()) as { count: number };

    if ((memberCount?.count || 0) + memberIds.length > SERVER_MAX_MEMBERS) {
      return c.json({ error: `Server member limit is ${SERVER_MAX_MEMBERS}` }, 400);
    }

    const now = new Date().toISOString();
    await c.env.DB.batch(
      memberIds.map((mid: string) =>
        c.env.DB.prepare(`
          INSERT INTO server_members (server_id, user_id, role, joined_at, left_at)
          VALUES (?, ?, 'member', ?, NULL)
          ON CONFLICT(server_id, user_id) DO UPDATE SET left_at = NULL, joined_at = excluded.joined_at
        `).bind(serverId, mid, now),
      ),
    );

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server add member error:', error);
    return c.json({ error: 'Failed to add members', details: err.message || 'Unknown error' }, 500);
  }
});

// PUT /api/servers/:id/members/:userId - change member role (owner only)
servers.put('/servers/:id/members/:userId', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const serverId = c.req.param('id');
    const targetUserId = c.req.param('userId');
    const { role } = (await c.req.json()) as { role?: string };

    if (!role || !['owner', 'admin', 'member'].includes(role)) {
      return c.json({ error: 'Invalid role' }, 400);
    }

    const myMember = (await c.env.DB.prepare(
      'SELECT role FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL',
    )
      .bind(serverId, userId)
      .first()) as { role: string } | null;

    if (!myMember) return c.json({ error: 'Server not found' }, 404);

    const targetMember = (await c.env.DB.prepare('SELECT role FROM server_members WHERE server_id = ? AND user_id = ?')
      .bind(serverId, targetUserId)
      .first()) as { role: string } | null;

    if (!targetMember) return c.json({ error: 'Member not found' }, 404);
    if (targetUserId === userId) return c.json({ error: 'Cannot change your own role' }, 400);

    if (myMember.role !== 'owner') {
      return c.json({ error: 'Only the owner can change roles' }, 403);
    }
    if (targetMember.role === 'owner') {
      return c.json({ error: 'Cannot change the owner role' }, 403);
    }

    await c.env.DB.prepare('UPDATE server_members SET role = ? WHERE server_id = ? AND user_id = ?')
      .bind(role, serverId, targetUserId)
      .run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server role error:', error);
    return c.json({ error: 'Failed to change role', details: err.message || 'Unknown error' }, 500);
  }
});

// DELETE /api/servers/:id/members/:userId - remove member or leave
servers.delete('/servers/:id/members/:userId', requireAuth, async (c) => {
  try {
    const currentUserId = c.get('user')?.id || '';
    const serverId = c.req.param('id');
    const targetUserId = c.req.param('userId');

    const targetMember = (await c.env.DB.prepare(
      'SELECT role FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL',
    )
      .bind(serverId, targetUserId)
      .first()) as { role: string } | null;

    if (!targetMember) {
      return c.json({ error: 'Member not found' }, 404);
    }

    if (targetUserId !== currentUserId) {
      const myMember = (await c.env.DB.prepare(
        "SELECT role FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL AND role IN ('owner', 'admin')",
      )
        .bind(serverId, currentUserId)
        .first()) as { role: string } | null;

      if (!myMember) {
        return c.json({ error: 'Not authorized to remove members' }, 403);
      }
      if (targetMember.role === 'owner') {
        return c.json({ error: 'Cannot remove the server owner' }, 403);
      }
      if (targetMember.role === 'admin' && myMember.role !== 'owner') {
        return c.json({ error: 'Only the owner can remove admins' }, 403);
      }
    }

    const now = new Date().toISOString();
    await c.env.DB.prepare(
      'DELETE FROM server_read_states WHERE channel_id IN (SELECT id FROM server_channels WHERE server_id = ?) AND user_id = ?',
    )
      .bind(serverId, targetUserId)
      .run();
    await c.env.DB.prepare('UPDATE server_members SET left_at = ? WHERE server_id = ? AND user_id = ?')
      .bind(now, serverId, targetUserId)
      .run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server remove member error:', error);
    return c.json({ error: 'Failed to remove member', details: err.message || 'Unknown error' }, 500);
  }
});

// ─── Server invite links ───────────────────────────────────────────────────────

// POST /api/servers/:id/invites - create an invite link (owner/admin)
servers.post('/servers/:id/invites', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const serverId = c.req.param('id');
    const { role, maxUses, expiresInHours } = (await c.req.json()) as {
      role?: string;
      maxUses?: number | null;
      expiresInHours?: number | null;
    };

    const member = (await c.env.DB.prepare(
      "SELECT role FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL AND role IN ('owner', 'admin')",
    )
      .bind(serverId, userId)
      .first()) as { role: string } | null;

    if (!member) {
      return c.json({ error: 'Not authorized to create invites' }, 403);
    }

    // Invites never grant owner; default to member.
    const inviteRole = role === 'admin' ? 'admin' : 'member';
    const safeMaxUses = typeof maxUses === 'number' && maxUses > 0 ? Math.floor(maxUses) : null;
    const expiresAt =
      typeof expiresInHours === 'number' && expiresInHours > 0
        ? new Date(Date.now() + Math.floor(expiresInHours) * 3600 * 1000).toISOString()
        : null;

    const token = nanoid();
    await c.env.DB.prepare(
      'INSERT INTO server_invites (token, server_id, created_by, role, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(token, serverId, userId, inviteRole, safeMaxUses, expiresAt, new Date().toISOString())
      .run();

    return c.json({ token, url: `/invite/${token}`, role: inviteRole, maxUses: safeMaxUses, expiresAt });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server invite create error:', error);
    return c.json({ error: 'Failed to create invite', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/servers/:id/invites - list invites (owner/admin)
servers.get('/servers/:id/invites', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const serverId = c.req.param('id');

    const member = (await c.env.DB.prepare(
      "SELECT role FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL AND role IN ('owner', 'admin')",
    )
      .bind(serverId, userId)
      .first()) as { role: string } | null;

    if (!member) {
      return c.json({ error: 'Not authorized to view invites' }, 403);
    }

    const invites = await c.env.DB.prepare(
      'SELECT token, role, max_uses, use_count, expires_at, created_at FROM server_invites WHERE server_id = ? ORDER BY created_at DESC',
    )
      .bind(serverId)
      .all();

    return c.json({
      invites: (invites.results || []).map((row: Record<string, unknown>) => ({
        token: row.token,
        url: `/invite/${row.token}`,
        role: row.role,
        maxUses: row.max_uses ?? null,
        useCount: row.use_count,
        expiresAt: row.expires_at ?? null,
        createdAt: row.created_at,
      })),
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server invites list error:', error);
    return c.json({ error: 'Failed to list invites', details: err.message || 'Unknown error' }, 500);
  }
});

// DELETE /api/servers/:id/invites/:token - revoke an invite (owner/admin)
servers.delete('/servers/:id/invites/:token', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const serverId = c.req.param('id');
    const token = c.req.param('token');

    const member = (await c.env.DB.prepare(
      "SELECT role FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL AND role IN ('owner', 'admin')",
    )
      .bind(serverId, userId)
      .first()) as { role: string } | null;

    if (!member) {
      return c.json({ error: 'Not authorized to revoke invites' }, 403);
    }

    await c.env.DB.prepare('DELETE FROM server_invites WHERE server_id = ? AND token = ?').bind(serverId, token).run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server invite revoke error:', error);
    return c.json({ error: 'Failed to revoke invite', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/servers/invite/:token - resolve invite metadata (public, no auth).
// Never returns member lists or any E2EE key material.
servers.get('/servers/invite/:token', async (c) => {
  try {
    const token = c.req.param('token');
    const invite = (await c.env.DB.prepare(
      `SELECT i.token, i.role, i.max_uses, i.use_count, i.expires_at, i.server_id,
              s.name, s.icon_key, s.description
       FROM server_invites i
       JOIN server_conversations s ON s.id = i.server_id
       WHERE i.token = ?`,
    )
      .bind(token)
      .first()) as {
      token: string;
      role: string;
      max_uses: number | null;
      use_count: number;
      expires_at: string | null;
      server_id: string;
      name: string;
      icon_key: string | null;
      description: string;
    } | null;

    if (!invite) {
      return c.json({ error: 'Invite not found' }, 404);
    }

    const now = Date.now();
    const expired = !!invite.expires_at && new Date(invite.expires_at).getTime() <= now;
    const usedUp = invite.max_uses != null && invite.use_count >= invite.max_uses;

    return c.json({
      token: invite.token,
      serverName: invite.name,
      serverIconKey: invite.icon_key,
      serverDescription: invite.description,
      role: invite.role,
      maxUses: invite.max_uses,
      useCount: invite.use_count,
      expiresAt: invite.expires_at,
      expired,
      usedUp,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server invite resolve error:', error);
    return c.json({ error: 'Failed to resolve invite', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/servers/invite/:token/join - join a server via invite (auth user)
servers.post('/servers/invite/:token/join', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const token = c.req.param('token');

    const invite = (await c.env.DB.prepare(
      'SELECT token, server_id, role, max_uses, use_count, expires_at FROM server_invites WHERE token = ?',
    )
      .bind(token)
      .first()) as {
      token: string;
      server_id: string;
      role: string;
      max_uses: number | null;
      use_count: number;
      expires_at: string | null;
    } | null;

    if (!invite) {
      return c.json({ error: 'Invite not found' }, 404);
    }
    if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) {
      return c.json({ error: 'Invite has expired' }, 410);
    }
    if (invite.max_uses != null && invite.use_count >= invite.max_uses) {
      return c.json({ error: 'Invite has reached its usage limit' }, 410);
    }

    const now = new Date().toISOString();
    const existing = (await c.env.DB.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?')
      .bind(invite.server_id, userId)
      .first()) as { 1: number } | null;

    await c.env.DB.prepare(
      `INSERT INTO server_members (server_id, user_id, role, joined_at, left_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(server_id, user_id) DO UPDATE SET left_at = NULL, role = excluded.role, joined_at = excluded.joined_at`,
    )
      .bind(invite.server_id, userId, invite.role, now)
      .run();

    // Only count a use when the user was not already an active/former member.
    if (!existing) {
      await c.env.DB.prepare('UPDATE server_invites SET use_count = use_count + 1 WHERE token = ?').bind(token).run();
    }

    return c.json({ success: true, serverId: invite.server_id, role: invite.role });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server invite join error:', error);
    return c.json({ error: 'Failed to join server', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/servers/:id/channels - create a channel (owner/admin)
servers.post('/servers/:id/channels', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const serverId = c.req.param('id');
    const { name, category, position, type } = (await c.req.json()) as {
      name?: string;
      category?: string;
      position?: number;
      type?: 'text' | 'voice';
    };

    if (!name || name.trim().length === 0) {
      return c.json({ error: 'Channel name is required' }, 400);
    }
    if (name.trim().length > 80) {
      return c.json({ error: 'Channel name must be 80 characters or less' }, 400);
    }

    const member = (await c.env.DB.prepare(
      "SELECT role FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL AND role IN ('owner', 'admin')",
    )
      .bind(serverId, userId)
      .first()) as { role: string } | null;

    if (!member) {
      return c.json({ error: 'Not authorized to create channels' }, 403);
    }

    const id = nanoid();
    const now = new Date().toISOString();
    const pos = position ?? 0;
    const channelType = type === 'voice' ? 'voice' : 'text';

    await c.env.DB.prepare(
      'INSERT INTO server_channels (id, server_id, name, category, position, type, key_version, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    )
      .bind(id, serverId, name.trim(), category?.trim() || null, pos, channelType, now)
      .run();

    return c.json({ id, key_version: 1, type: channelType });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server channel create error:', error);
    return c.json({ error: 'Failed to create channel', details: err.message || 'Unknown error' }, 500);
  }
});

// PUT /api/servers/:id/channels/:channelId - update channel (owner/admin)
servers.put('/servers/:id/channels/:channelId', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const serverId = c.req.param('id');
    const channelId = c.req.param('channelId');
    const { name, category, position, type } = (await c.req.json()) as {
      name?: string;
      category?: string | null;
      position?: number;
      type?: 'text' | 'voice';
    };

    const ch = (await c.env.DB.prepare('SELECT id FROM server_channels WHERE id = ? AND server_id = ?')
      .bind(channelId, serverId)
      .first()) as { id: string } | null;

    if (!ch) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    const member = (await c.env.DB.prepare(
      "SELECT role FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL AND role IN ('owner', 'admin')",
    )
      .bind(serverId, userId)
      .first()) as { role: string } | null;

    if (!member) {
      return c.json({ error: 'Not authorized to update channels' }, 403);
    }

    if (name !== undefined) {
      if (name.trim().length === 0) return c.json({ error: 'Channel name cannot be empty' }, 400);
      await c.env.DB.prepare('UPDATE server_channels SET name = ? WHERE id = ?')
        .bind(name.trim().slice(0, 80), channelId)
        .run();
    }
    if (category !== undefined) {
      await c.env.DB.prepare('UPDATE server_channels SET category = ? WHERE id = ?')
        .bind(category?.trim().slice(0, 80) || null, channelId)
        .run();
    }
    if (position !== undefined) {
      await c.env.DB.prepare('UPDATE server_channels SET position = ? WHERE id = ?').bind(position, channelId).run();
    }
    if (type !== undefined) {
      await c.env.DB.prepare('UPDATE server_channels SET type = ? WHERE id = ?')
        .bind(type === 'voice' ? 'voice' : 'text', channelId)
        .run();
    }

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server channel update error:', error);
    return c.json({ error: 'Failed to update channel', details: err.message || 'Unknown error' }, 500);
  }
});

// DELETE /api/servers/:id/channels/:channelId - delete channel (owner/admin)
servers.delete('/servers/:id/channels/:channelId', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const serverId = c.req.param('id');
    const channelId = c.req.param('channelId');

    const ch = (await c.env.DB.prepare('SELECT id FROM server_channels WHERE id = ? AND server_id = ?')
      .bind(channelId, serverId)
      .first()) as { id: string } | null;

    if (!ch) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    const member = (await c.env.DB.prepare(
      "SELECT role FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL AND role IN ('owner', 'admin')",
    )
      .bind(serverId, userId)
      .first()) as { role: string } | null;

    if (!member) {
      return c.json({ error: 'Not authorized to delete channels' }, 403);
    }

    if (c.env.BUCKET) {
      const msgs = await c.env.DB.prepare(
        'SELECT gif_key, payload_key, swf_key FROM server_messages WHERE channel_id = ? AND (gif_key IS NOT NULL OR payload_key IS NOT NULL OR swf_key IS NOT NULL)',
      )
        .bind(channelId)
        .all();
      for (const row of msgs.results || []) {
        const m = row as Record<string, string | null>;
        for (const key of [m.gif_key, m.payload_key, m.swf_key]) {
          if (key)
            try {
              await c.env.BUCKET.delete(key);
            } catch {
              /* ignore */
            }
        }
      }
    }

    await c.env.DB.prepare('DELETE FROM server_channels WHERE id = ?').bind(channelId).run();
    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server channel delete error:', error);
    return c.json({ error: 'Failed to delete channel', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/servers/:id/keys - submit wrapped channel keys (rotation on membership changes)
servers.post('/servers/:id/keys', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const serverId = c.req.param('id');
    const { channelId, keyVersion, boxes } = (await c.req.json()) as {
      channelId?: string;
      keyVersion?: number;
      boxes?: Array<{ userId: string; wrappedKey: string; wrappedIv: string }>;
    };

    if (!channelId || typeof keyVersion !== 'number' || !boxes || boxes.length === 0) {
      return c.json({ error: 'channelId, keyVersion and boxes are required' }, 400);
    }

    const ch = (await c.env.DB.prepare('SELECT id FROM server_channels WHERE id = ? AND server_id = ?')
      .bind(channelId, serverId)
      .first()) as { id: string } | null;

    if (!ch) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    const myMember = (await c.env.DB.prepare(
      'SELECT role FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL',
    )
      .bind(serverId, userId)
      .first()) as { role: string } | null;

    if (!myMember) {
      return c.json({ error: 'Server not found' }, 404);
    }

    // Any current member may submit wrapped keys, but only server owners/admins
    // may wrap keys on behalf of OTHER members. A plain member can only submit
    // their own box, which prevents one member from silently overwriting
    // another member's wrapped channel key.
    const isPrivileged = myMember.role === 'owner' || myMember.role === 'admin';

    const memberIds = await c.env.DB.prepare(
      'SELECT user_id FROM server_members WHERE server_id = ? AND left_at IS NULL',
    )
      .bind(serverId)
      .all();
    const currentIds = new Set((memberIds.results || []).map((r) => (r as { user_id: string }).user_id));

    for (const b of boxes) {
      if (!currentIds.has(b.userId)) {
        return c.json({ error: 'Key recipient is not a current member' }, 400);
      }
      if (!isPrivileged && b.userId !== userId) {
        return c.json({ error: 'Only server admins may wrap keys for other members' }, 403);
      }
    }

    await c.env.DB.batch(
      boxes.map((b) =>
        c.env.DB.prepare(`
          INSERT INTO server_channel_keys (channel_id, key_version, user_id, wrapped_key, wrapped_iv, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(channel_id, key_version, user_id) DO UPDATE SET
            wrapped_key = excluded.wrapped_key,
            wrapped_iv = excluded.wrapped_iv
        `).bind(channelId, keyVersion, b.userId, b.wrappedKey, b.wrappedIv, new Date().toISOString()),
      ),
    );

    await c.env.DB.prepare('UPDATE server_channels SET key_version = ? WHERE id = ?').bind(keyVersion, channelId).run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server keys error:', error);
    return c.json({ error: 'Failed to store keys', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/servers/:id/channels/:channelId/keys - fetch my wrapped keys for a channel
servers.get('/servers/:id/channels/:channelId/keys', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const serverId = c.req.param('id');
    const channelId = c.req.param('channelId');

    const ch = (await c.env.DB.prepare('SELECT key_version FROM server_channels WHERE id = ? AND server_id = ?')
      .bind(channelId, serverId)
      .first()) as { key_version: number } | null;

    if (!ch) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    const member = await c.env.DB.prepare(
      'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL',
    )
      .bind(serverId, userId)
      .first();

    if (!member) {
      return c.json({ error: 'Server not found' }, 404);
    }

    const keys = await c.env.DB.prepare(
      'SELECT key_version, wrapped_key, wrapped_iv FROM server_channel_keys WHERE channel_id = ? AND user_id = ?',
    )
      .bind(channelId, userId)
      .all();

    return c.json({
      key_version: ch.key_version,
      keys: (keys.results || []).map((row: Record<string, unknown>) => ({
        key_version: row.key_version,
        wrapped_key: row.wrapped_key,
        wrapped_iv: row.wrapped_iv,
      })),
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server keys get error:', error);
    return c.json({ error: 'Failed to fetch keys', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/servers/:id/channels/:channelId/messages - cursor-based messages
servers.get('/servers/:id/channels/:channelId/messages', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const serverId = c.req.param('id');
    const channelId = c.req.param('channelId');
    const cursor = c.req.query('cursor');
    const after = c.req.query('after');
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);

    const member = await c.env.DB.prepare(
      'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL',
    )
      .bind(serverId, userId)
      .first();

    if (!member) {
      return c.json({ error: 'Server not found' }, 404);
    }

    const ch = await c.env.DB.prepare('SELECT id FROM server_channels WHERE id = ? AND server_id = ?')
      .bind(channelId, serverId)
      .first();

    if (!ch) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    let messages: { results?: Array<Record<string, unknown>> };
    if (after) {
      // Realtime poll: messages at-or-newer than the client's latest, oldest-first.
      messages = await c.env.DB.prepare(`
        SELECT m.id, m.channel_id, m.sender_id, m.content, m.created_at,
               m.gif_key, m.payload_key, m.swf_key, m.edited_at,
                m.content_iv, m.enc_version, m.key_version,
                m.reply_to_id, m.pinned, m.stamp_id,
               u.username as sender_username, u.display_name as sender_display_name,
               u.avatar_key as sender_avatar_key
        FROM server_messages m
        JOIN users u ON m.sender_id = u.id
        WHERE m.channel_id = ? AND m.created_at >= ?
        ORDER BY m.created_at ASC
        LIMIT ?
      `)
        .bind(channelId, after, limit)
        .all();
    } else if (cursor) {
      messages = await c.env.DB.prepare(`
        SELECT m.id, m.channel_id, m.sender_id, m.content, m.created_at,
               m.gif_key, m.payload_key, m.swf_key, m.edited_at,
                m.content_iv, m.enc_version, m.key_version,
                m.reply_to_id, m.pinned, m.stamp_id,
               u.username as sender_username, u.display_name as sender_display_name,
               u.avatar_key as sender_avatar_key
        FROM server_messages m
        JOIN users u ON m.sender_id = u.id
        WHERE m.channel_id = ? AND m.created_at < ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `)
        .bind(channelId, cursor, limit)
        .all();
    } else {
      messages = await c.env.DB.prepare(`
        SELECT m.id, m.channel_id, m.sender_id, m.content, m.created_at,
               m.gif_key, m.payload_key, m.swf_key, m.edited_at,
                m.content_iv, m.enc_version, m.key_version,
                m.reply_to_id, m.pinned, m.stamp_id,
               u.username as sender_username, u.display_name as sender_display_name,
               u.avatar_key as sender_avatar_key
        FROM server_messages m
        JOIN users u ON m.sender_id = u.id
        WHERE m.channel_id = ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `)
        .bind(channelId, limit)
        .all();
    }

    const rows = (messages.results || []) as Array<Record<string, unknown>>;
    const nextCursor = rows.length === limit ? (rows[rows.length - 1].created_at as string) : null;

    // Batch-fetch stamp data for messages that have stamp_id
    const stampIds = [...new Set(rows.filter((r) => r.stamp_id).map((r) => r.stamp_id as string))];
    const stampMap = new Map<string, { name: string; image_key: string }>();
    if (stampIds.length > 0) {
      const placeholders = stampIds.map(() => '?').join(',');
      const stampRows = await c.env.DB.prepare(
        `SELECT id, name, image_key FROM custom_stamps WHERE id IN (${placeholders})`,
      )
        .bind(...stampIds)
        .all<{ id: string; name: string; image_key: string }>();
      for (const s of stampRows.results || []) {
        stampMap.set(s.id, { name: s.name, image_key: s.image_key });
      }
    }

    return c.json({
      messages: rows.map((row) => {
        const stamp = row.stamp_id ? stampMap.get(row.stamp_id as string) : undefined;
        return {
          id: row.id,
          channel_id: row.channel_id,
          sender_id: row.sender_id,
          content: row.content,
          gif_key: row.gif_key || null,
          payload_key: row.payload_key || null,
          swf_key: row.swf_key || null,
          content_iv: row.content_iv || null,
          enc_version: row.enc_version || null,
          key_version: row.key_version || 1,
          reply_to_id: row.reply_to_id || null,
          pinned: row.pinned || 0,
          stamp_id: row.stamp_id || null,
          stamp_url: stamp ? `/api/images/${stamp.image_key}` : null,
          stamp_name: stamp ? stamp.name : null,
          created_at: row.created_at,
          edited_at: row.edited_at || null,
          is_mine: row.sender_id === userId,
          sender: {
            id: row.sender_id,
            username: row.sender_username,
            display_name: row.sender_display_name,
            avatar_key: row.sender_avatar_key || null,
          },
        };
      }),
      next_cursor: nextCursor,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server messages error:', error);
    return c.json({ error: 'Failed to fetch messages', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/servers/:id/channels/:channelId/messages - send a message (ciphertext only)
servers.post('/servers/:id/channels/:channelId/messages', requireAuth, async (c) => {
  try {
    const user = c.get('user')!;
    const senderId = user.id;
    const serverId = c.req.param('id');
    const channelId = c.req.param('channelId');
    const { content, gifKey, payloadKey, swfKey, messageId, contentIv, encVersion, keyVersion, stampId } =
      (await c.req.json()) as {
        content?: string;
        gifKey?: string;
        payloadKey?: string;
        swfKey?: string;
        messageId?: string;
        contentIv?: string;
        encVersion?: number;
        keyVersion?: number;
        stampId?: string;
      };

    const trimmed = content?.trim() || '';
    if (!trimmed && !gifKey && !payloadKey && !swfKey && !stampId) {
      return c.json({ error: 'Content or file attachment is required' }, 400);
    }
    const isEncrypted = typeof encVersion === 'number' && encVersion > 0;
    const maxLen = isEncrypted ? 2000 : 200;
    if (trimmed.length > maxLen) {
      return c.json({ error: `Message must be ${maxLen} characters or less` }, 400);
    }

    const member = await c.env.DB.prepare(
      'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL',
    )
      .bind(serverId, senderId)
      .first();

    if (!member) {
      return c.json({ error: 'Server not found' }, 404);
    }

    const ch = await c.env.DB.prepare('SELECT id, key_version FROM server_channels WHERE id = ? AND server_id = ?')
      .bind(channelId, serverId)
      .first();

    if (!ch) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    // Validate stampId if provided
    let stampUrl: string | null = null;
    let stampName: string | null = null;
    if (stampId) {
      const stamp = await c.env.DB.prepare('SELECT id, name, image_key FROM custom_stamps WHERE id = ? AND user_id = ?')
        .bind(stampId, senderId)
        .first<{ id: string; name: string; image_key: string }>();
      if (!stamp) {
        return c.json({ error: 'Stamp not found' }, 404);
      }
      stampUrl = `/api/images/${stamp.image_key}`;
      stampName = stamp.name;
    }

    const msgId = messageId || nanoid();
    const now = new Date().toISOString();

    await c.env.DB.prepare(
      'INSERT INTO server_messages (id, channel_id, sender_id, content, created_at, gif_key, payload_key, swf_key, content_iv, enc_version, key_version, stamp_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        msgId,
        channelId,
        senderId,
        trimmed,
        now,
        gifKey || null,
        payloadKey || null,
        swfKey || null,
        contentIv || null,
        isEncrypted ? encVersion : null,
        keyVersion || 1,
        stampId || null,
      )
      .run();

    await c.env.DB.prepare(
      'INSERT OR REPLACE INTO server_read_states (user_id, channel_id, last_read_message_id, unread_count) VALUES (?, ?, ?, 0)',
    )
      .bind(senderId, channelId, msgId)
      .run();

    const otherMembers = await c.env.DB.prepare(
      'SELECT user_id FROM server_members WHERE server_id = ? AND user_id != ? AND left_at IS NULL',
    )
      .bind(serverId, senderId)
      .all();

    const otherIds = (otherMembers.results || []) as Array<{ user_id: string }>;
    if (otherIds.length > 0) {
      const stmts = otherIds.map((m) =>
        c.env.DB.prepare(`
          INSERT INTO server_read_states (user_id, channel_id, last_read_message_id, unread_count)
          VALUES (?, ?, NULL, 1)
          ON CONFLICT(user_id, channel_id) DO UPDATE SET unread_count = unread_count + 1
        `).bind(m.user_id, channelId),
      );
      await c.env.DB.batch(stmts);
    }

    return c.json({
      id: msgId,
      channel_id: channelId,
      sender_id: senderId,
      content: trimmed,
      gif_key: gifKey || null,
      payload_key: payloadKey || null,
      swf_key: swfKey || null,
      content_iv: contentIv || null,
      enc_version: isEncrypted ? encVersion : null,
      key_version: isEncrypted ? keyVersion || 1 : null,
      stamp_id: stampId || null,
      stamp_url: stampUrl,
      stamp_name: stampName,
      created_at: now,
      edited_at: null,
      is_mine: true,
      sender: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar_key: user.avatar_key || null,
      },
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server send message error:', error);
    return c.json({ error: 'Failed to send message', details: err.message || 'Unknown error' }, 500);
  }
});

// PUT /api/servers/:id/channels/:channelId/messages/:msgId - edit a message
servers.put('/servers/:id/channels/:channelId/messages/:msgId', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const channelId = c.req.param('channelId');
    const msgId = c.req.param('msgId');
    const { content, contentIv, encVersion, keyVersion } = (await c.req.json()) as {
      content?: string;
      contentIv?: string;
      encVersion?: number;
      keyVersion?: number;
    };

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return c.json({ error: 'Content is required' }, 400);
    }
    const trimmed = content.trim();
    const isEncrypted = typeof encVersion === 'number' && encVersion > 0;
    const maxLen = isEncrypted ? 2000 : 200;
    if (trimmed.length > maxLen) {
      return c.json({ error: `Message must be ${maxLen} characters or less` }, 400);
    }

    const msg = (await c.env.DB.prepare(
      'SELECT id FROM server_messages WHERE id = ? AND channel_id = ? AND sender_id = ?',
    )
      .bind(msgId, channelId, userId)
      .first()) as { id: string } | null;

    if (!msg) {
      return c.json({ error: 'Message not found or not yours to edit' }, 404);
    }

    const now = new Date().toISOString();
    await c.env.DB.prepare(
      'UPDATE server_messages SET content = ?, edited_at = ?, content_iv = ?, enc_version = ?, key_version = ? WHERE id = ?',
    )
      .bind(trimmed, now, contentIv || null, isEncrypted ? encVersion : null, keyVersion || 1, msgId)
      .run();

    return c.json({
      id: msgId,
      content: trimmed,
      content_iv: contentIv || null,
      enc_version: isEncrypted ? encVersion : null,
      key_version: keyVersion || null,
      edited_at: now,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server edit message error:', error);
    return c.json({ error: 'Failed to edit message', details: err.message || 'Unknown error' }, 500);
  }
});

// DELETE /api/servers/:id/channels/:channelId/messages/:msgId - delete a message
servers.delete('/servers/:id/channels/:channelId/messages/:msgId', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const channelId = c.req.param('channelId');
    const msgId = c.req.param('msgId');

    const msg = (await c.env.DB.prepare(
      'SELECT id, sender_id, gif_key, payload_key, swf_key FROM server_messages WHERE id = ? AND channel_id = ?',
    )
      .bind(msgId, channelId)
      .first()) as {
      id: string;
      sender_id: string;
      gif_key?: string;
      payload_key?: string;
      swf_key?: string;
    } | null;

    if (!msg) {
      return c.json({ error: 'Message not found' }, 404);
    }
    if (msg.sender_id !== userId) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (c.env.BUCKET) {
      for (const key of [msg.gif_key, msg.payload_key, msg.swf_key]) {
        if (key)
          try {
            await c.env.BUCKET.delete(key);
          } catch {
            /* ignore */
          }
      }
    }

    await c.env.DB.prepare('DELETE FROM server_messages WHERE id = ?').bind(msgId).run();
    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server delete message error:', error);
    return c.json({ error: 'Failed to delete message', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/servers/:id/channels/:channelId/messages/prepare - prepare attachment upload
servers.post('/servers/:id/channels/:channelId/messages/prepare', requireAuth, async (c) => {
  try {
    const senderId = c.get('user')?.id || '';
    const serverId = c.req.param('id');
    const channelId = c.req.param('channelId');
    const { filename } = (await c.req.json()) as { filename?: string };

    if (!filename) {
      return c.json({ error: 'Missing filename' }, 400);
    }

    const member = await c.env.DB.prepare(
      'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL',
    )
      .bind(serverId, senderId)
      .first();

    if (!member) {
      return c.json({ error: 'Server not found' }, 404);
    }
    const ch = await c.env.DB.prepare('SELECT id FROM server_channels WHERE id = ? AND server_id = ?')
      .bind(channelId, serverId)
      .first();
    if (!ch) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    const name = filename.toLowerCase();
    const ext = name.match(/\.(\w+)$/)?.[1];
    const msgId = nanoid();
    const prefix = `server/${channelId}`;

    let storageKey: string;
    let responseType: 'gif' | 'zip' | 'swf';

    if (name.endsWith('.swf') || ext === 'swf') {
      storageKey = `${prefix}/swf/${msgId}.swf`;
      responseType = 'swf';
    } else if (name.endsWith('.zip')) {
      storageKey = `${prefix}/zip/${msgId}.zip`;
      responseType = 'zip';
    } else if (name.endsWith('.html') || name.endsWith('.htm')) {
      storageKey = `${prefix}/html/${msgId}.html`;
      responseType = 'zip';
    } else if (ext && ['mp3', 'wav', 'ogg', 'm4a', 'webm'].includes(ext)) {
      const extMap: Record<string, string> = { mp3: '.mp3', wav: '.wav', ogg: '.ogg', m4a: '.m4a', webm: '.webm' };
      storageKey = `${prefix}/audio/${msgId}${extMap[ext]}`;
      responseType = 'gif';
    } else if (ext && ['mp4', 'webm', 'mov'].includes(ext)) {
      const extMap: Record<string, string> = { mp4: '.mp4', webm: '.webm', mov: '.mov' };
      storageKey = `${prefix}/video/${msgId}${extMap[ext]}`;
      responseType = 'gif';
    } else if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
      const extMap: Record<string, string> = {
        png: '.png',
        jpg: '.jpg',
        jpeg: '.jpg',
        gif: '.gif',
        webp: '.webp',
        svg: '.svg',
        bmp: '.bmp',
        ico: '.ico',
      };
      storageKey = `${prefix}/gif/${msgId}${extMap[ext]}`;
      responseType = 'gif';
    } else {
      return c.json({ error: 'Unsupported file type' }, 400);
    }

    const origin = new URL(c.req.url).origin;
    const uploadUrl = `${origin}/api/servers/upload/${storageKey}`;
    const resp: Record<string, unknown> = { msgId, uploadUrl, storageKey };

    if (responseType === 'zip') {
      resp.payloadKey = storageKey;
    } else if (responseType === 'swf') {
      resp.swfKey = storageKey;
    } else {
      resp.gifKey = storageKey;
    }

    return c.json(resp);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server prepare error:', error);
    return c.json({ error: 'Failed to prepare message', details: err.message || 'Unknown error' }, 500);
  }
});

// PUT /api/servers/upload/:key - upload an E2EE-encrypted file blob (ciphertext, no MIME validation)
servers.put('/servers/upload/*', requireAuth, async (c) => {
  try {
    const key = c.req.path.replace('/api/servers/upload/', '');
    const contentLength = c.req.header('content-length');

    if (!key) {
      return c.json({ error: 'Missing file key' }, 400);
    }

    const maxSize = 25 * 1024 * 1024;
    if (contentLength && Number(contentLength) > maxSize) {
      return c.json({ error: 'File too large. Maximum size is 25MB' }, 413);
    }

    const fileData = await c.req.arrayBuffer();
    if (fileData.byteLength > maxSize) {
      return c.json({ error: 'File too large. Maximum size is 25MB' }, 413);
    }

    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    await c.env.BUCKET.put(key, fileData, {
      httpMetadata: { contentType: 'application/octet-stream' },
    });

    return c.json({ success: true, key });
  } catch (error: unknown) {
    console.error('Server upload error:', error);
    return c.json({ error: 'Upload failed' }, 500);
  }
});

// GET /api/servers/files/:key - serve an encrypted attachment blob to an authenticated member
servers.get('/servers/files/*', requireAuth, async (c) => {
  try {
    const key = c.req.path.replace('/api/servers/files/', '');
    if (!key) {
      return c.json({ error: 'Missing file key' }, 400);
    }
    if (!c.env.BUCKET || !(await c.env.BUCKET.head(key))) {
      return c.json({ error: 'File not found' }, 404);
    }

    if (!c.get('user')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const obj = await c.env.BUCKET.get(key);
    if (!obj) {
      return c.json({ error: 'File not found' }, 404);
    }
    return new Response(obj.body, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': String(obj.size),
      },
    });
  } catch (error: unknown) {
    console.error('Server file error:', error);
    return c.json({ error: 'Failed to fetch file' }, 500);
  }
});

// POST /api/servers/:id/channels/:channelId/read - mark channel as read
servers.post('/servers/:id/channels/:channelId/read', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const serverId = c.req.param('id');
    const channelId = c.req.param('channelId');

    const member = await c.env.DB.prepare(
      'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL',
    )
      .bind(serverId, userId)
      .first();

    if (!member) {
      return c.json({ error: 'Server not found' }, 404);
    }

    const ch = await c.env.DB.prepare('SELECT id FROM server_channels WHERE id = ? AND server_id = ?')
      .bind(channelId, serverId)
      .first();
    if (!ch) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    const lastMsg = (await c.env.DB.prepare(
      'SELECT id FROM server_messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1',
    )
      .bind(channelId)
      .first()) as { id: string } | null;

    if (lastMsg) {
      await c.env.DB.prepare(
        'INSERT OR REPLACE INTO server_read_states (user_id, channel_id, last_read_message_id, unread_count) VALUES (?, ?, ?, 0)',
      )
        .bind(userId, channelId, lastMsg.id)
        .run();
    } else {
      await c.env.DB.prepare(
        'INSERT OR REPLACE INTO server_read_states (user_id, channel_id, last_read_message_id, unread_count) VALUES (?, ?, NULL, 0)',
      )
        .bind(userId, channelId)
        .run();
    }

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Server mark read error:', error);
    return c.json({ error: 'Failed to mark as read', details: err.message || 'Unknown error' }, 500);
  }
});

// PUT /api/servers/icon - upload a server icon image, returns an R2 key
servers.put('/servers/icon', requireAuth, async (c) => {
  try {
    const fileData = await c.req.arrayBuffer();
    if (fileData.byteLength === 0) {
      return c.json({ error: 'Empty file' }, 400);
    }
    const maxSize = 2 * 1024 * 1024;
    if (fileData.byteLength > maxSize) {
      return c.json({ error: 'Icon too large. Maximum size is 2MB' }, 413);
    }
    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    const detectedMime = detectMimeType(fileData);
    if (!detectedMime || !isAllowedImageMime(detectedMime)) {
      return c.json({ error: 'Unrecognized image format.' }, 400);
    }
    const dimError = validateImageDimensions(fileData, detectedMime);
    if (dimError) {
      return c.json({ error: dimError }, 413);
    }

    const iconKey = `server/icon/${nanoid()}.png`;
    await c.env.BUCKET.put(iconKey, fileData, { httpMetadata: { contentType: detectedMime } });
    return c.json({ success: true, iconKey });
  } catch (error: unknown) {
    console.error('Server icon upload error:', error);
    return c.json({ error: 'Icon upload failed' }, 500);
  }
});

export default servers;
