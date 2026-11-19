import { Hono } from 'hono';
import { getAdminAnalytics, parseAnalyticsDays } from '../../lib/admin-analytics';
import { requireAdmin, requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';
import { ads } from './admin/ads.ts';
import { maintenance } from './admin/maintenance.ts';
import { moderation } from './admin/moderation.ts';
import { users } from './admin/users.ts';

const admin = new Hono<{ Bindings: Bindings; Variables: Variables }>();

admin.get('/access', requireAuth, requireAdmin, (c) => {
  c.header('Cache-Control', 'private, no-store');
  return c.json({ allowed: true });
});

// Return aggregate metrics and public labels for ranked games; never cache analytics by a CDN.
admin.get('/analytics', requireAuth, requireAdmin, async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const days = parseAnalyticsDays(c.req.query('days'));
  if (days === null) return c.json({ error: 'days must be 7, 30, or 90' }, 400);
  if (!c.env.DB) return c.json({ error: 'Database not available' }, 503);
  try {
    return c.json(await getAdminAnalytics(c.env.DB, days));
  } catch (error: unknown) {
    console.error('Admin analytics error:', error);
    return c.json({ error: 'Failed to fetch analytics' }, 500);
  }
});

admin.route('/', moderation);
admin.route('/', users);
admin.route('/', maintenance);
admin.route('/', ads);

export default admin;
