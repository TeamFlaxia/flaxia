import type { D1Database } from '@cloudflare/workers-types';

/** Awarded to every account on registration and on later logins. */
export const NEWCOMER_TITLE_ID = 'flaxian_newcomer';

/**
 * SQL fragments that attach the equipped title (achievement) to any query that
 * already selects from `users u`. Keep the alias `u` so the join stays valid in
 * follows/blocks/search queries.
 */
export const USER_TITLE_JOIN = 'LEFT JOIN titles t ON t.id = u.equipped_title_id';
export const USER_TITLE_COLUMNS = `u.equipped_title_id,
  t.name AS title_name, t.name_ja AS title_name_ja,
  t.description AS title_description, t.description_ja AS title_description_ja,
  t.icon AS title_icon`;

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

/** Flattened display fields of an equipped title, or nulls when unequipped. */
export interface EquippedTitleFields {
  title_name: string | null;
  title_name_ja: string | null;
  title_description: string | null;
  title_description_ja: string | null;
  title_icon: string | null;
}

export const NULL_EQUIPPED_TITLE: EquippedTitleFields = {
  title_name: null,
  title_name_ja: null,
  title_description: null,
  title_description_ja: null,
  title_icon: null,
};

/**
 * Resolves the equipped title's display fields for API responses that only
 * carry `equipped_title_id` (for example `/api/me`). Returns all-null fields
 * when no title is equipped or the catalog row is missing.
 */
export async function equippedTitleFields(
  db: D1Database,
  titleId: string | null | undefined,
): Promise<EquippedTitleFields> {
  if (!titleId) return NULL_EQUIPPED_TITLE;
  const row = await db
    .prepare('SELECT name, name_ja, description, description_ja, icon FROM titles WHERE id = ?')
    .bind(titleId)
    .first<{ name: string; name_ja: string; description: string; description_ja: string; icon: string }>();
  if (!row) return NULL_EQUIPPED_TITLE;
  return {
    title_name: row.name,
    title_name_ja: row.name_ja,
    title_description: row.description,
    title_description_ja: row.description_ja,
    title_icon: row.icon,
  };
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
