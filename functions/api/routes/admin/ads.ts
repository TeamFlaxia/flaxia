import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { isAdmin } from '../../../lib/admin.ts';
import { validateImageDimensions } from '../../../lib/image-dimensions';
import { submitFileScans } from '../../../lib/scan/clamav';
import { runInBackground, scanUploadSync } from '../../../lib/scan/index';
import { requireAdmin, requireAuth } from '../../helpers';
import type { Bindings, Variables } from '../../types';

export const ads = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ─── Admin Ads ────────────────────────────────────────────────────────────────

// GET /api/admin/ads/config - get ad configuration (admin endpoint)
ads.get('/ads/config', async (c) => {
  try {
    const user = c.get('user');
    if (!user || !isAdmin(c.env, user)) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare("SELECT value FROM ad_config WHERE key = 'every_n'").first();

    if (!result) {
      return c.json({ error: 'Ad config not found' }, 404);
    }

    return c.json({ every_n: Number(result.value) });
  } catch (error: unknown) {
    console.error('Get ad config error:', error);
    return c.json({ error: 'Failed to get ad config' }, 500);
  }
});

// PATCH /api/admin/ads/config - update ad configuration (admin endpoint)
ads.patch('/ads/config', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user || !isAdmin(c.env, user)) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { every_n } = await c.req.json();

    // Validate: must be an integer >= 1
    if (!Number.isInteger(every_n) || every_n < 1) {
      return c.json({ error: 'every_n must be an integer >= 1' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare("UPDATE ad_config SET value = ? WHERE key = 'every_n'")
      .bind(String(every_n))
      .run();

    if (!result.success) {
      console.error('Database update failed:', result);
      return c.json({ error: 'Failed to update ad config' }, 500);
    }

    return c.json({ every_n });
  } catch (error: unknown) {
    console.error('Update ad config error:', error);
    return c.json({ error: 'Failed to update ad config' }, 500);
  }
});

// GET /api/admin/ads - get all ads with analytics (admin endpoint)
ads.get('/ads', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user || !isAdmin(c.env, user)) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare(`
      SELECT
        ads.id,
        ads.title,
        ads.body_text,
        ads.click_url,
        ads.payload_key,
        ads.payload_type,
        ads.thumbnail_key,
        ads.impressions,
        ads.clicks,
        ads.active,
        ads.created_at,
        ROUND(CAST(clicks AS FLOAT) / NULLIF(impressions, 0) * 100, 2) AS ctr,
        (SELECT COUNT(*) FROM ad_interactions WHERE ad_id = ads.id) AS interaction_count
      FROM ads
      ORDER BY created_at DESC
    `).all();

    if (!result.success) {
      console.error('Database query failed:', result);
      return c.json({ error: 'Failed to fetch ads' }, 500);
    }

    return c.json({ ads: result.results || [] });
  } catch (error: unknown) {
    console.error('Get admin ads error:', error);
    return c.json({ error: 'Failed to fetch ads' }, 500);
  }
});

