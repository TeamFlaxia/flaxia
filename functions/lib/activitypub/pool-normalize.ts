import { freshnessBoost } from '../scoring.ts';
import { htmlToText } from './text.ts';

type PoolMetrics = {
  favourites: number;
  reblogs: number;
  score: number;
};
export type PoolActorInfo = {
  actorUrl: string;
  domain: string;
  username?: string;
  displayName?: string | null;
  iconUrl?: string | null;
};
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
const safeCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
export function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
export function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const records: Record<string, unknown>[] = [];
  for (const entry of value) {
    const record = recordOf(entry);
    if (record) records.push(record);
  }
  return records;
}
export function urlOf(value: unknown): URL | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}
export const canonical = (u: URL): string => new URL(u.toString().split('#')[0]).toString().replace(/\/$/, '');
export const sameHost = (url: URL, domain: string): boolean =>
  url.hostname.toLowerCase().replace(/\.$/, '') === domain.split(':')[0].toLowerCase().replace(/\.$/, '');
export function firstString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value) return value;
  return null;
}
const randomPostId = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 10);
/**
 * Freshness reuses the local ranking boost; popularity comes from the likes
 * and reposts a Mastodon REST status actually exposes. Flaxia-specific
 * "fresh"/"reload" counters are not part of those responses, so a term based
 * on them would always score zero and can only make the formula misleading.
 */
export function computePoolScore(params: { favourites: number; reblogs: number; createdAt: string }): number {
  return (
    1.0 * Math.log1p(safeCount(params.favourites)) +
    2.0 * Math.log1p(safeCount(params.reblogs)) +
    1.5 * freshnessBoost(params.createdAt)
  );
}
/** Recompute at refresh time so the freshness term decays with the clock. */
export function currentScore(metrics: PoolMetrics, createdAt: string): number {
  return computePoolScore({ favourites: metrics.favourites, reblogs: metrics.reblogs, createdAt });
}
/** Plain-text post and counters; boosts and non-public posts are rejected. */
export function normalizeMastodonStatus(
  status: Record<string, unknown>,
  actor: PoolActorInfo,
  baseUrl: string,
): { post: Record<string, unknown>; metrics: PoolMetrics } | null {
  if (!recordOf(status) || (status.reblog !== undefined && status.reblog !== null)) return null;
  const visibility = typeof status.visibility === 'string' ? status.visibility.toLowerCase() : 'public';
  // Unlisted posts reach followers and mentions, not public timelines. The
  // Federated pool is public discovery, so they must not be imported at all.
  if (visibility !== 'public') return null;
  const actorUrl = urlOf(actor.actorUrl);
  const accountUrl = urlOf(recordOf(status.account)?.url);
  const attributedTo = urlOf(status.attributedTo);
  if (!actorUrl || !sameHost(actorUrl, actor.domain)) return null;
  // At least one attribution must be present and name the resolved actor.
  if (!accountUrl && !attributedTo) return null;
  if (accountUrl && canonical(accountUrl) !== canonical(actorUrl)) return null;
  if (attributedTo && canonical(attributedTo) !== canonical(actorUrl)) return null;
  // Mastodon REST ids are often numeric, while inbox delivery uses the AP id
  // `${actor}/statuses/${id}`. Resolve both to that same identity so a Delete
  // of the Note hides one row instead of leaving a second public pool copy.
  const numericId = typeof status.id === 'string' && /^\d{1,20}$/.test(status.id) ? status.id : null;
  const declaredId = urlOf(status.uri);
  const objectId =
    urlOf(status.id) ??
    (declaredId && sameHost(declaredId, actor.domain) ? declaredId : null) ??
    (numericId ? urlOf(`${canonical(actorUrl)}/statuses/${numericId}`) : null) ??
    urlOf(status.url);
  if (!objectId || !sameHost(objectId, actor.domain)) return null;
  try {
    if (new URL(baseUrl).origin === objectId.origin) return null;
  } catch {}
  const text = htmlToText(firstString(status.content, status.text) ?? '').slice(0, 200);
  const createdAt = firstString(status.created_at, status.published);
  const timestamp = createdAt ? new Date(createdAt).getTime() : Number.NaN;
  if (!text || !createdAt || !Number.isFinite(timestamp) || timestamp > Date.now() + MAX_CLOCK_SKEW_MS) return null;
  const hashtags: string[] = [];
  for (const tag of asRecords(status.tags)) {
    const name = firstString(tag.name)?.replace(/^#/, '').trim().slice(0, 50);
    if (name && !hashtags.includes(name)) hashtags.push(name);
  }
  const favourites = safeCount(status.favourites_count ?? status.favourites);
  const reblogs = safeCount(status.reblogs_count ?? status.reblogs);
  return {
    post: {
      id: randomPostId(),
      user_id: '',
      username: actor.username?.trim() || `${actorUrl.pathname.split('/').filter(Boolean).pop()}@${actor.domain}`,
      text,
      hashtags: JSON.stringify(hashtags),
      status: 'published',
      hidden: status.sensitive === true ? 1 : 0,
      actor_id: canonical(actorUrl),
      ap_object_id: objectId.toString(),
      visibility: 'public',
      created_at: createdAt,
    },
    metrics: {
      favourites,
      reblogs,
      score: computePoolScore({ favourites, reblogs, createdAt }),
    },
  };
}
