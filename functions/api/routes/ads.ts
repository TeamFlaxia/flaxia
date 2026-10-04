import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { checkRateLimit, getClientIp } from '../../lib/rate-limit';
import { isKeyBlocked } from '../../lib/scan/db';
import { requireAdmin } from '../helpers';
import type { Bindings, Variables } from '../types';

const ads = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * Metric endpoints are public and write on every call: throttle per IP so
 * they cannot be used for D1 write floods or billing-metric inflation.
 */
async function checkMetricRateLimit(c: { req: { raw: Request }; env: Bindings }): Promise<boolean> {
  return checkRateLimit(c.env.CACHE, `ads:metric:${getClientIp(c.req.raw)}`, {
    maxRequests: 120,
    windowSeconds: 60,
  });
}

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

    // Fetch ad to get payload_key, payload_type, and thumbnail_key.
    // Only active ads are servable: a deactivated (e.g. policy-violating)
    // ad must not stay fetchable by direct ID.
    const ad = await c.env.DB.prepare(
      'SELECT payload_key, payload_type, thumbnail_key FROM ads WHERE id = ? AND active = 1',
    )
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

    // Public, low-churn inventory: safe for short edge caching (success only).
    return c.json({ ads: shuffled }, 200, {
      'Cache-Control': 'public, max-age=60',
    });
  } catch (error: unknown) {
    console.error('Get active ads error:', error);
    return c.json({ error: 'Failed to get active ads' }, 500);
  }
});

// POST /api/ads/:id/impression - track ad impression (public endpoint)
ads.post('/ads/:id/impression', async (c) => {
  try {
    if (!(await checkMetricRateLimit(c))) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
    const adId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // #71: count only for a live ad. Otherwise any id (including removed
    // ones) burns a D1 write per call with no observable row change.
    const live = await c.env.DB.prepare('SELECT 1 FROM ads WHERE id = ? AND active = 1').bind(adId).first();
    if (!live) {
      return c.json({ error: 'Ad not found' }, 404);
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
    if (!(await checkMetricRateLimit(c))) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
    const adId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // #71: same liveness guard as impressions.
    const live = await c.env.DB.prepare('SELECT 1 FROM ads WHERE id = ? AND active = 1').bind(adId).first();
    if (!live) {
      return c.json({ error: 'Ad not found' }, 404);
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
    if (!(await checkMetricRateLimit(c))) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
    const adId = c.req.param('id');
    const { duration_ms } = await c.req.json();
    // #71: durations are client-asserted — bound both ends (a day is absurd
    // already) and refuse orphan rows for dead ad ids like the counters do.
    if (typeof duration_ms !== 'number' || !Number.isFinite(duration_ms) || duration_ms < 0 || duration_ms > 86400000) {
      return c.json({ error: 'Invalid duration' }, 400);
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const liveInteraction = await c.env.DB.prepare('SELECT 1 FROM ads WHERE id = ? AND active = 1').bind(adId).first();
    if (!liveInteraction) {
      return c.json({ error: 'Ad not found' }, 404);
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
    if (!(await checkMetricRateLimit(c))) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
    const adId = c.req.param('id');

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // #71: same liveness guard as the other metric writes.
    const livePlay = await c.env.DB.prepare('SELECT 1 FROM ads WHERE id = ? AND active = 1').bind(adId).first();
    if (!livePlay) {
      return c.json({ error: 'Ad not found' }, 404);
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
      if (body.click_url !== null) {
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

// POST /api/posts/:id/prepare-attachment — generate upload URL for editing existing post attachments (protected)

export default ads;
