// Pure, DOM-free composer logic shared by the legacy DOM controller and the
// Svelte composer. Keeping these rules here lets the Svelte rewrite reuse the
// exact same behaviour instead of re-deriving it from the old component.

import { GAME_FILE_EXTENSIONS } from '../../../shared/file-extensions.ts';

export const POST_CHAR_LIMIT = 200;
export const CHAR_WARN_THRESHOLD = 180;
export const MAX_MEDIA_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_MEDIA_TOTAL_BYTES = 50 * 1024 * 1024;

export interface ComposerDraft {
  id: string;
  text: string;
  savedAt: number;
}

export interface ComposerAutosavePoll {
  question: string;
  options: string[];
  duration: string;
}

export interface ComposerAutosave {
  text: string;
  savedAt: number;
  poll?: ComposerAutosavePoll;
}

export interface PollData {
  question: string;
  options: string[];
  multipleChoice: boolean;
  endsAt?: string;
}

export type MeterState = 'idle' | 'warn' | 'max';

export function parseComposerDrafts(value: unknown): ComposerDraft[] {
  if (!Array.isArray(value)) return [];
  return value.filter((draft): draft is ComposerDraft => {
    if (typeof draft !== 'object' || draft === null) return false;
    const candidate = draft as Record<string, unknown>;
    return (
      typeof candidate.id === 'string' &&
      typeof candidate.text === 'string' &&
      typeof candidate.savedAt === 'number' &&
      Number.isFinite(candidate.savedAt)
    );
  });
}

export function parseComposerAutosave(value: unknown): ComposerAutosave | null {
  if (typeof value !== 'object' || value === null) return null;
  const draft = value as Partial<ComposerAutosave>;
  if (typeof draft.text !== 'string' || typeof draft.savedAt !== 'number' || !Number.isFinite(draft.savedAt))
    return null;
  if (
    draft.poll &&
    (typeof draft.poll.question !== 'string' ||
      !Array.isArray(draft.poll.options) ||
      !draft.poll.options.every((option) => typeof option === 'string') ||
      typeof draft.poll.duration !== 'string')
  )
    return null;
  return draft as ComposerAutosave;
}

export function fileExtension(name: string): string {
  return name.toLowerCase().split('.').pop() || '';
}

export function isGameFile(name: string): boolean {
  return GAME_FILE_EXTENSIONS.has(fileExtension(name));
}

/** Mirror of the legacy conic-gradient progress ring + meter state machine. */
export function charMeter(length: number): { ratio: number; state: MeterState; empty: boolean } {
  return {
    ratio: Math.max(0, Math.min(1, length / POST_CHAR_LIMIT)),
    state: length >= POST_CHAR_LIMIT ? 'max' : length > CHAR_WARN_THRESHOLD ? 'warn' : 'idle',
    empty: length === 0,
  };
}

export function canSubmit(text: string, quoted: unknown, isSubmitting: boolean): boolean {
  return (text.trim().length > 0 || quoted != null) && !isSubmitting;
}

export function buildPollData(input: {
  active: boolean;
  question: string;
  options: string[];
  durationMs: number;
  now?: number;
}): PollData | null {
  if (!input.active) return null;
  const question = input.question.trim();
  const options = input.options.map((option) => option.trim()).filter((option) => option.length > 0);
  if (!question || options.length < 2) return null;
  const endsAt = new Date((input.now ?? Date.now()) + input.durationMs).toISOString();
  return { question, options, multipleChoice: false, endsAt };
}

export type SubmissionIssue =
  | { key: 'composer.error_file_too_large' }
  | { key: 'composer.error_too_many_media'; max: number }
  | { key: 'composer.error_total_too_large'; max: number };

/** Upload caps enforced at post time; check order matches the legacy controller. */
export function validateSubmission(input: {
  selectedFile: { size: number } | null;
  selectedMedia: Array<{ size: number }>;
  maxMediaAttachments: number;
  /** Plan-aware overrides; defaults mirror the free plan. */
  maxFileBytes?: number;
  maxTotalBytes?: number;
}): SubmissionIssue | null {
  const maxFileBytes = input.maxFileBytes ?? MAX_MEDIA_FILE_BYTES;
  const maxTotalBytes = input.maxTotalBytes ?? MAX_MEDIA_TOTAL_BYTES;
  if (input.selectedFile && input.selectedFile.size > maxFileBytes) {
    return { key: 'composer.error_file_too_large' };
  }
  if (input.selectedMedia.length > input.maxMediaAttachments) {
    return { key: 'composer.error_too_many_media', max: input.maxMediaAttachments };
  }
  for (const file of input.selectedMedia) {
    if (file.size > maxFileBytes) return { key: 'composer.error_file_too_large' };
  }
  const total = input.selectedMedia.reduce((sum, file) => sum + file.size, 0);
  if (total > maxTotalBytes) {
    return { key: 'composer.error_total_too_large', max: Math.floor(maxTotalBytes / (1024 * 1024)) };
  }
  return null;
}