// POST /api/admin/ads - create new ad (admin endpoint)
ads.post('/ads', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user || !isAdmin(c.env, user)) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    // Generate ad ID early so it can be used for both payload and thumbnail
    const adId = nanoid();

    const contentType = c.req.header('content-type');
    let title: string,
      body_text: string,
      click_url: string,
      ad_type: string,
      payloadFile: File | undefined,
      thumbnailFile: File | undefined;

    if (contentType?.includes('multipart/form-data')) {
      const formData = await c.req.formData();
      title = formData.get('title') as string;
      body_text = formData.get('body_text') as string;
      click_url = formData.get('click_url') as string;
      ad_type = formData.get('ad_type') as string;
      payloadFile = (formData.get('payload') as File | null) || undefined;
      thumbnailFile = (formData.get('thumbnail') as File | null) || undefined;
    } else {
      const body = await c.req.json();
      title = body.title;
      body_text = body.body_text;
      click_url = body.click_url;
      ad_type = body.ad_type;
    }

    // Validate required fields
    if (!title || !body_text) {
      return c.json({ error: 'title and body_text are required' }, 400);
    }

    // #119: click_url is rendered to every visitor — reject non-http(s)
    // schemes (e.g. `javascript:`) at creation, like the update paths do.
    if (click_url) {
      try {
        const parsed = new URL(click_url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return c.json({ error: 'Invalid click_url format' }, 400);
        }
      } catch {
        return c.json({ error: 'Invalid click_url format' }, 400);
      }
    }

    // Validate ad_type
    if (!ad_type || !['self_hosted', 'admax'].includes(ad_type)) {
      return c.json({ error: 'ad_type must be either "self_hosted" or "admax"' }, 400);
    }

    // For admax ads, payload files are not allowed
    if (ad_type === 'admax' && payloadFile && payloadFile.size > 0) {
      return c.json({ error: 'Admax ads do not support payload files' }, 400);
    }

    let payload_key: string | null = null;
    let payload_type: 'zip' | 'swf' | 'gif' | 'image' | null = null;

    // Handle payload file if present (only for self_hosted ads)
    if (payloadFile && payloadFile.size > 0) {
      // Validate size <= 100MB (Cloudflare Free/Pro plan limit)
      const maxSize = 100 * 1024 * 1024;
      if (payloadFile.size > maxSize) {
        return c.json(
          {
            error:
              'Payload file must be <=100MB on Free/Pro plans. For larger files, upgrade to Business plan (200MB) or use chunked upload.',
            limit: maxSize,
            actualSize: payloadFile.size,
          },
          400,
        );
      }

      if (!c.env.BUCKET) {
        return c.json({ error: 'Storage not available' }, 500);
      }

      // Detect payload_type from file extension
      const fileName = payloadFile.name.toLowerCase();
      if (fileName.endsWith('.zip')) {
        payload_type = 'zip';
      } else if (fileName.endsWith('.swf')) {
        payload_type = 'swf';
      } else if (fileName.endsWith('.gif')) {
        payload_type = 'gif';
      } else if (fileName.endsWith('.png') || fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) {
        payload_type = 'image';
      } else {
        return c.json({ error: 'Unsupported file type. Use .zip, .swf, .gif, .png, or .jpg' }, 400);
      }

      // If zip, validate that index.html exists at root
      if (payload_type === 'zip') {
        const _fileBuffer = await payloadFile.arrayBuffer();
        // For now, we'll assume the zip is valid - in a real implementation you'd extract and check
        console.log('ZIP file validation skipped - would check for index.html at root');
      }

      // Upload to R2
      const r2Key = `ad/payload/${adId}`;
      const fileBuffer = await payloadFile.arrayBuffer();

      // Sync scan: the stored payload_type is chosen from this filename's
      // extension, so the extension ↔ magic-byte check runs against it. The
      // stored Content-Type switches to the sniffed type instead of trusting
      // the multipart header.
      const verdict = await scanUploadSync(c.env.DB, {
        bytes: fileBuffer,
        declaredType: payloadFile.type,
        name: payloadFile.name,
        r2Key,
      });
      if (!verdict.ok) {
        return c.json({ error: verdict.error, code: verdict.code }, verdict.status);
      }
      const payloadMime = verdict.detectedMime;

      if (payload_type === 'zip') {
        await c.env.BUCKET.put(r2Key, fileBuffer);
      } else {
        await c.env.BUCKET.put(r2Key, fileBuffer, {
          httpMetadata: {
            contentType: payloadMime,
          },
        });
      }
      runInBackground(c, () => submitFileScans(c.env.DB, c.env, r2Key, payloadMime, fileBuffer));

      payload_key = r2Key;
    }

    let thumbnail_key: string | null = null;

    // Handle thumbnail file if present
    if (thumbnailFile && thumbnailFile.size > 0) {
      // Validate thumbnail size <= 1MB
      if (thumbnailFile.size > 1024 * 1024) {
        return c.json({ error: 'Thumbnail must be <=1MB' }, 400);
      }

      // Validate thumbnail extension
      const allowedExts = ['jpg', 'jpeg', 'png', 'gif'];
      const ext = thumbnailFile.name.toLowerCase().split('.').pop();
      if (!ext || !allowedExts.includes(ext)) {
        return c.json({ error: 'Thumbnail must be .jpg, .jpeg, .png, or .gif' }, 400);
      }

      // Upload thumbnail to R2
      const thumbnailR2Key = `ad/thumbnail/${adId}.${ext}`;
      const thumbnailBuffer = await thumbnailFile.arrayBuffer();

      const verdict = await scanUploadSync(c.env.DB, {
        bytes: thumbnailBuffer,
        declaredType: thumbnailFile.type,
        name: thumbnailR2Key,
        r2Key: thumbnailR2Key,
      });
      if (!verdict.ok) {
        return c.json({ error: verdict.error, code: verdict.code }, verdict.status);
      }
      const thumbMime = verdict.detectedMime;

      const thumbnailDimError = validateImageDimensions(thumbnailBuffer, thumbMime);
      if (thumbnailDimError) {
        return c.json({ error: `Thumbnail too large. ${thumbnailDimError}` }, 413);
      }
      await c.env.BUCKET.put(thumbnailR2Key, thumbnailBuffer, {
        httpMetadata: {
          contentType: thumbMime,
        },
      });
      runInBackground(c, () => submitFileScans(c.env.DB, c.env, thumbnailR2Key, thumbMime, thumbnailBuffer));

      thumbnail_key = thumbnailR2Key;
    }

    // Insert into database
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO ads (id, title, body_text, click_url, payload_key, payload_type, thumbnail_key, impressions, clicks, active, created_at, ad_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
    `)
      .bind(adId, title, body_text, click_url || null, payload_key, payload_type, thumbnail_key, ad_type)
      .run();

    if (!result.success) {
      console.error('Database insert failed:', result);
      return c.json({ error: 'Failed to create ad' }, 500);
    }

    // Return created ad
    const createdAd = await c.env.DB.prepare('SELECT * FROM ads WHERE id = ?').bind(adId).first();

    return c.json({ ad: createdAd });
  } catch (error: unknown) {
    console.error('Create ad error:', error);
    return c.json({ error: 'Failed to create ad' }, 500);
  }
});

// PATCH /api/admin/ads/:id - update ad (admin endpoint)
ads.patch('/ads/:id', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user || !isAdmin(c.env, user)) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const adId = c.req.param('id');
    const body = await c.req.json();

    if (body.click_url !== undefined && body.click_url !== null) {
      if (typeof body.click_url !== 'string') {
        return c.json({ error: 'Invalid click_url format' }, 400);
      }
      try {
        const parsed = new URL(body.click_url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return c.json({ error: 'Invalid click_url format' }, 400);
        }
      } catch {
        return c.json({ error: 'Invalid click_url format' }, 400);
      }
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Build UPDATE query dynamically
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (body.title !== undefined) {
      updates.push('title = ?');
      values.push(body.title);
    }
    if (body.body_text !== undefined) {
      updates.push('body_text = ?');
      values.push(body.body_text);
    }
    if (body.click_url !== undefined) {
      updates.push('click_url = ?');
      values.push(body.click_url);
    }
    if (body.active !== undefined) {
      updates.push('active = ?');
      values.push(body.active ? 1 : 0);
    }

    if (updates.length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    values.push(adId ?? '');

    const result = await c.env.DB.prepare(`
      UPDATE ads SET ${updates.join(', ')} WHERE id = ?
    `)
      .bind(...values)
      .run();

    if (!result.success) {
      console.error('Database update failed:', result);
      return c.json({ error: 'Failed to update ad' }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Error updating ad:', error);
    return c.json({ error: 'Failed to update ad' }, 500);
  }
});

// PUT /api/admin/ads/:id - update ad (for PATCH-like updates)
ads.put('/ads/:id', requireAdmin, async (c) => {
  try {
    const adId = c.req.param('id');
    const body = await c.req.json();

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Build UPDATE query dynamically
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (body.title !== undefined) {
      updates.push('title = ?');
      values.push(body.title);
    }
    if (body.body_text !== undefined) {
      updates.push('body_text = ?');
      values.push(body.body_text);
    }
    if (body.click_url !== undefined) {
      updates.push('click_url = ?');
      values.push(body.click_url);
    }
    if (body.active !== undefined) {
      updates.push('active = ?');
      values.push(body.active ? 1 : 0);
    }

    if (updates.length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    values.push(adId ?? '');

    const result = await c.env.DB.prepare(`
      UPDATE ads SET ${updates.join(', ')} WHERE id = ?
    `)
      .bind(...values)
      .run();

    if (!result.success) {
      console.error('Database update failed:', result);
      return c.json({ error: 'Failed to update ad' }, 500);
    }

    // Return updated ad
    const updatedAd = await c.env.DB.prepare('SELECT * FROM ads WHERE id = ?').bind(adId).first();

    return c.json({ ad: updatedAd });
  } catch (error: unknown) {
    console.error('Update ad error:', error);
    return c.json({ error: 'Failed to update ad' }, 500);
  }
});

// DELETE /api/admin/ads/:id - delete ad (admin endpoint)
ads.delete('/ads/:id', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user || !isAdmin(c.env, user)) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const adId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Fetch the ad to get payload_key
    const ad = await c.env.DB.prepare('SELECT payload_key FROM ads WHERE id = ?').bind(adId).first();

    if (!ad) {
      return c.json({ error: 'Ad not found' }, 404);
    }

    // Delete R2 object if payload_key exists
    if (ad.payload_key && c.env.BUCKET) {
      await c.env.BUCKET.delete(ad.payload_key as string);
    }

    // Delete the ad row (cascades to ad_interactions)
    const result = await c.env.DB.prepare('DELETE FROM ads WHERE id = ?').bind(adId).run();

    if (!result.success) {
      console.error('Database delete failed:', result);
      return c.json({ error: 'Failed to delete ad' }, 500);
    }

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Delete ad error:', error);
    return c.json({ error: 'Failed to delete ad' }, 500);
  }
});
