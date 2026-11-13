import { Hono } from 'hono';
import { checkRateLimit } from '../../lib/rate-limit';
import {
  awardGameTitle,
  createGameTitle,
  DEFAULT_GAME_TITLE_ICON,
  equipTitle,
  GAME_TITLE_DESCRIPTION_MAX,
  GAME_TITLE_ID_MAX,
  GAME_TITLE_NAME_MAX,
  type GameTitleInput,
  isGameTitleIcon,
  type TitleRow,
  type UserTitleRow,
} from '../../lib/titles';
import { requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const titles = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const TITLE_COLUMNS = 'id, icon, name, name_ja, description, description_ja, sort_order';

/** Matches the id shape `servePublicLoader` accepts for a post. */
const POST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TITLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface RawGameTitleBody {
  postId?: unknown;
  titleId?: unknown;
  name?: unknown;
  nameJa?: unknown;
  description?: unknown;
  descriptionJa?: unknown;
  icon?: unknown;
}

function optionalText(
  value: unknown,
  max: number,
  field: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: '' };
  if (typeof value !== 'string' || value.length > max) {
    return { ok: false, error: `${field} must be a string of at most ${max} characters` };
  }
  return { ok: true, value };
}

function parseGameTitle(body: RawGameTitleBody): { ok: true; input: GameTitleInput } | { ok: false; error: string } {
  if (typeof body.postId !== 'string' || !POST_ID.test(body.postId)) {
    return { ok: false, error: 'postId must be a valid post id' };
  }
  if (typeof body.titleId !== 'string' || !TITLE_ID.test(body.titleId)) {
    return { ok: false, error: `titleId must be 1-${GAME_TITLE_ID_MAX} alphanumeric/._:- characters` };
  }
  if (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.length > GAME_TITLE_NAME_MAX) {
    return { ok: false, error: `name must be 1-${GAME_TITLE_NAME_MAX} characters` };
  }

  const nameJa = optionalText(body.nameJa, GAME_TITLE_NAME_MAX, 'nameJa');
  if (!nameJa.ok) return nameJa;
  const description = optionalText(body.description, GAME_TITLE_DESCRIPTION_MAX, 'description');
  if (!description.ok) return description;
  const descriptionJa = optionalText(body.descriptionJa, GAME_TITLE_DESCRIPTION_MAX, 'descriptionJa');
  if (!descriptionJa.ok) return descriptionJa;

  let icon = DEFAULT_GAME_TITLE_ICON;
  if (body.icon !== undefined) {
    if (typeof body.icon !== 'string' || !isGameTitleIcon(body.icon)) {
      return { ok: false, error: 'icon must be a same-origin image path' };
    }
    icon = body.icon;
  }

  return {
    ok: true,
    input: {
      postId: body.postId,
      titleId: body.titleId,
      name: body.name,
      nameJa: nameJa.value,
      description: description.value,
      descriptionJa: descriptionJa.value,
      icon,
    },
  };
}

/** The game post must be the published, visible payload the caller is running. */
async function requireGamePost(db: D1Database, postId: string): Promise<boolean> {
  const post = await db
    .prepare('SELECT 1 FROM posts WHERE id = ? AND hidden = 0 AND status = ?')
    .bind(postId, 'published')
    .first();
  return Boolean(post);
}

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

// POST /api/titles/game - author a title for the game post the caller is
// running. The parent relays the game's CREATE_TITLE frame and supplies the
// postId from its own frame registry, so a game can only ever author titles
// scoped to itself. Definitions are write-once per id.
titles.post('/titles/game', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const limited = await checkRateLimit(c.env.CACHE, `titles:game:create:${user.id}`, {
    maxRequests: 120,
    windowSeconds: 300,
  });
  if (!limited) return c.json({ error: 'Too many title requests', code: 'RATE_LIMITED' }, 429);

  const body = (await c.req.json().catch(() => ({}))) as RawGameTitleBody;
  const parsed = parseGameTitle(body);
  if (!parsed.ok) return c.json({ error: parsed.error, code: 'INVALID_TITLE' }, 400);

  if (!(await requireGamePost(c.env.DB, parsed.input.postId))) {
    return c.json({ error: 'Unknown game post', code: 'POST_NOT_FOUND' }, 404);
  }

  const created = await createGameTitle(c.env.DB, parsed.input);
  if (created === 'conflict') {
    return c.json({ error: 'Title id already belongs to another game', code: 'TITLE_CONFLICT' }, 409);
  }
  if (created === 'limit') {
    return c.json({ error: 'This game has reached its title limit', code: 'TITLE_LIMIT' }, 409);
  }

  const title = await c.env.DB.prepare(`SELECT ${TITLE_COLUMNS} FROM titles WHERE id = ?`)
    .bind(parsed.input.titleId)
    .first<TitleRow>();
  return c.json({ title, created: created === 'created' }, created === 'created' ? 201 : 200);
});

// POST /api/titles/game/award - grant a game-authored title to the caller.
// Idempotent: re-awarding an owned title succeeds without changing anything.
// A title that exists but is scoped to a different game (or to the platform)
// is rejected, which is what stops a game from faking another game's badge.
titles.post('/titles/game/award', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const limited = await checkRateLimit(c.env.CACHE, `titles:game:award:${user.id}`, {
    maxRequests: 300,
    windowSeconds: 300,
  });
  if (!limited) return c.json({ error: 'Too many award requests', code: 'RATE_LIMITED' }, 429);

  const body = (await c.req.json().catch(() => ({}))) as RawGameTitleBody;
  const parsed = parseGameTitle(body);
  if (!parsed.ok) return c.json({ error: parsed.error, code: 'INVALID_TITLE' }, 400);

  if (!(await requireGamePost(c.env.DB, parsed.input.postId))) {
    return c.json({ error: 'Unknown game post', code: 'POST_NOT_FOUND' }, 404);
  }

  const result = await awardGameTitle(c.env.DB, user.id, parsed.input);
  if (result === 'conflict') {
    return c.json({ error: 'Title id already belongs to another game', code: 'TITLE_CONFLICT' }, 409);
  }
  if (result === 'limit') {
    return c.json({ error: 'This game has reached its title limit', code: 'TITLE_LIMIT' }, 409);
  }

  return c.json({ title_id: parsed.input.titleId, awarded: true });
});

export default titles;
