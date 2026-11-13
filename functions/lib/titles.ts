import type { D1Database } from '@cloudflare/workers-types';

/** Awarded to every account on registration and on later logins. */
export const NEWCOMER_TITLE_ID = 'flaxian_newcomer';

export interface TitleRow {
  id: string;
  icon: string;
  name: string;
  name_ja: string;
  description: string;
  description_ja: string;
  sort_order: number;
}

export interface UserTitleRow extends TitleRow {
  awarded_at: string;
}

/**
 * Grants a title to a user. Awards are idempotent because a user can own a
 * title only once. Future achievement systems (Arcade clears, etc.) should call
 * this helper instead of writing to `user_titles` directly.
 */
export async function awardTitle(db: D1Database, userId: string, titleId: string): Promise<boolean> {
  const title = await db.prepare('SELECT 1 FROM titles WHERE id = ?').bind(titleId).first();
  if (!title) return false;

  await db.prepare('INSERT OR IGNORE INTO user_titles (user_id, title_id) VALUES (?, ?)').bind(userId, titleId).run();
  return true;
}

/**
 * Reconciles the account-creation title. Registration and login both call it so
 * accounts created before the title existed receive it on their next sign-in.
 * Best-effort: a missing catalog row must never block authentication.
 */
export async function ensureNewcomerTitle(db: D1Database, userId: string): Promise<void> {
  try {
    const awarded = await awardTitle(db, userId, NEWCOMER_TITLE_ID);
    if (!awarded) console.warn(`Newcomer title ${NEWCOMER_TITLE_ID} is not seeded`);
  } catch (error) {
    console.error('Failed to award newcomer title:', error);
  }
}

/** Longest game title id. Bounded so ids stay usable as API path/JSON values. */
export const GAME_TITLE_ID_MAX = 128;
/** Authoring limits applied to every game-authored title. */
export const GAME_TITLE_NAME_MAX = 64;
export const GAME_TITLE_DESCRIPTION_MAX = 200;
export const GAME_TITLE_ICON_MAX = 512;

/** Fallback icon for a game title that does not ship one. */
export const DEFAULT_GAME_TITLE_ICON = '/icons/badge-96.png';
/** Titles a single game post may author. */
export const MAX_TITLES_PER_GAME = 200;
/** Game titles sort after the platform catalog. */
const GAME_TITLE_SORT_ORDER = 1000;

export interface GameTitleInput {
  postId: string;
  titleId: string;
  name: string;
  nameJa: string;
  description: string;
  descriptionJa: string;
  icon: string;
}

export type GameTitleCreation = 'created' | 'exists' | 'conflict' | 'limit';
export type GameTitleAward = 'awarded' | 'conflict' | 'limit';

/**
 * Game title icons must stay same-origin paths. A profile that rendered an
 * absolute third-party URL would phone that host on every timeline view, and
 * the catalog has no review step for game-authored art.
 */
export function isGameTitleIcon(icon: string): boolean {
  return icon.startsWith('/') && !icon.startsWith('//') && icon.length <= GAME_TITLE_ICON_MAX;
}

/**
 * Authors a title owned by `input.postId`. Definitions are write-once: the
 * first writer fixes the display text, and a title id that already belongs to
 * another game (or to the platform) is a conflict rather than a takeover.
 */
export async function createGameTitle(db: D1Database, input: GameTitleInput): Promise<GameTitleCreation> {
  const existing = await db
    .prepare('SELECT game_post_id FROM titles WHERE id = ?')
    .bind(input.titleId)
    .first<{ game_post_id: string | null }>();
  if (existing) return existing.game_post_id === input.postId ? 'exists' : 'conflict';

  const owned = await db
    .prepare('SELECT COUNT(*) AS n FROM titles WHERE game_post_id = ?')
    .bind(input.postId)
    .first<{ n: number }>();
  if ((owned?.n ?? 0) >= MAX_TITLES_PER_GAME) return 'limit';

  try {
    await db
      .prepare(
        `INSERT INTO titles (id, icon, name, name_ja, description, description_ja, sort_order, game_post_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.titleId,
        input.icon,
        input.name,
        input.nameJa,
        input.description,
        input.descriptionJa,
        GAME_TITLE_SORT_ORDER,
        input.postId,
      )
      .run();
  } catch {
    // Concurrent authoring of the same id: fall through to the ownership check.
    const raced = await db.prepare('SELECT game_post_id FROM titles WHERE id = ?').bind(input.titleId).first<{
      game_post_id: string | null;
    }>();
    return raced && raced.game_post_id === input.postId ? 'exists' : 'conflict';
  }
  return 'created';
}

/**
 * Grants a game-authored title to a user, authoring the definition first when
 * it does not exist yet. The scope check is the guarantee that a game can only
 * ever grant titles it authored itself — never a platform title and never
 * another game's achievement.
 */
export async function awardGameTitle(db: D1Database, userId: string, input: GameTitleInput): Promise<GameTitleAward> {
  const created = await createGameTitle(db, input);
  if (created === 'conflict') return 'conflict';
  if (created === 'limit') return 'limit';

  const scoped = await db
    .prepare('SELECT 1 FROM titles WHERE id = ? AND game_post_id = ?')
    .bind(input.titleId, input.postId)
    .first();
  if (!scoped) return 'conflict';

  const granted = await db
    .prepare('INSERT OR IGNORE INTO user_titles (user_id, title_id) VALUES (?, ?)')
    .bind(userId, input.titleId)
    .run();
  return granted.success ? 'awarded' : 'conflict';
}

/**
 * Sets (or clears) the title shown after the user's username. A user can only
 * equip a title they own; `null` removes the title.
 */
export async function equipTitle(db: D1Database, userId: string, titleId: string | null): Promise<boolean> {
  if (titleId !== null) {
    const owned = await db
      .prepare('SELECT 1 FROM user_titles WHERE user_id = ? AND title_id = ?')
      .bind(userId, titleId)
      .first();
    if (!owned) return false;
  }

  const result = await db.prepare('UPDATE users SET equipped_title_id = ? WHERE id = ?').bind(titleId, userId).run();
  return result.success;
}
