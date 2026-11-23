// DOM-free logic for the migrated Svelte dialogs. Keeping validation,
// payload construction and endpoint building here makes the dialogs testable
// without a browser and keeps the view files small.
import type { ReportCategory } from '../../../shared/types/post.ts';

/** Leading cosmetic emoji (v3 keeps labels typographic). */
const LEADING_EMOJI = /^(?:\p{Extended_Pictographic}|\uFE0F|\s)+/u;

const PLATFORM_KEYS: Record<string, string> = {
  X: 'share.platform_x',
  Facebook: 'share.platform_facebook',
  LinkedIn: 'share.platform_linkedin',
  Reddit: 'share.platform_reddit',
  Bluesky: 'share.platform_bluesky',
  Threads: 'share.platform_threads',
};

/**
 * Brand glyphs like 𝕏 / "in" stay as type; an emoji glyph (the Bluesky
 * butterfly) falls back to the platform initial.
 */
export function displayShareIcon(icon: string, name: string): string {
  return /\p{Extended_Pictographic}/u.test(icon) ? name.charAt(0).toUpperCase() : icon;
}

export function platformLabelKey(name: string): string {
  return PLATFORM_KEYS[name] || name;
}

export function plainReportLabel(value: string): string {
  return value.replace(LEADING_EMOJI, '');
}

export interface ReportCategoryOption {
  value: ReportCategory;
  labelKey: string;
}

export const REPORT_CATEGORIES: readonly ReportCategoryOption[] = [
  { value: 'spam', labelKey: 'post.report_category_spam' },
  { value: 'harassment', labelKey: 'post.report_category_harassment' },
  { value: 'hate_speech', labelKey: 'post.report_category_hate_speech' },
  { value: 'inappropriate', labelKey: 'post.report_category_inappropriate' },
  { value: 'misinformation', labelKey: 'post.report_category_misinformation' },
  { value: 'privacy', labelKey: 'post.report_category_privacy' },
  { value: 'copyright', labelKey: 'post.report_category_copyright' },
  { value: 'malware', labelKey: 'post.report_category_malware' },
  { value: 'csam', labelKey: 'post.report_category_csam' },
  { value: 'nsfw_untagged', labelKey: 'post.report_category_nsfw_untagged' },
  { value: 'other', labelKey: 'post.report_category_other' },
];

export interface ReportDmcaInput {
  work: string;
  email: string;
  sworn: boolean;
}

export function isReportSubmitEnabled(category: ReportCategory | null, dmca?: ReportDmcaInput): boolean {
  if (!category) return false;
  if (category === 'copyright') {
    if (!dmca) return false;
    return dmca.work.trim().length > 0 && dmca.email.trim().length > 0 && dmca.sworn;
  }
  return true;
}

export interface ReportPayload {
  post_id: string;
  category: ReportCategory;
  dmca?: { work_description: string; reporter_email: string; sworn: boolean };
}

export function buildReportPayload(postId: string, category: ReportCategory, dmca?: ReportDmcaInput): ReportPayload {
  const payload: ReportPayload = { post_id: postId, category };
  if (category === 'copyright' && dmca) {
    payload.dmca = {
      work_description: dmca.work.trim(),
      reporter_email: dmca.email.trim(),
      sworn: dmca.sworn,
    };
  }
  return payload;
}

export interface CounterNoticeInput {
  name: string;
  email: string;
  address: string;
  phone: string;
  statement: boolean;
  consent: boolean;
}

export interface CounterNoticePayload {
  name: string;
  email: string;
  address: string;
  phone: string;
  statement: boolean;
  consent_jurisdiction: boolean;
}

export function isCounterNoticeValid(input: CounterNoticeInput): boolean {
  return (
    input.name.trim().length > 0 &&
    input.email.trim().length > 0 &&
    input.address.trim().length > 0 &&
    input.phone.trim().length > 0 &&
    input.statement &&
    input.consent
  );
}

export function buildCounterNoticePayload(input: CounterNoticeInput): CounterNoticePayload {
  return {
    name: input.name.trim(),
    email: input.email.trim(),
    address: input.address.trim(),
    phone: input.phone.trim(),
    statement: input.statement,
    consent_jurisdiction: input.consent,
  };
}

export function blockedAvatarPath(avatarKey?: string | null): string {
  return avatarKey ? `/api/images/${avatarKey}` : '/api/images/default-avatar';
}

export function unblockEndpoint(username: string): string {
  return `/api/users/${encodeURIComponent(username)}/block`;
}

export function removeBlockedUser<T extends { username: string }>(users: T[], username: string): T[] {
  return users.filter((user) => user.username !== username);
}

export function versionsEndpoint(postId: string): string {
  return `/api/posts/${postId}/versions`;
}

export function isCurrentVersion(currentVersionId: string | null, versionId: string | null): boolean {
  return currentVersionId === versionId;
}

export type GameUpdateFileError = 'missing' | 'not_zip' | null;

export function gameUpdateFileError(file: { name: string } | null | undefined): GameUpdateFileError {
  if (!file) return 'missing';
  return file.name.toLowerCase().endsWith('.zip') ? null : 'not_zip';
}
