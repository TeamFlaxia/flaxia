import { Hono } from 'hono';
import { equipTitle, type TitleRow, type UserTitleRow } from '../../lib/titles';
import { requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const titles = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const TITLE_COLUMNS = 'id, icon, name, name_ja, description, description_ja, sort_order';

// GET /api/titles - the full title catalog (public).
titles.get('/titles', async (c) => {
  const result = await c.env.DB.prepare(`SELECT ${TITLE_COLUMNS} FROM titles ORDER BY sort_order, id`).all<TitleRow>();
  return c.json({ titles: result.results || [] });
});

// GET /api/titles/me - titles owned by the signed-in user.
titles.get('/titles/me', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const [owned, me] = await Promise.all([
    c.env.DB.prepare(
      `SELECT t.id, t.icon, t.name, t.name_ja, t.description, t.description_ja, t.sort_order, ut.awarded_at
       FROM user_titles ut
       JOIN titles t ON t.id = ut.title_id
       WHERE ut.user_id = ?
       ORDER BY ut.awarded_at DESC, t.sort_order, t.id`,
    )
      .bind(user.id)
      .all<UserTitleRow>(),
    c.env.DB.prepare('SELECT equipped_title_id FROM users WHERE id = ?').bind(user.id).first<{
      equipped_title_id: string | null;
    }>(),
  ]);

  const equippedTitleId = me?.equipped_title_id ?? null;
  return c.json({
    titles: (owned.results || []).map((title) => ({
      ...title,
      equipped: title.id === equippedTitleId,
    })),
    equipped_title_id: equippedTitleId,
  });
});

// PUT /api/titles/me/equipped - choose the title shown after the username.
titles.put('/titles/me/equipped', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => ({}))) as { titleId?: unknown };
  const titleId = body.titleId === null ? null : typeof body.titleId === 'string' ? body.titleId : undefined;

  if (titleId === undefined) {
    return c.json({ error: 'titleId must be a string or null' }, 400);
  }

  if (titleId !== null) {
    const title = await c.env.DB.prepare('SELECT 1 FROM titles WHERE id = ?').bind(titleId).first();
    if (!title) return c.json({ error: 'Unknown title' }, 404);

    const owned = await c.env.DB.prepare('SELECT 1 FROM user_titles WHERE user_id = ? AND title_id = ?')
      .bind(user.id, titleId)
      .first();
    if (!owned) return c.json({ error: 'Title not owned' }, 403);
  }

  const ok = await equipTitle(c.env.DB, user.id, titleId);
  if (!ok) return c.json({ error: 'Failed to update title' }, 500);

  return c.json({ equipped_title_id: titleId });
});

export default titles;
