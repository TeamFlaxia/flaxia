import { getLocale } from './i18n.js';

/** A title definition plus (optionally) ownership metadata from the API. */
export interface UserTitle {
  id: string;
  icon: string;
  name: string;
  name_ja?: string | null;
  description: string;
  description_ja?: string | null;
  awarded_at?: string;
  equipped?: boolean;
}

/** Flattened title columns returned alongside posts and profiles. */
export interface UserTitleFields {
  equipped_title_id?: string | null;
  title_name?: string | null;
  title_name_ja?: string | null;
  title_description?: string | null;
  title_description_ja?: string | null;
  title_icon?: string | null;
}

export function titleName(title: Pick<UserTitle, 'name' | 'name_ja'>): string {
  return getLocale() === 'ja' ? title.name_ja || title.name : title.name;
}

export function titleDescription(title: Pick<UserTitle, 'description' | 'description_ja'>): string {
  return getLocale() === 'ja' ? title.description_ja || title.description : title.description;
}

/** Build a title from the flat columns included on post/profile responses. */
export function titleFromFields(row: UserTitleFields): UserTitle | null {
  if (!row.title_name) return null;
  return {
    id: row.equipped_title_id || row.title_name,
    icon: row.title_icon || '',
    name: row.title_name,
    name_ja: row.title_name_ja,
    description: row.title_description || '',
    description_ja: row.title_description_ja,
  };
}

/**
 * Renders a compact icon + name badge. Callers append this after the username;
 * returns null when the user has no equipped title.
 */
export function createUserTitleBadge(row: UserTitleFields): HTMLElement | null {
  const title = titleFromFields(row);
  if (!title) return null;

  const name = titleName(title);
  const description = titleDescription(title);

  const badge = document.createElement('span');
  badge.className = 'user-title-badge';
  badge.textContent = title.icon ? `${title.icon} ${name}` : name;
  badge.title = description || name;
  badge.setAttribute('aria-label', description ? `${name}: ${description}` : name);
  return badge;
}
