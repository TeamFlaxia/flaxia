import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { validateImageDimensions } from '../../lib/image-dimensions';
import { detectMimeType, isAllowedImageMime, requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const groups = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// GET /api/groups - list user's groups with last message and unread count
groups.get('/groups', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';

    const groups = await c.env.DB.prepare(`
      SELECT
        g.id, g.name, g.description, g.icon_key, g.created_by, g.created_at, g.key_version,
        gm.role as my_role,
        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count,
        (SELECT CASE WHEN enc_version IS NOT NULL THEN '[Encrypted message]' ELSE content END FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_message_content,
        (SELECT created_at FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_message_created_at,
        (SELECT sender_id FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_message_sender_id,
        COALESCE(grs.unread_count, 0) as unread_count
      FROM group_conversations g
      JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
      LEFT JOIN group_read_states grs ON grs.group_id = g.id AND grs.user_id = ?
      ORDER BY COALESCE(
        (SELECT created_at FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1),
        g.created_at
      ) DESC
    `)
      .bind(userId, userId)
      .all();

    return c.json({
      groups: (groups.results || []).map((row: Record<string, unknown>) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        icon_key: row.icon_key,
        created_by: row.created_by,
        created_at: row.created_at,
        key_version: row.key_version || 1,
        my_role: row.my_role,
        member_count: row.member_count,
        last_message: row.last_message_content
          ? {
              content: row.last_message_content,
              sender_id: row.last_message_sender_id,
              created_at: row.last_message_created_at,
              is_mine: row.last_message_sender_id === userId,
            }
          : null,
        unread_count: row.unread_count,
      })),
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Groups list error:', error);
    return c.json({ error: 'Failed to fetch groups', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/groups - create a new group
groups.post('/groups', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const { name, description, memberIds } = (await c.req.json()) as {
      name?: string;
      description?: string;
      memberIds?: string[];
    };

    if (!name || name.trim().length === 0) {
      return c.json({ error: 'Group name is required' }, 400);
    }
    if (name.trim().length > 50) {
      return c.json({ error: 'Group name must be 50 characters or less' }, 400);
    }
    if (!memberIds || memberIds.length === 0) {
      return c.json({ error: 'At least one member is required' }, 400);
    }
    if (memberIds.length > 50) {
      return c.json({ error: 'Maximum 50 members per group' }, 400);
    }
    if (memberIds.includes(userId)) {
      return c.json({ error: 'You are already included automatically' }, 400);
    }

    const now = new Date().toISOString();
    const groupId = nanoid();

    // Insert group
    await c.env.DB.prepare(
      'INSERT INTO group_conversations (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(groupId, name.trim(), (description || '').trim(), userId, now)
      .run();

    // Insert owner as member
    await c.env.DB.prepare("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)")
      .bind(groupId, userId, now)
      .run();

    // Insert initial members (batched)
    if (memberIds.length > 0) {
      await c.env.DB.batch(
        memberIds.map((mid: string) =>
          c.env.DB.prepare(
            "INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
          ).bind(groupId, mid, now),
        ),
      );
    }

    return c.json({ id: groupId });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group create error:', error);
    return c.json({ error: 'Failed to create group', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/groups/unread-count - get total unread group count
groups.get('/groups/unread-count', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';

    const result = (await c.env.DB.prepare(`
      SELECT COALESCE(SUM(grs.unread_count), 0) as count
      FROM group_read_states grs
      JOIN group_members gm ON gm.group_id = grs.group_id AND gm.user_id = grs.user_id
      WHERE grs.user_id = ?
    `)
      .bind(userId)
      .first()) as { count: number };

    return c.json({ unread_count: result?.count || 0 });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group unread count error:', error);
    return c.json({ error: 'Failed to get unread count', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/groups/:id - get group details
groups.get('/groups/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');

    const group = (await c.env.DB.prepare(`
      SELECT g.id, g.name, g.description, g.icon_key, g.created_by, g.created_at, g.key_version,
             gm.role as my_role
      FROM group_conversations g
      JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
      WHERE g.id = ?
    `)
      .bind(userId, groupId)
      .first()) as Record<string, unknown> | null;

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    // Get members
    const members = await c.env.DB.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar_key, gm.role, gm.joined_at
      FROM group_members gm
      JOIN users u ON gm.user_id = u.id
      WHERE gm.group_id = ?
      ORDER BY gm.joined_at ASC
    `)
      .bind(groupId)
      .all();

    return c.json({
      id: group.id,
      name: group.name,
      description: group.description,
      icon_key: group.icon_key,
      created_by: group.created_by,
      created_at: group.created_at,
      key_version: group.key_version || 1,
      my_role: group.my_role,
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
    console.error('Group get error:', error);
    return c.json({ error: 'Failed to fetch group', details: err.message || 'Unknown error' }, 500);
  }
});

// PUT /api/groups/:id - update group name/description/icon
groups.put('/groups/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
    const { name, description } = (await c.req.json()) as { name?: string; description?: string };

    // Check membership and role
    const member = (await c.env.DB.prepare(
      "SELECT role FROM group_members WHERE group_id = ? AND user_id = ? AND role IN ('owner', 'admin')",
    )
      .bind(groupId, userId)
      .first()) as { role: string } | null;

    if (!member) {
      return c.json({ error: 'Not authorized to edit this group' }, 403);
    }

    if (name !== undefined) {
      if (name.trim().length === 0) return c.json({ error: 'Group name cannot be empty' }, 400);
      if (name.trim().length > 50) return c.json({ error: 'Group name must be 50 characters or less' }, 400);
      await c.env.DB.prepare('UPDATE group_conversations SET name = ? WHERE id = ?').bind(name.trim(), groupId).run();
    }

    if (description !== undefined) {
      await c.env.DB.prepare('UPDATE group_conversations SET description = ? WHERE id = ?')
        .bind(description.trim(), groupId)
        .run();
    }

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group update error:', error);
    return c.json({ error: 'Failed to update group', details: err.message || 'Unknown error' }, 500);
  }
});

// DELETE /api/groups/:id - delete group (owner only)
groups.delete('/groups/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');

    const member = (await c.env.DB.prepare(
      "SELECT role FROM group_members WHERE group_id = ? AND user_id = ? AND role = 'owner'",
    )
      .bind(groupId, userId)
      .first()) as { role: string } | null;

    if (!member) {
      return c.json({ error: 'Only the owner can delete the group' }, 403);
    }

    // Delete associated files from R2
    if (c.env.BUCKET) {
      const msgs = await c.env.DB.prepare(
        'SELECT gif_key, payload_key, swf_key FROM group_messages WHERE group_id = ? AND (gif_key IS NOT NULL OR payload_key IS NOT NULL OR swf_key IS NOT NULL)',
      )
        .bind(groupId)
        .all();

      for (const msg of msgs.results || []) {
        const m = msg as Record<string, string | null>;
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

    await c.env.DB.prepare('DELETE FROM group_conversations WHERE id = ?').bind(groupId).run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group delete error:', error);
    return c.json({ error: 'Failed to delete group', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/groups/:id/members - add members to group
groups.post('/groups/:id/members', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
    const { memberIds } = (await c.req.json()) as { memberIds?: string[] };

    if (!memberIds || memberIds.length === 0) {
      return c.json({ error: 'memberIds is required' }, 400);
    }

    // Check authorization (owner or admin)
    const member = (await c.env.DB.prepare(
      "SELECT role FROM group_members WHERE group_id = ? AND user_id = ? AND role IN ('owner', 'admin')",
    )
      .bind(groupId, userId)
      .first()) as { role: string } | null;

    if (!member) {
      return c.json({ error: 'Not authorized to add members' }, 403);
    }

    const now = new Date().toISOString();

    if (memberIds.length > 0) {
      await c.env.DB.batch(
        memberIds.map((mid: string) =>
          c.env.DB.prepare(
            "INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
          ).bind(groupId, mid, now),
        ),
      );
    }

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group add member error:', error);
    return c.json({ error: 'Failed to add members', details: err.message || 'Unknown error' }, 500);
  }
});

// DELETE /api/groups/:id/members/:userId - remove member or leave
groups.delete('/groups/:id/members/:userId', requireAuth, async (c) => {
  try {
    const currentUserId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
    const targetUserId = c.req.param('userId');

    const targetMember = (await c.env.DB.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, targetUserId)
      .first()) as { role: string } | null;

    if (!targetMember) {
      return c.json({ error: 'Member not found' }, 404);
    }

    // Allow if: current user is removing themselves, or current user is owner/admin
    if (targetUserId !== currentUserId) {
      const myMember = (await c.env.DB.prepare(
        "SELECT role FROM group_members WHERE group_id = ? AND user_id = ? AND role IN ('owner', 'admin')",
      )
        .bind(groupId, currentUserId)
        .first()) as { role: string } | null;

      if (!myMember) {
        return c.json({ error: 'Not authorized to remove members' }, 403);
      }

      // Cannot remove the owner
      if (targetMember.role === 'owner') {
        return c.json({ error: 'Cannot remove the group owner' }, 403);
      }

      // Admins cannot remove other admins (unless they're the owner)
      if (targetMember.role === 'admin' && myMember.role !== 'owner') {
        return c.json({ error: 'Only the owner can remove admins' }, 403);
      }
    }

    // Delete read states for this user
    await c.env.DB.prepare('DELETE FROM group_read_states WHERE group_id = ? AND user_id = ?')
      .bind(groupId, targetUserId)
      .run();

    await c.env.DB.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, targetUserId)
      .run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group remove member error:', error);
    return c.json({ error: 'Failed to remove member', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/groups/:id/messages - get group messages (cursor-based)
groups.get('/groups/:id/messages', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
    const cursor = c.req.query('cursor');
    const after = c.req.query('after');
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);

    // Verify membership
    const member = await c.env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, userId)
      .first();

    if (!member) {
      return c.json({ error: 'Group not found' }, 404);
    }

    let messages: { results?: Array<Record<string, unknown>> };
    if (after) {
      // Realtime poll: messages at-or-newer than the client's latest, oldest-first.
      messages = await c.env.DB.prepare(`
        SELECT m.id, m.group_id, m.sender_id, m.content, m.created_at,
               m.gif_key, m.payload_key, m.swf_key, m.edited_at,
                m.content_iv, m.enc_version, m.key_version,
                m.stamp_id,
                u.username as sender_username, u.display_name as sender_display_name,
               u.avatar_key as sender_avatar_key
        FROM group_messages m
        JOIN users u ON m.sender_id = u.id
        WHERE m.group_id = ? AND m.created_at >= ?
        ORDER BY m.created_at ASC
        LIMIT ?
      `)
        .bind(groupId, after, limit)
        .all();
    } else if (cursor) {
      messages = await c.env.DB.prepare(`
        SELECT m.id, m.group_id, m.sender_id, m.content, m.created_at,
               m.gif_key, m.payload_key, m.swf_key, m.edited_at,
                m.content_iv, m.enc_version, m.key_version,
                m.stamp_id,
                u.username as sender_username, u.display_name as sender_display_name,
               u.avatar_key as sender_avatar_key
        FROM group_messages m
        JOIN users u ON m.sender_id = u.id
        WHERE m.group_id = ? AND m.created_at < ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `)
        .bind(groupId, cursor, limit)
        .all();
    } else {
      messages = await c.env.DB.prepare(`
        SELECT m.id, m.group_id, m.sender_id, m.content, m.created_at,
               m.gif_key, m.payload_key, m.swf_key, m.edited_at,
                m.content_iv, m.enc_version, m.key_version,
                m.stamp_id,
                u.username as sender_username, u.display_name as sender_display_name,
               u.avatar_key as sender_avatar_key
        FROM group_messages m
        JOIN users u ON m.sender_id = u.id
        WHERE m.group_id = ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `)
        .bind(groupId, limit)
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
          group_id: row.group_id,
          sender_id: row.sender_id,
          content: row.content,
          gif_key: row.gif_key || null,
          payload_key: row.payload_key || null,
          swf_key: row.swf_key || null,
          content_iv: row.content_iv || null,
          enc_version: row.enc_version || null,
          key_version: row.key_version || null,
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
    console.error('Group messages error:', error);
    return c.json({ error: 'Failed to fetch messages', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/groups/:id/messages - send a message to a group
groups.post('/groups/:id/messages', requireAuth, async (c) => {
  try {
    const senderId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
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

    // Verify membership
    const member = await c.env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, senderId)
      .first();

    if (!member) {
      return c.json({ error: 'Group not found' }, 404);
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
      'INSERT INTO group_messages (id, group_id, sender_id, content, created_at, gif_key, payload_key, swf_key, content_iv, enc_version, key_version, stamp_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        msgId,
        groupId,
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

    // Reset unread count for self, increment for all other members
    await c.env.DB.prepare(
      'INSERT OR REPLACE INTO group_read_states (user_id, group_id, last_read_message_id, unread_count) VALUES (?, ?, ?, 0)',
    )
      .bind(senderId, groupId, msgId)
      .run();

    // Increment unread for other members (insert or update) — batched
    const otherMembers = await c.env.DB.prepare('SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?')
      .bind(groupId, senderId)
      .all();

    const otherIds = (otherMembers.results || []) as Array<{ user_id: string }>;
    if (otherIds.length > 0) {
      const stmts = otherIds.map((m) =>
        c.env.DB.prepare(`
          INSERT INTO group_read_states (user_id, group_id, last_read_message_id, unread_count)
          VALUES (?, ?, NULL, 1)
          ON CONFLICT(user_id, group_id) DO UPDATE SET unread_count = unread_count + 1
        `).bind(m.user_id, groupId),
      );
      await c.env.DB.batch(stmts);
    }

    const sender = c.get('user');
    return c.json({
      id: msgId,
      group_id: groupId,
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
        id: senderId,
        username: sender?.username || '',
        display_name: sender?.display_name || sender?.username || '',
        avatar_key: null,
      },
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group send message error:', error);
    return c.json({ error: 'Failed to send message', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/groups/:id/messages/prepare - prepare file attachment upload
groups.post('/groups/:id/messages/prepare', requireAuth, async (c) => {
  try {
    const senderId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
    const { filename } = (await c.req.json()) as { filename?: string };

    if (!filename) {
      return c.json({ error: 'Missing filename' }, 400);
    }

    // Verify membership
    const member = await c.env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, senderId)
      .first();

    if (!member) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const name = filename.toLowerCase();
    const ext = name.match(/\.(\w+)$/)?.[1];
    const msgId = nanoid();

    let storageKey: string;
    let responseType: 'gif' | 'zip' | 'swf';

    if (name.endsWith('.swf') || ext === 'swf') {
      storageKey = `group/swf/${msgId}.swf`;
      responseType = 'swf';
    } else if (name.endsWith('.zip')) {
      storageKey = `group/zip/${msgId}.zip`;
      responseType = 'zip';
    } else if (name.endsWith('.html') || name.endsWith('.htm')) {
      storageKey = `group/html/${msgId}.html`;
      responseType = 'zip';
    } else if (ext && ['mp3', 'wav', 'ogg', 'm4a', 'webm'].includes(ext)) {
      const extMap: Record<string, string> = { mp3: '.mp3', wav: '.wav', ogg: '.ogg', m4a: '.m4a', webm: '.webm' };
      storageKey = `group/audio/${msgId}${extMap[ext]}`;
      responseType = 'gif';
    } else if (ext && ['mp4', 'webm', 'mov'].includes(ext)) {
      const extMap: Record<string, string> = { mp4: '.mp4', webm: '.webm', mov: '.mov' };
      storageKey = `group/video/${msgId}${extMap[ext]}`;
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
      storageKey = `group/gif/${msgId}${extMap[ext]}`;
      responseType = 'gif';
    } else {
      return c.json({ error: 'Unsupported file type' }, 400);
    }

    const origin = new URL(c.req.url).origin;
    const uploadUrl = `${origin}/api/groups/upload/${storageKey}`;
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
    console.error('Group prepare error:', error);
    return c.json({ error: 'Failed to prepare message', details: err.message || 'Unknown error' }, 500);
  }
});

// PUT /api/groups/upload/:key — direct file upload for group messages
groups.put('/groups/upload/*', requireAuth, async (c) => {
  try {
    const key = c.req.path.replace('/api/groups/upload/', '');
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

    const detectedMime = detectMimeType(fileData);
    if (!detectedMime) {
      return c.json({ error: 'Unrecognized file format. Magic bytes do not match any allowed type.' }, 400);
    }
    if (
      !isAllowedImageMime(detectedMime) &&
      !detectedMime.startsWith('audio/') &&
      !detectedMime.startsWith('video/') &&
      detectedMime !== 'application/zip' &&
      detectedMime !== 'application/x-shockwave-flash' &&
      detectedMime !== 'text/html'
    ) {
      return c.json({ error: 'File type not allowed' }, 400);
    }

    // Reject oversized images to prevent renderer OOM crashes when decoded in the browser
    const dimError = validateImageDimensions(fileData, detectedMime);
    if (dimError) {
      return c.json({ error: dimError }, 413);
    }

    await c.env.BUCKET.put(key, fileData, {
      httpMetadata: { contentType: detectedMime },
    });

    return c.json({ success: true, key });
  } catch (error: unknown) {
    console.error('Group upload error:', error);
    return c.json({ error: 'Upload failed' }, 500);
  }
});

// PUT /api/groups/:id/messages/:msgId - edit a group message
groups.put('/groups/:id/messages/:msgId', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
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
      'SELECT id, content, content_iv, enc_version, key_version FROM group_messages WHERE id = ? AND group_id = ? AND sender_id = ?',
    )
      .bind(msgId, groupId, userId)
      .first()) as {
      id: string;
      content: string;
      content_iv: string | null;
      enc_version: number | null;
      key_version: number | null;
    } | null;

    if (!msg) {
      return c.json({ error: 'Message not found or not yours to edit' }, 404);
    }

    const now = new Date().toISOString();
    await c.env.DB.prepare(
      'UPDATE group_messages SET content = ?, edited_at = ?, content_iv = ?, enc_version = ?, key_version = ? WHERE id = ?',
    )
      .bind(
        trimmed,
        now,
        contentIv || msg.content_iv || null,
        isEncrypted ? encVersion : msg.enc_version || null,
        keyVersion || msg.key_version || 1,
        msgId,
      )
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
    console.error('Group edit message error:', error);
    return c.json({ error: 'Failed to edit message', details: err.message || 'Unknown error' }, 500);
  }
});

// DELETE /api/groups/:id/messages/:msgId - delete a group message
groups.delete('/groups/:id/messages/:msgId', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
    const msgId = c.req.param('msgId');

    const msg = (await c.env.DB.prepare(
      'SELECT id, sender_id, gif_key, payload_key, swf_key FROM group_messages WHERE id = ? AND group_id = ?',
    )
      .bind(msgId, groupId)
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

    await c.env.DB.prepare('DELETE FROM group_messages WHERE id = ?').bind(msgId).run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group delete message error:', error);
    return c.json({ error: 'Failed to delete message', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/groups/:id/read - mark group as read
groups.post('/groups/:id/read', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');

    const member = await c.env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, userId)
      .first();

    if (!member) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const lastMsg = (await c.env.DB.prepare(
      'SELECT id FROM group_messages WHERE group_id = ? ORDER BY created_at DESC LIMIT 1',
    )
      .bind(groupId)
      .first()) as { id: string } | null;

    await c.env.DB.prepare(
      'INSERT OR REPLACE INTO group_read_states (user_id, group_id, last_read_message_id, unread_count) VALUES (?, ?, ?, 0)',
    )
      .bind(userId, groupId, lastMsg?.id || null)
      .run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group mark read error:', error);
    return c.json({ error: 'Failed to mark as read', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/groups/:id/keys - submit wrapped group keys (rotation on membership changes)
groups.post('/groups/:id/keys', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');
    const { keyVersion, boxes } = (await c.req.json()) as {
      keyVersion?: number;
      boxes?: Array<{ userId: string; wrappedKey: string; wrappedIv: string }>;
    };

    if (typeof keyVersion !== 'number' || !boxes || boxes.length === 0) {
      return c.json({ error: 'keyVersion and boxes are required' }, 400);
    }

    const myMember = (await c.env.DB.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, userId)
      .first()) as { role: string } | null;

    if (!myMember) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const canManage = myMember.role === 'owner' || myMember.role === 'admin';
    if (!canManage && boxes.some((b) => b.userId !== userId)) {
      return c.json({ error: 'Not authorized to submit keys for other members' }, 403);
    }

    const memberIds = await c.env.DB.prepare('SELECT user_id FROM group_members WHERE group_id = ?')
      .bind(groupId)
      .all();
    const currentIds = new Set((memberIds.results || []).map((r) => (r as { user_id: string }).user_id));

    for (const b of boxes) {
      if (!currentIds.has(b.userId)) {
        return c.json({ error: 'Key recipient is not a current member' }, 400);
      }
    }

    await c.env.DB.batch(
      boxes.map((b) =>
        c.env.DB.prepare(`
          INSERT INTO group_channel_keys (group_id, key_version, user_id, wrapped_key, wrapped_iv, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(group_id, key_version, user_id) DO UPDATE SET
            wrapped_key = excluded.wrapped_key,
            wrapped_iv = excluded.wrapped_iv
        `).bind(groupId, keyVersion, b.userId, b.wrappedKey, b.wrappedIv, new Date().toISOString()),
      ),
    );

    await c.env.DB.prepare('UPDATE group_conversations SET key_version = ? WHERE id = ?')
      .bind(keyVersion, groupId)
      .run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group keys error:', error);
    return c.json({ error: 'Failed to store keys', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/groups/:id/keys - fetch my wrapped keys for a group
groups.get('/groups/:id/keys', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const groupId = c.req.param('id');

    const group = (await c.env.DB.prepare('SELECT key_version FROM group_conversations WHERE id = ?')
      .bind(groupId)
      .first()) as { key_version: number } | null;

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const member = await c.env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, userId)
      .first();

    if (!member) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const keys = await c.env.DB.prepare(
      'SELECT key_version, wrapped_key, wrapped_iv FROM group_channel_keys WHERE group_id = ? AND user_id = ?',
    )
      .bind(groupId, userId)
      .all();

    return c.json({
      key_version: group.key_version,
      keys: (keys.results || []).map((row: Record<string, unknown>) => ({
        key_version: row.key_version,
        wrapped_key: row.wrapped_key,
        wrapped_iv: row.wrapped_iv,
      })),
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Group keys get error:', error);
    return c.json({ error: 'Failed to fetch keys', details: err.message || 'Unknown error' }, 500);
  }
});

export default groups;
