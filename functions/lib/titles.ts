import type { D1Database } from '@cloudflare/workers-types';

/** Awarded by `registerUser()` to every new account. */
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
