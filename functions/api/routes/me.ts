import { Hono } from 'hono';
import { extendSession, getSessionToken } from '../../lib/auth';
import { requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const me = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// GET /api/me - check auth state
me.get('/me', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Not authenticated' }, 401);
    }

    // Extend session (sliding window) - keep user logged in if active
    const token = getSessionToken(c.req.raw);
    if (token) {
      await extendSession(c.env, token);
    }

    // Keep this dedicated free review entitlement independent from Stripe
    // subscription webhooks and visible to authenticated clients.
    const isReviewerAccount = user.email.toLowerCase() === 'devtest@flaxia.app';
    const userForResponse =
      isReviewerAccount && user.badge_type !== 'flaxia_plus' ? { ...user, badge_type: 'flaxia_plus' } : user;
    if (isReviewerAccount && user.badge_type !== 'flaxia_plus') {
      await c.env.DB.prepare("UPDATE users SET badge_type = 'flaxia_plus' WHERE id = ? AND badge_type != 'flaxia_plus'")
        .bind(user.id)
        .run();
    }

    return c.json({
      user: {
        ...userForResponse,
        ng_words: JSON.parse(user.ng_words ?? '[]') as string[],
      },
    });
  } catch (error: unknown) {
    console.error('Auth check error:', error);
    return c.json({ error: 'Auth check failed' }, 500);
  }
});

export default me;
