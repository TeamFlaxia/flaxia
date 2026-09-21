import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { getUserPlan } from '../../lib/billing';
import { detectMimeType, isAllowedImageMime, requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const stamps = new Hono<{ Bindings: Bindings; Variables: Variables }>();

async function ensureCustomStampsTable(db: D1Database): Promise<void> {
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS custom_stamps (
           id         TEXT PRIMARY KEY,
           user_id    TEXT NOT NULL REFERENCES users(id),
           name       TEXT NOT NULL,
           image_key  TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         )`,
      )
      .run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_custom_stamps_user ON custom_stamps(user_id)').run();
    await db
      .prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_stamps_user_name ON custom_stamps(user_id, name)')
      .run();
  } catch (e) {
    console.error('Failed to ensure custom_stamps table:', e);
  }
}

// GET /api/stamps - list current user's custom stamps (protected)
stamps.get('/stamps', requireAuth, async (c) => {
  try {
    await ensureCustomStampsTable(c.env.DB);
    const userId = c.get('user')?.id || '';
    const rows = await c.env.DB.prepare(
      'SELECT id, name, image_key, created_at FROM custom_stamps WHERE user_id = ? ORDER BY created_at DESC',
    )
      .bind(userId)
      .all<{ id: string; name: string; image_key: string; created_at: string }>();

    const stampsList = (rows.results || []).map((r) => ({
      id: r.id,
      name: r.name,
      url: `/api/images/${r.image_key}`,
      created_at: r.created_at,
    }));

    return c.json({ stamps: stampsList });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('List stamps error:', error);
    return c.json({ error: 'Failed to list stamps', details: err.message }, 500);
  }
});

// POST /api/stamps - upload a new custom stamp (protected, multipart/form-data)
stamps.post('/stamps', requireAuth, async (c) => {
  try {
    await ensureCustomStampsTable(c.env.DB);
    const userId = c.get('user')?.id || '';

    // Check plan for stamp limit
    const plan = await getUserPlan(c.env, userId);
    const isPlus = plan.isActive;

    if (!isPlus) {
      const countRow = await c.env.DB.prepare('SELECT COUNT(*) AS cnt FROM custom_stamps WHERE user_id = ?')
        .bind(userId)
        .first<{ cnt: number }>();
      if ((countRow?.cnt ?? 0) >= 5) {
        return c.json({ error: 'Free plan limited to 5 custom stamps' }, 403);
      }
    }

    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    const rawName = ((formData.get('name') as string) || '').trim();

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No file provided' }, 400);
    }
    if (!rawName || rawName.length === 0) {
      return c.json({ error: 'Name is required' }, 400);
    }
    // Strip surrounding colons if user provided them
    const bareName = rawName.replace(/^:+|:+$/g, '');
    if (bareName.length === 0 || bareName.length > 30) {
      return c.json({ error: 'Name too long (max 30 chars)' }, 400);
    }
    if (!/^[a-zA-Z0-9_]+$/.test(bareName)) {
      return c.json({ error: 'Name must contain only letters, numbers, and underscores' }, 400);
    }
    // Store as :name: — ownership checked at render time
    const name = `:${bareName}:`;

    // Check unique name per user
    const existing = await c.env.DB.prepare('SELECT 1 FROM custom_stamps WHERE user_id = ? AND name = ?')
      .bind(userId, name)
      .first();
    if (existing) {
      return c.json({ error: 'A stamp with this name already exists' }, 409);
    }

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      return c.json({ error: 'File too large (max 5MB)' }, 400);
    }

    const fileData = await file.arrayBuffer();
    const detectedMime = detectMimeType(fileData);
    if (!isAllowedImageMime(detectedMime)) {
      return c.json({ error: 'Invalid image format. Allowed: PNG, JPEG, GIF, WebP' }, 400);
    }

    const ext =
      detectedMime === 'image/jpeg'
        ? 'jpg'
        : detectedMime === 'image/png'
          ? 'png'
          : detectedMime === 'image/gif'
            ? 'gif'
            : 'webp';
    const hashBuffer = await crypto.subtle.digest('SHA-256', fileData);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    const r2Key = `stamp/${userId}/${hashHex}.${ext}`;

    await c.env.BUCKET.put(r2Key, fileData, {
      httpMetadata: { contentType: detectedMime },
    });

    const stampId = nanoid();
    await c.env.DB.prepare('INSERT INTO custom_stamps (id, user_id, name, image_key) VALUES (?, ?, ?, ?)')
      .bind(stampId, userId, name, r2Key)
      .run();

    return c.json(
      {
        id: stampId,
        name,
        url: `/api/images/${r2Key}`,
      },
      201,
    );
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Upload stamp error:', error);
    return c.json({ error: 'Failed to upload stamp', details: err.message }, 500);
  }
});

// DELETE /api/stamps/:id - delete a custom stamp (protected)
stamps.delete('/stamps/:id', requireAuth, async (c) => {
  try {
    await ensureCustomStampsTable(c.env.DB);
    const userId = c.get('user')?.id || '';
    const stampId = c.req.param('id');

    const stamp = await c.env.DB.prepare('SELECT id, image_key FROM custom_stamps WHERE id = ? AND user_id = ?')
      .bind(stampId, userId)
      .first<{ id: string; image_key: string }>();

    if (!stamp) {
      return c.json({ error: 'Stamp not found' }, 404);
    }

    await c.env.BUCKET.delete(stamp.image_key);
    await c.env.DB.prepare('DELETE FROM custom_stamps WHERE id = ?').bind(stampId).run();

    return c.json({ deleted: true });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Delete stamp error:', error);
    return c.json({ error: 'Failed to delete stamp', details: err.message }, 500);
  }
});

// GET /api/stamps/all - list all custom stamps (for stamp picker, public)
stamps.get('/stamps/all', async (c) => {
  try {
    await ensureCustomStampsTable(c.env.DB);
    const rows = await c.env.DB.prepare(
      'SELECT cs.id, cs.name, cs.image_key, cs.user_id, u.username FROM custom_stamps cs JOIN users u ON cs.user_id = u.id ORDER BY cs.created_at DESC',
    ).all<{ id: string; name: string; image_key: string; user_id: string; username: string }>();

    const stampsList = (rows.results || []).map((r) => ({
      id: r.id,
      name: r.name,
      url: `/api/images/${r.image_key}`,
      user_id: r.user_id,
      username: r.username,
    }));

    return c.json({ stamps: stampsList });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('List all stamps error:', error);
    return c.json({ error: 'Failed to list stamps', details: err.message }, 500);
  }
});

export default stamps;
