import type { PostVisibility } from '../../../shared/types/post.ts';

const VALID_VISIBILITIES = new Set<string>(['public', 'unlisted', 'private', 'direct']);

/**
 * Fail-closed validation for a visibility read from a stored draft/autosave.
 * Unknown or wrong-typed values must never widen the audience: a stale or
 * tampered draft restores as `private`. Only a genuinely absent field (a
 * legacy draft written before visibility existed) keeps the historical
 * `public` default.
 */
export function normalizeDraftVisibility(value: unknown): PostVisibility {
  if (value === undefined) return 'public';
  return typeof value === 'string' && VALID_VISIBILITIES.has(value) ? (value as PostVisibility) : 'private';
}

/** Return a plain storage-ready copy with a validated `visibility` field. */
export function encodeDraftVisibility<T extends object>(draft: T): T & { visibility: PostVisibility } {
  const raw = draft as T & { visibility?: unknown };
  return { ...raw, visibility: normalizeDraftVisibility(raw.visibility) };
}

/**
 * Decode a persisted draft/autosave payload. Legacy entries written before the
 * visibility field existed default to `public`; malformed or tampered values
 * fall back to `private` so they cannot widen the audience.
 */
export function decodeDraftVisibility(data: unknown): Record<string, unknown> & { visibility: PostVisibility } {
  const isRecord = typeof data === 'object' && data !== null && !Array.isArray(data);
  const raw = (isRecord ? data : {}) as Record<string, unknown>;
  // A non-object payload is malformed, not a legacy draft: never assume public.
  const visibility = isRecord ? normalizeDraftVisibility(raw.visibility) : 'private';
  return { ...raw, visibility };
}
