/**
 * Client-side view of plan entitlements. These caps mirror
 * `functions/lib/attachments.ts`; the server is always authoritative.
 */

/** Multi-media attachment limits (mirrors functions/lib/attachments.ts). */
export const MAX_MEDIA_ATTACHMENTS = 4;
export const MAX_MEDIA_ATTACHMENTS_PLUS = 32;

/** Minimal user shape needed to resolve plan entitlements. */
export type EntitlementUser = { badge_type?: string | null } | null | undefined;

/**
 * Flaxia+ is signalled by an active-subscription avatar badge. `badge_type` is
 * only set for active/trialing subscribers, matching `getUserPlan().isActive`.
 */
export function isPlusUser(user: EntitlementUser): boolean {
  return Boolean(user?.badge_type);
}

/** Attachment ceiling for a user: Flaxia+ gets the larger cap. */
export function maxMediaAttachmentsForUser(user: EntitlementUser): number {
  return isPlusUser(user) ? MAX_MEDIA_ATTACHMENTS_PLUS : MAX_MEDIA_ATTACHMENTS;
}
