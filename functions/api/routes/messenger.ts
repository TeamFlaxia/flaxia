import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { validateImageDimensions } from '../../lib/image-dimensions';
import { sendPushToAll } from '../../lib/notify';
import { detectMimeType, isAllowedImageMime, requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const messenger = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ─── Direct Messages ──────────────────────────────────────────────────────────

// GET /api/dm/conversations - list conversations for current user
messenger.get('/dm/conversations', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';

    const convs = await c.env.DB.prepare(`
      SELECT
        c.id,
        c.user_a_id,
        c.user_b_id,
        c.last_message_id,
        c.last_message_content,
        c.last_message_sender_id,
        c.last_message_created_at,
        (SELECT enc_version FROM dm_messages WHERE id = c.last_message_id) as last_message_enc_version,
        c.user_a_read_at,
        c.user_b_read_at,
        c.key_version,
        c.updated_at,
        u.id as other_user_id,
        u.username as other_username,
        u.display_name as other_display_name,
        u.avatar_key as other_avatar_key,
        CASE
          WHEN c.last_message_sender_id != ? THEN 1
          WHEN c.last_message_created_at IS NULL THEN 0
          WHEN c.user_a_id = ? AND (c.user_b_read_at IS NULL OR c.last_message_created_at > c.user_b_read_at) THEN 1
          WHEN c.user_b_id = ? AND (c.user_a_read_at IS NULL OR c.last_message_created_at > c.user_a_read_at) THEN 1
          ELSE 0
        END as unread
      FROM dm_conversations c
      JOIN users u ON u.id = CASE WHEN c.user_a_id = ? THEN c.user_b_id ELSE c.user_a_id END
      WHERE c.user_a_id = ? OR c.user_b_id = ?
      ORDER BY c.updated_at DESC
    `)
      .bind(userId, userId, userId, userId, userId, userId)
      .all();

    const conversations = (convs.results || []).map((row: Record<string, unknown>) => ({
      id: row.id,
      other_user: {
        id: row.other_user_id,
        username: row.other_username,
        display_name: row.other_display_name,
        avatar_key: row.other_avatar_key,
      },
      last_message: row.last_message_id
        ? {
            id: row.last_message_id,
            content: row.last_message_content,
            sender_id: row.last_message_sender_id,
            created_at: row.last_message_created_at,
            enc_version: (row.last_message_enc_version as number | null) ?? null,
            is_mine: row.last_message_sender_id === userId,
          }
        : null,
      unread: row.unread === 1,
      key_version: row.key_version || 1,
      updated_at: row.updated_at,
    }));

    return c.json({ conversations });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('DM conversations error:', error);
    return c.json({ error: 'Failed to fetch conversations', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/dm/conversations - create or get existing conversation with a user
messenger.post('/dm/conversations', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const { userId: otherUserId } = (await c.req.json()) as { userId: string };

    if (!otherUserId) {
      return c.json({ error: 'userId is required' }, 400);
    }
    if (otherUserId === userId) {
      return c.json({ error: 'Cannot create conversation with yourself' }, 400);
    }

    // Enforce ordering: smaller id first
    const [userAId, userBId] = userId < otherUserId ? [userId, otherUserId] : [otherUserId, userId];

    // Check if conversation already exists
    const existing = await c.env.DB.prepare('SELECT id FROM dm_conversations WHERE user_a_id = ? AND user_b_id = ?')
      .bind(userAId, userBId)
      .first();

    if (existing) {
      // Return the other user info
      const otherUser = await c.env.DB.prepare('SELECT id, username, display_name, avatar_key FROM users WHERE id = ?')
        .bind(otherUserId)
        .first();
      return c.json({
        id: existing.id,
        other_user: otherUser,
      });
    }

    // Create new conversation
    const id = nanoid();
    const now = new Date().toISOString();

    await c.env.DB.prepare(
      'INSERT INTO dm_conversations (id, user_a_id, user_b_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(id, userAId, userBId, now, now)
      .run();

    const otherUser = await c.env.DB.prepare('SELECT id, username, display_name, avatar_key FROM users WHERE id = ?')
      .bind(otherUserId)
      .first();

    return c.json({
      id,
      other_user: otherUser,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('DM create conversation error:', error);
    return c.json({ error: 'Failed to create conversation', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/dm/conversations/:id - get conversation details
messenger.get('/dm/conversations/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const convId = c.req.param('id');

    const conv = await c.env.DB.prepare(`
      SELECT
        c.id, c.user_a_id, c.user_b_id, c.key_version,
        u.id as other_user_id, u.username as other_username,
        u.display_name as other_display_name, u.avatar_key as other_avatar_key
      FROM dm_conversations c
      JOIN users u ON u.id = CASE WHEN c.user_a_id = ? THEN c.user_b_id ELSE c.user_a_id END
      WHERE c.id = ? AND (c.user_a_id = ? OR c.user_b_id = ?)
    `)
      .bind(userId, convId, userId, userId)
      .first();

    if (!conv) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    return c.json({
      id: conv.id,
      key_version: conv.key_version || 1,
      other_user: {
        id: conv.other_user_id,
        username: conv.other_username,
        display_name: conv.other_display_name,
        avatar_key: conv.other_avatar_key,
      },
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('DM get conversation error:', error);
    return c.json({ error: 'Failed to fetch conversation', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/dm/conversations/:id/messages - get messages (cursor-based)
messenger.get('/dm/conversations/:id/messages', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const convId = c.req.param('id');
    const cursor = c.req.query('cursor');
    const after = c.req.query('after');
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);

    // Verify user is participant
    const conv = await c.env.DB.prepare(
      'SELECT id FROM dm_conversations WHERE id = ? AND (user_a_id = ? OR user_b_id = ?)',
    )
      .bind(convId, userId, userId)
      .first();

    if (!conv) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    let messages: { results?: Array<Record<string, unknown>> };
    if (after) {
      // Realtime poll: everything at-or-newer than the client's newest message,
      // oldest-first. `>=` plus client-side id de-duplication avoids missing a
      // message that shares the boundary millisecond.
      messages = await c.env.DB.prepare(`
        SELECT m.id, m.conversation_id, m.sender_id, m.content, m.created_at,
               m.gif_key, m.payload_key, m.swf_key, m.edited_at,
               m.content_iv, m.enc_version, m.key_version,
               m.ratchet_pub, m.ratchet_pn, m.ratchet_n,
               m.stamp_id,
               p.enc as plaintext_enc, p.iv as plaintext_iv,
               u.username as sender_username, u.display_name as sender_display_name
        FROM dm_messages m
        JOIN users u ON m.sender_id = u.id
        LEFT JOIN dm_message_plaintext p ON p.message_id = m.id AND p.user_id = ?
        WHERE m.conversation_id = ? AND m.created_at >= ?
        ORDER BY m.created_at ASC
        LIMIT ?
      `)
        .bind(userId, convId, after, limit)
        .all();
    } else if (cursor) {
      messages = await c.env.DB.prepare(`
        SELECT m.id, m.conversation_id, m.sender_id, m.content, m.created_at,
               m.gif_key, m.payload_key, m.swf_key, m.edited_at,
               m.content_iv, m.enc_version, m.key_version,
               m.ratchet_pub, m.ratchet_pn, m.ratchet_n,
               m.stamp_id,
               p.enc as plaintext_enc, p.iv as plaintext_iv,
               u.username as sender_username, u.display_name as sender_display_name
        FROM dm_messages m
        JOIN users u ON m.sender_id = u.id
        LEFT JOIN dm_message_plaintext p ON p.message_id = m.id AND p.user_id = ?
        WHERE m.conversation_id = ? AND m.created_at < ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `)
        .bind(userId, convId, cursor, limit)
        .all();
    } else {
      messages = await c.env.DB.prepare(`
        SELECT m.id, m.conversation_id, m.sender_id, m.content, m.created_at,
               m.gif_key, m.payload_key, m.swf_key, m.edited_at,
               m.content_iv, m.enc_version, m.key_version,
               m.ratchet_pub, m.ratchet_pn, m.ratchet_n,
               m.stamp_id,
               p.enc as plaintext_enc, p.iv as plaintext_iv,
               u.username as sender_username, u.display_name as sender_display_name
        FROM dm_messages m
        JOIN users u ON m.sender_id = u.id
        LEFT JOIN dm_message_plaintext p ON p.message_id = m.id AND p.user_id = ?
        WHERE m.conversation_id = ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `)
        .bind(userId, convId, limit)
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
          conversation_id: row.conversation_id,
          sender_id: row.sender_id,
          content: row.content,
          gif_key: row.gif_key || null,
          payload_key: row.payload_key || null,
          swf_key: row.swf_key || null,
          content_iv: row.content_iv || null,
          enc_version: row.enc_version || null,
          key_version: row.key_version || null,
          ratchet_pub: row.ratchet_pub || null,
          ratchet_pn: row.ratchet_pn ?? null,
          ratchet_n: row.ratchet_n ?? null,
          plaintext_enc: row.plaintext_enc || null,
          plaintext_iv: row.plaintext_iv || null,
          stamp_id: row.stamp_id || null,
          stamp_url: stamp ? `/api/images/${stamp.image_key}` : null,
          stamp_name: stamp ? stamp.name : null,
          created_at: row.created_at,
          edited_at: row.edited_at || null,
          is_mine: row.sender_id === userId,
          sender: {
            username: row.sender_username,
            display_name: row.sender_display_name,
          },
        };
      }),
      next_cursor: nextCursor,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('DM get messages error:', error);
    return c.json({ error: 'Failed to fetch messages', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/dm/conversations/:id/messages - send a message
messenger.post('/dm/conversations/:id/messages', requireAuth, async (c) => {
  try {
    const sender = c.get('user')!;
    const senderId = sender.id;
    const convId = c.req.param('id');
    const {
      content,
      gifKey,
      payloadKey,
      swfKey,
      messageId,
      contentIv,
      encVersion,
      keyVersion,
      ratchetPub,
      ratchetPn,
      ratchetN,
      plaintextEnc,
      plaintextIv,
      stampId,
    } = (await c.req.json()) as {
      content?: string;
      gifKey?: string;
      payloadKey?: string;
      swfKey?: string;
      messageId?: string;
      contentIv?: string;
      encVersion?: number;
      keyVersion?: number;
      ratchetPub?: string;
      ratchetPn?: number;
      ratchetN?: number;
      plaintextEnc?: string;
      plaintextIv?: string;
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

    // Verify user is participant
    const conv = (await c.env.DB.prepare(
      'SELECT id, user_a_id, user_b_id FROM dm_conversations WHERE id = ? AND (user_a_id = ? OR user_b_id = ?)',
    )
      .bind(convId, senderId, senderId)
      .first()) as { id: string; user_a_id: string; user_b_id: string } | null;

    if (!conv) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    // Use prepare-provided messageId if given (so storage key matches message ID)
    const msgId = messageId || nanoid();
    const now = new Date().toISOString();

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

    // Insert message with optional attachment keys
    await c.env.DB.prepare(
      'INSERT INTO dm_messages (id, conversation_id, sender_id, content, created_at, gif_key, payload_key, swf_key, content_iv, enc_version, key_version, ratchet_pub, ratchet_pn, ratchet_n, stamp_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        msgId,
        convId,
        senderId,
        trimmed,
        now,
        gifKey || null,
        payloadKey || null,
        swfKey || null,
        contentIv || null,
        isEncrypted ? encVersion : null,
        keyVersion || 1,
        ratchetPub || null,
        typeof ratchetPn === 'number' ? ratchetPn : null,
        typeof ratchetN === 'number' ? ratchetN : null,
        stampId || null,
      )
      .run();

    // Persist the sender's own KEK-wrapped plaintext so they can read this
    // message on another device (where no ratchet session exists). Server never
    // sees the raw plaintext; plaintext_enc/iv are AES-GCM wrapped with the
    // user's password-derived KEK.
    if (isEncrypted && plaintextEnc && plaintextIv) {
      const ptNow = new Date().toISOString();
      await c.env.DB.prepare(
        `INSERT INTO dm_message_plaintext (message_id, user_id, enc, iv, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(message_id, user_id) DO UPDATE SET enc = excluded.enc, iv = excluded.iv, updated_at = excluded.updated_at`,
      )
        .bind(msgId, senderId, plaintextEnc, plaintextIv, ptNow)
        .run();
    }

    // Update conversation last_message and updated_at (never surface E2EE plaintext)
    const displayContent = isEncrypted
      ? '[Encrypted message]'
      : trimmed ||
        (gifKey?.includes('/video/')
          ? '[Video]'
          : gifKey
            ? '[Image]'
            : payloadKey
              ? '[File]'
              : swfKey
                ? '[Flash]'
                : '');
    await c.env.DB.prepare(`
      UPDATE dm_conversations
      SET last_message_id = ?, last_message_content = ?, last_message_sender_id = ?,
          last_message_created_at = ?, updated_at = ?
      WHERE id = ?
    `)
      .bind(msgId, displayContent, senderId, now, now, convId)
      .run();

    // Send push notification to the other participant (E2EE: never include content)
    const otherUserId = conv.user_a_id === senderId ? conv.user_b_id : conv.user_a_id;
    const senderDisplayName = sender?.display_name || sender?.username || 'Someone';

    await sendPushToAll(
      c.env as {
        DB: D1Database;
        VAPID_PUBLIC_KEY?: string;
        VAPID_PRIVATE_KEY?: string;
        FCM_SERVER_KEY?: string;
        NOTIFICATION_STREAM?: DurableObjectNamespace;
      },
      otherUserId,
      'dm',
      sender?.username,
      senderDisplayName,
      isEncrypted ? '[New message]' : displayContent,
      convId,
    );

    return c.json({
      id: msgId,
      conversation_id: convId,
      sender_id: senderId,
      content: trimmed,
      gif_key: gifKey || null,
      payload_key: payloadKey || null,
      swf_key: swfKey || null,
      content_iv: contentIv || null,
      enc_version: isEncrypted ? encVersion : null,
      key_version: isEncrypted ? keyVersion || 1 : null,
      ratchet_pub: ratchetPub || null,
      ratchet_pn: typeof ratchetPn === 'number' ? ratchetPn : null,
      ratchet_n: typeof ratchetN === 'number' ? ratchetN : null,
      stamp_id: stampId || null,
      stamp_url: stampUrl,
      stamp_name: stampName,
      created_at: now,
      edited_at: null,
      is_mine: true,
      sender: {
        id: sender.id,
        username: sender.username,
        display_name: sender.display_name,
        avatar_key: sender.avatar_key || null,
      },
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('DM send message error:', error);
    return c.json({ error: 'Failed to send message', details: err.message || 'Unknown error' }, 500);
  }
});

// PUT /api/dm/conversations/:id/messages/:msgId/plaintext - store the current
// user's own KEK-wrapped plaintext for a DM message. Called after a participant
// decrypts a message (e.g. on a device with no ratchet session) so they can read
// it again on any device. The server only ever stores the KEK-wrapped blob.
messenger.put('/dm/conversations/:id/messages/:msgId/plaintext', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const convId = c.req.param('id');
    const msgId = c.req.param('msgId');
    const { plaintextEnc, plaintextIv } = (await c.req.json()) as {
      plaintextEnc?: string;
      plaintextIv?: string;
    };
    if (!userId || !plaintextEnc || !plaintextIv) {
      return c.json({ error: 'Missing plaintext fields' }, 400);
    }

    // Verify user is a participant of the conversation the message belongs to.
    const msg = (await c.env.DB.prepare(
      `SELECT m.id FROM dm_messages m
       JOIN dm_conversations dc ON dc.id = m.conversation_id
       WHERE m.id = ? AND m.conversation_id = ? AND (dc.user_a_id = ? OR dc.user_b_id = ?)`,
    )
      .bind(msgId, convId, userId, userId)
      .first()) as { id: string } | null;
    if (!msg) return c.json({ error: 'Message not found' }, 404);

    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `INSERT INTO dm_message_plaintext (message_id, user_id, enc, iv, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_id, user_id) DO UPDATE SET enc = excluded.enc, iv = excluded.iv, updated_at = excluded.updated_at`,
    )
      .bind(msgId, userId, plaintextEnc, plaintextIv, now)
      .run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('DM plaintext put error:', error);
    return c.json({ error: 'Failed to save plaintext', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/dm/conversations/:id/read - mark conversation as read
messenger.post('/dm/conversations/:id/read', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const convId = c.req.param('id');

    const conv = (await c.env.DB.prepare(
      'SELECT id, user_a_id, user_b_id FROM dm_conversations WHERE id = ? AND (user_a_id = ? OR user_b_id = ?)',
    )
      .bind(convId, userId, userId)
      .first()) as { id: string; user_a_id: string; user_b_id: string } | null;

    if (!conv) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    const now = new Date().toISOString();
    if (conv.user_a_id === userId) {
      await c.env.DB.prepare('UPDATE dm_conversations SET user_a_read_at = ? WHERE id = ?').bind(now, convId).run();
    } else {
      await c.env.DB.prepare('UPDATE dm_conversations SET user_b_read_at = ? WHERE id = ?').bind(now, convId).run();
    }

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('DM mark read error:', error);
    return c.json({ error: 'Failed to mark as read', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/dm/conversations/:id/messages/prepare - prepare DM message with file attachment
messenger.post('/dm/conversations/:id/messages/prepare', requireAuth, async (c) => {
  try {
    const senderId = c.get('user')?.id || '';
    const convId = c.req.param('id');
    const { filename } = (await c.req.json()) as { filename?: string };

    if (!filename) {
      return c.json({ error: 'Missing filename' }, 400);
    }

    // Verify user is participant
    const conv = (await c.env.DB.prepare(
      'SELECT id FROM dm_conversations WHERE id = ? AND (user_a_id = ? OR user_b_id = ?)',
    )
      .bind(convId, senderId, senderId)
      .first()) as { id: string } | null;

    if (!conv) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    const name = filename.toLowerCase();
    const ext = name.match(/\.(\w+)$/)?.[1];
    const msgId = nanoid();

    let storageKey: string;
    let responseType: 'gif' | 'zip' | 'swf';

    if (name.endsWith('.swf') || ext === 'swf') {
      storageKey = `dm/swf/${msgId}.swf`;
      responseType = 'swf';
    } else if (name.endsWith('.zip')) {
      storageKey = `dm/zip/${msgId}.zip`;
      responseType = 'zip';
    } else if (name.endsWith('.html') || name.endsWith('.htm')) {
      storageKey = `dm/html/${msgId}.html`;
      responseType = 'zip';
    } else if (ext && ['mp3', 'wav', 'ogg', 'm4a', 'webm'].includes(ext)) {
      const extMap: Record<string, string> = { mp3: '.mp3', wav: '.wav', ogg: '.ogg', m4a: '.m4a', webm: '.webm' };
      storageKey = `dm/audio/${msgId}${extMap[ext]}`;
      responseType = 'gif';
    } else if (ext && ['mp4', 'webm', 'mov'].includes(ext)) {
      const extMap: Record<string, string> = { mp4: '.mp4', webm: '.webm', mov: '.mov' };
      storageKey = `dm/video/${msgId}${extMap[ext]}`;
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
      storageKey = `dm/gif/${msgId}${extMap[ext]}`;
      responseType = 'gif';
    } else {
      return c.json({ error: 'Unsupported file type' }, 400);
    }

    const origin = new URL(c.req.url).origin;
    const uploadUrl = `${origin}/api/dm/upload/${storageKey}`;
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
    console.error('DM prepare error:', error);
    return c.json({ error: 'Failed to prepare message', details: err.message || 'Unknown error' }, 500);
  }
});

// PUT /api/dm/upload/:key — direct file upload for DM messages
messenger.put('/dm/upload/*', requireAuth, async (c) => {
  try {
    const key = c.req.path.replace('/api/dm/upload/', '');
    const contentLength = c.req.header('content-length');

    if (!key) {
      return c.json({ error: 'Missing file key' }, 400);
    }

    // Check file size limit (25MB)
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

    // Validate magic bytes
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
    console.error('DM upload error:', error);
    return c.json({ error: 'Upload failed' }, 500);
  }
});

// PUT /api/dm/conversations/:id/messages/:msgId - edit a DM message
messenger.put('/dm/conversations/:id/messages/:msgId', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const convId = c.req.param('id');
    const msgId = c.req.param('msgId');
    const { content, contentIv, encVersion, keyVersion, ratchetPub, ratchetPn, ratchetN, plaintextEnc, plaintextIv } =
      (await c.req.json()) as {
        content?: string;
        contentIv?: string;
        encVersion?: number;
        keyVersion?: number;
        ratchetPub?: string;
        ratchetPn?: number;
        ratchetN?: number;
        plaintextEnc?: string;
        plaintextIv?: string;
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

    // Verify user owns this message
    const msg = (await c.env.DB.prepare(
      'SELECT id, content, content_iv, enc_version, key_version FROM dm_messages WHERE id = ? AND conversation_id = ? AND sender_id = ?',
    )
      .bind(msgId, convId, userId)
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
      'UPDATE dm_messages SET content = ?, edited_at = ?, content_iv = ?, enc_version = ?, key_version = ?, ratchet_pub = ?, ratchet_pn = ?, ratchet_n = ? WHERE id = ?',
    )
      .bind(
        trimmed,
        now,
        contentIv || msg.content_iv || null,
        isEncrypted ? encVersion : msg.enc_version || null,
        keyVersion || msg.key_version || 1,
        typeof ratchetPub === 'string' ? ratchetPub : null,
        typeof ratchetPn === 'number' ? ratchetPn : null,
        typeof ratchetN === 'number' ? ratchetN : null,
        msgId,
      )
      .run();

    // Refresh the sender's KEK-wrapped plaintext backup if a new one was supplied.
    if (isEncrypted && plaintextEnc && plaintextIv) {
      const ptNow = new Date().toISOString();
      await c.env.DB.prepare(
        `INSERT INTO dm_message_plaintext (message_id, user_id, enc, iv, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(message_id, user_id) DO UPDATE SET enc = excluded.enc, iv = excluded.iv, updated_at = excluded.updated_at`,
      )
        .bind(msgId, userId, plaintextEnc, plaintextIv, ptNow)
        .run();
    }

    // Update conversation last_message if this was the last message (never leak plaintext)
    const displayContent = isEncrypted ? '[Encrypted message]' : trimmed;
    await c.env.DB.prepare(`
      UPDATE dm_conversations
      SET last_message_content = ?, updated_at = ?
      WHERE id = ? AND last_message_id = ?
    `)
      .bind(displayContent, now, convId, msgId)
      .run();

    return c.json({
      id: msgId,
      content: trimmed,
      content_iv: contentIv || null,
      enc_version: isEncrypted ? encVersion : null,
      key_version: keyVersion || null,
      ratchet_pub: typeof ratchetPub === 'string' ? ratchetPub : null,
      ratchet_pn: typeof ratchetPn === 'number' ? ratchetPn : null,
      ratchet_n: typeof ratchetN === 'number' ? ratchetN : null,
      edited_at: now,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('DM edit message error:', error);
    return c.json({ error: 'Failed to edit message', details: err.message || 'Unknown error' }, 500);
  }
});

// DELETE /api/dm/conversations/:id/messages/:msgId - delete a DM message
messenger.delete('/dm/conversations/:id/messages/:msgId', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const convId = c.req.param('id');
    const msgId = c.req.param('msgId');

    // Verify user owns this message
    const msg = (await c.env.DB.prepare(
      'SELECT id, conversation_id, sender_id, gif_key, payload_key, swf_key FROM dm_messages WHERE id = ? AND conversation_id = ?',
    )
      .bind(msgId, convId)
      .first()) as {
      id: string;
      conversation_id: string;
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

    // Delete associated files from R2
    if (c.env.BUCKET) {
      if (msg.gif_key) {
        try {
          await c.env.BUCKET.delete(msg.gif_key);
        } catch (e) {
          console.error('Failed to delete gif file:', e);
        }
      }
      if (msg.payload_key) {
        try {
          await c.env.BUCKET.delete(msg.payload_key);
        } catch (e) {
          console.error('Failed to delete payload file:', e);
        }
      }
      if (msg.swf_key) {
        try {
          await c.env.BUCKET.delete(msg.swf_key);
        } catch (e) {
          console.error('Failed to delete SWF file:', e);
        }
      }
    }

    // Delete the message
    await c.env.DB.prepare('DELETE FROM dm_messages WHERE id = ?').bind(msgId).run();

    // Remove the per-participant KEK-wrapped plaintext backups for this message.
    await c.env.DB.prepare('DELETE FROM dm_message_plaintext WHERE message_id = ?').bind(msgId).run();

    // If deleted message was the conversation's last message, update it
    await c.env.DB.prepare(`
      UPDATE dm_conversations
      SET last_message_id = NULL, last_message_content = NULL, last_message_sender_id = NULL,
          last_message_created_at = NULL, updated_at = ?
      WHERE id = ? AND last_message_id = ?
    `)
      .bind(new Date().toISOString(), convId, msgId)
      .run();

    return c.json({ success: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('DM delete message error:', error);
    return c.json({ error: 'Failed to delete message', details: err.message || 'Unknown error' }, 500);
  }
});

// GET /api/dm/unread-count - get total unread DM count
messenger.get('/dm/unread-count', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';

    const result = (await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM dm_conversations
      WHERE (user_a_id = ? OR user_b_id = ?)
        AND last_message_created_at IS NOT NULL
        AND last_message_sender_id != ?
        AND (
          (user_a_id = ? AND (user_b_read_at IS NULL OR last_message_created_at > user_b_read_at))
          OR (user_b_id = ? AND (user_a_read_at IS NULL OR last_message_created_at > user_a_read_at))
        )
    `)
      .bind(userId, userId, userId, userId, userId)
      .first()) as { count: number };

    return c.json({ unread_count: result?.count || 0 });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('DM unread count error:', error);
    return c.json({ error: 'Failed to get unread count', details: err.message || 'Unknown error' }, 500);
  }
});

export default messenger;
