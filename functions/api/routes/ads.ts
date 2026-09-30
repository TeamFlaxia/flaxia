import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { isKeyBlocked } from '../../lib/scan/db';
import { requireAdmin } from '../helpers';
import type { Bindings, Variables } from '../types';

const ads = new Hono<{ Bindings: Bindings; Variables: Variables }>();

ads.get('/ads/:id/payload', async (c) => {
  try {
    const adId = c.req.param('id');

    if (!adId) {
      return c.json({ error: 'Missing ad ID' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    if (!c.env.BUCKET) {
      return c.json({ error: 'Storage not available' }, 500);
    }

    // Fetch ad to get payload_key, payload_type, and thumbnail_key
    const ad = await c.env.DB.prepare('SELECT payload_key, payload_type, thumbnail_key FROM ads WHERE id = ?')
      .bind(adId)
      .first();

    if (!ad) {
      return c.json({ error: 'Ad not found' }, 404);
    }

    if (!ad.payload_key) {
      return c.json({ error: 'No payload available' }, 404);
    }

    if (await isKeyBlocked(c.env.CACHE, ad.payload_key as string, c.env.DB)) {
      return c.json({ error: 'Payload not found' }, 404);
    }

    // Get object from R2
    const object = await c.env.BUCKET.get(ad.payload_key as string);

    if (!object) {
      return c.json({ error: 'Payload not found' }, 404);
    }

    // Determine content type based on payload_type
    let contentType = 'application/octet-stream';
    switch (ad.payload_type) {
      case 'zip':
        contentType = 'application/zip';
        break;
      case 'swf':
        contentType = 'application/x-shockwave-flash';
        break;
      case 'gif':
        contentType = 'image/gif';
        break;
      case 'image':
        // Detect from key extension
        const extension = (ad.payload_key as string).split('.').pop()?.toLowerCase();
        if (extension === 'png') {
          contentType = 'image/png';
        } else if (extension === 'jpg' || extension === 'jpeg') {
          contentType = 'image/jpeg';
        } else if (extension === 'gif') {
          contentType = 'image/gif';
        } else if (extension === 'webp') {
          contentType = 'image/webp';
        }
        break;
    }

    // Return the payload with proper headers
    return new Response(object.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
        'Access-Control-Allow-Origin': 'https://flaxia.app',
      },
    });
  } catch (error: unknown) {
    console.error('Ad payload error:', error);
    return c.json({ error: 'Failed to fetch ad payload' }, 500);
  }
});

// GET /api/games - get games (posts with SWF or ZIP payloads) for the arcade
ads.get('/ads/active', async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare(
      'SELECT id, body_text, payload_key, payload_type, thumbnail_key, click_url, impressions, clicks, active, created_at, ad_type FROM ads WHERE active = 1',
    ).all();

    if (!result.success) {
      console.error('Database query failed:', result);
      return c.json({ error: 'Failed to fetch ads' }, 500);
    }

    // Shuffle results in JS
    const shuffled = [...(result.results || [])].sort(() => Math.random() - 0.5);

    return c.json({ ads: shuffled });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Get active ads error:', error);
    return c.json({ error: 'Failed to get active ads', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/ads/:id/impression - track ad impression (public endpoint)
ads.post('/ads/:id/impression', async (c) => {
  try {
    const adId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare('UPDATE ads SET impressions = impressions + 1 WHERE id = ?').bind(adId).run();

    if (!result.success) {
      console.error('Database update failed:', result);
      return c.json({ error: 'Failed to record impression' }, 500);
    }

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Record impression error:', error);
    // Always return success to ensure content display continues
    // even if impression tracking fails
    return c.json({ ok: true, warning: 'Impression tracking failed but content can still be displayed' });
  }
});

// POST /api/posts/:id/impression - track post impression (public endpoint)
ads.post('/ads/:id/click', async (c) => {
  try {
    const adId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare('UPDATE ads SET clicks = clicks + 1 WHERE id = ?').bind(adId).run();

    if (!result.success) {
      console.error('Database update failed:', result);
      return c.json({ error: 'Failed to record click' }, 500);
    }

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Record click error:', error);
    // Always return success to ensure content display continues
    // even if click tracking fails
    return c.json({ ok: true, warning: 'Click tracking failed but content can still be displayed' });
  }
});

// POST /api/ads/:id/interaction - track ad interaction (public endpoint)
ads.post('/ads/:id/interaction', async (c) => {
  try {
    const adId = c.req.param('id');
    const { duration_ms } = await c.req.json();

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const result = await c.env.DB.prepare('INSERT INTO ad_interactions (id, ad_id, duration_ms) VALUES (?, ?, ?)')
      .bind(nanoid(), adId, duration_ms)
      .run();

    if (!result.success) {
      console.error('Database insert failed:', result);
      return c.json({ error: 'Failed to record interaction' }, 500);
    }

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Record interaction error:', error);
    // Always return success to ensure content display continues
    // even if interaction tracking fails
    return c.json({ ok: true, warning: 'Interaction tracking failed but content can still be displayed' });
  }
});

// POST /api/ads/:id/play - track game play start (public endpoint)
ads.post('/ads/:id/play', async (c) => {
  try {
    const adId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Record a 0-duration interaction to track play count
    const result = await c.env.DB.prepare('INSERT INTO ad_interactions (id, ad_id, duration_ms) VALUES (?, ?, 0)')
      .bind(nanoid(), adId)
      .run();

    if (!result.success) {
      console.error('Database insert failed:', result);
      return c.json({ error: 'Failed to record play' }, 500);
    }

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Record play error:', error);
    // Always return success to ensure content display continues
    // even if play tracking fails
    return c.json({ ok: true, warning: 'Play tracking failed but content can still be displayed' });
  }
});

// PUT /api/ads/:id - update ad (for PATCH-like updates)
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
    const err = error as { message?: string };
    console.error('Update ad error:', error);
    return c.json({ error: 'Failed to update ad', details: err.message || 'Unknown error' }, 500);
  }
});

// POST /api/posts/:id/prepare-attachment — generate upload URL for editing existing post attachments (protected)

export default ads;
