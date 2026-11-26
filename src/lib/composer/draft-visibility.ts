import type { PostVisibility } from '../../../shared/types/post.ts';

const VALID_VISIBILITIES = new Set<string>(['public', 'unlisted', 'private', 'direct']);

/**
 * Fail-closed validation for a visibility read from a stored draft/autosave.
 * Anything unexpected becomes the historical `public` default: a stale or
 * tampered draft must never carry an arbitrary audience value into the composer.
 */
export function normalizeDraftVisibility(value: unknown): PostVisibility {
  return typeof value === 'string' && VALID_VISIBILITIES.has(value) ? (value as PostVisibility) : 'public';
}

/** Return a plain storage-ready copy with a validated `visibility` field. */
export function encodeDraftVisibility<T extends object>(draft: T): T & { visibility: PostVisibility } {
  const raw = draft as T & { visibility?: unknown };
  return { ...raw, visibility: normalizeDraftVisibility(raw.visibility) };
}

/**
 * Decode a persisted draft/autosave payload. Legacy entries written before the
 * visibility field existed (and malformed data) default to `public`.
 */
export function decodeDraftVisibility(data: unknown): Record<string, unknown> & { visibility: PostVisibility } {
  const raw = (typeof data === 'object' && data !== null && !Array.isArray(data) ? data : {}) as Record<
    string,
    unknown
  >;
  return { ...raw, visibility: normalizeDraftVisibility(raw.visibility) };
}
