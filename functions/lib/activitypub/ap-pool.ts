/** Federated popularity pool: public posts from known instances, SSRF-safe. */
import { freshnessBoost } from '../scoring.ts';
import { checkUrlForSsrf } from '../url-guard.ts';
import { PUBLIC_COLLECTION } from './context.ts';
import {
  type FederationEnv,
  fetchActivityPubJson,
  fetchFederationDocument,
  isPrivatePeerAllowed,
  normalizeActorSummary,
} from './fetch.ts';
import { htmlToText } from './text.ts';
export const POOL_JOIN_SQL = 'LEFT JOIN ap_pool_metrics pm ON pm.post_id = p.id';
export const POOL_SCORE_SQL = 'COALESCE(pm.score, 0)';
export interface PoolEnv extends FederationEnv {
  DB: D1Database;
  AP_POOL_SEED_DOMAINS?: string;
}
type PoolResult = { instances: number; fetched: number; stored: number; skipped: number; errors: number };
type PoolMetrics = {
  favourites: number;
  reblogs: number;
  score: number;
  flaxiaFresh: number;
  flaxiaReload: number;
};
export type PoolActorInfo = {
  actorUrl: string;
  domain: string;
  username?: string;
  displayName?: string | null;
  iconUrl?: string | null;
};
type PoolOptions = { maxInstances?: number; maxPostsPerInstance?: number; maxTotal?: number };
const SEED_DOMAINS = ['mastodon.social', 'mastodon.online', 'fosstodon.org', 'tech.lgbt'];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_POSTS_PER_ACTOR = 5;
const TIMELINE_LIMIT = 40;
/** Remote clocks may run a few minutes ahead; anything further is not a fresh post. */
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
const safeCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const records: Record<string, unknown>[] = [];
  for (const entry of value) {
    const record = recordOf(entry);
    if (record) records.push(record);
  }
  return records;
}
function urlOf(value: unknown): URL | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}
const canonical = (u: URL): string => new URL(u.toString().split('#')[0]).toString().replace(/\/$/, '');
const sameHost = (url: URL, domain: string): boolean =>
  url.hostname.toLowerCase().replace(/\.$/, '') === domain.split(':')[0].toLowerCase().replace(/\.$/, '');
function firstString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value) return value;
  return null;
}
const randomPostId = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 10);
/** Freshness reuses the local ranking boost; local activity adds popularity. */
export function computePoolScore(params: {
  favourites: number;
  reblogs: number;
  createdAt: string;
  flaxiaFresh: number;
  flaxiaReload: number;
}): number {
  return (
    1.0 * Math.log1p(safeCount(params.favourites)) +
    2.0 * Math.log1p(safeCount(params.reblogs)) +
    1.5 * freshnessBoost(params.createdAt) +
    2.0 * Math.log1p(safeCount(params.flaxiaFresh) + safeCount(params.flaxiaReload))
  );
}
/** Recompute at refresh time so the freshness term decays with the clock. */
function currentScore(metrics: PoolMetrics, createdAt: string): number {
  return computePoolScore({
    favourites: metrics.favourites,
    reblogs: metrics.reblogs,
    createdAt,
    flaxiaFresh: metrics.flaxiaFresh,
    flaxiaReload: metrics.flaxiaReload,
  });
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
  const flaxiaFresh = safeCount(status.flaxia_fresh ?? status.flaxia_fresh_count ?? status.fresh_count);
  const flaxiaReload = safeCount(status.flaxia_reload ?? status.flaxia_reload_count ?? status.reload_count);
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
      flaxiaFresh,
      flaxiaReload,
      score: computePoolScore({ favourites, reblogs, createdAt, flaxiaFresh, flaxiaReload }),
    },
  };
}
/** Normalize a domain from the actor table or the operator seed list. */
function poolDomain(raw: unknown, env: FederationEnv): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!value || value.length > 253 || value.includes('..') || !/^[a-z0-9.-]+(?::\d{1,5})?$/.test(value)) return null;
  try {
    const url = new URL(`https://${value}`);
    if (url.origin !== `https://${value}`) return null;
    return !isPrivatePeerAllowed(env, url.hostname) && checkUrlForSsrf(url) ? null : value;
  } catch {
    return null;
  }
}
function instanceOrigins(env: FederationEnv, domain: string): string[] {
  const origins = [`https://${domain}`];
  if (isPrivatePeerAllowed(env, domain.split(':')[0])) origins.unshift(`http://${domain}`);
  return origins;
}
async function fetchInstanceJson(fed: FederationEnv, domain: string, path: string, accept = 'application/json') {
  for (const origin of instanceOrigins(fed, domain)) {
    const response = await fetchFederationDocument(`${origin}${path}`, fed, {
      headers: { Accept: accept },
      timeoutMs: 8000,
    });
    if (!response?.ok) continue;
    try {
      return (await response.json()) as unknown;
    } catch {
      // Try the next origin.
    }
  }
  return null;
}
async function discoverInstances(env: PoolEnv, max: number): Promise<string[]> {
  const domains = new Set<string>();
  try {
    const rows = await env.DB.prepare('SELECT DISTINCT domain FROM ap_actors WHERE domain IS NOT NULL').all<{
      domain: string | null;
    }>();
    for (const row of rows.results ?? []) {
      const domain = poolDomain(row.domain, env);
      if (domain) domains.add(domain);
    }
  } catch (error) {
    console.error('Could not read pool seed domains:', (error as Error).message);
  }
  const configured = env.AP_POOL_SEED_DOMAINS;
  for (const seed of configured?.trim() ? configured.split(',') : SEED_DOMAINS) {
    const domain = poolDomain(seed, env);
    if (domain) domains.add(domain);
  }
  return [...domains].slice(0, max);
}
/** Most-used local hashtags of the last day; json_each ignores malformed rows. */
async function localTrendingHashtags(db: D1Database): Promise<string[]> {
  try {
    const rows = await db
      .prepare(`SELECT value AS tag, COUNT(*) AS uses FROM posts, json_each(posts.hashtags)
        WHERE created_at >= ? AND json_valid(hashtags) GROUP BY value ORDER BY uses DESC, tag LIMIT 5`)
      .bind(new Date(Date.now() - DAY_MS).toISOString())
      .all<{ tag: string }>();
    return (rows.results ?? []).map((row) => row.tag.replace(/^#/, '').trim().slice(0, 50)).filter(Boolean);
  } catch {
    return [];
  }
}
interface PoolActor extends PoolActorInfo {
  inboxUrl: string;
  summary: string | null;
}
interface DiscoveredStatus {
  status: Record<string, unknown>;
  actor: PoolActor;
}
/** Resolve an author from the status, our actor cache, or WebFinger on the instance. */
async function resolvePoolActor(
  env: PoolEnv,
  domain: string,
  acct: string,
  account: Record<string, unknown> | null,
  cache: Map<string, PoolActor>,
): Promise<PoolActor | null> {
  const username = acct.split('@')[0];
  if (!/^[A-Za-z0-9_]{1,30}$/.test(username)) return null;
  const key = `${domain}:${username.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached) return cached;
  let actorUrl: URL | null = urlOf(account?.url);
  let inboxUrl: string | null = null;
  if (actorUrl && !sameHost(actorUrl, domain)) actorUrl = null;
  if (!actorUrl) {
    const row = await env.DB.prepare(
      'SELECT actor_url, inbox_url FROM ap_actors WHERE domain = ? AND preferred_username = ? ORDER BY fetched_at DESC LIMIT 1',
    )
      .bind(domain, username)
      .first<{ actor_url: string | null; inbox_url: string | null }>();
    actorUrl = urlOf(row?.actor_url);
    if (actorUrl && sameHost(actorUrl, domain)) inboxUrl = urlOf(row?.inbox_url)?.toString() ?? null;
    else actorUrl = null;
  }
  if (!actorUrl) {
    const document = recordOf(
      await fetchInstanceJson(
        env,
        domain,
        `/.well-known/webfinger?resource=${encodeURIComponent(`acct:${username}@${domain}`)}`,
        'application/jrd+json, application/json',
      ),
    );
    const self = asRecords(document?.links).find(
      (link) => link.rel === 'self' && String(link.type).includes('activity+json'),
    );
    actorUrl = urlOf(self?.href);
    if (actorUrl && !sameHost(actorUrl, domain)) actorUrl = null;
  }
  if (!actorUrl) return null;
  if (!inboxUrl) {
    const document = await fetchActivityPubJson(actorUrl.toString(), env, { sameOrigin: true, timeoutMs: 8000 });
    const documentId = urlOf(document?.id);
    if (documentId && canonical(documentId) !== canonical(actorUrl)) return null;
    inboxUrl = urlOf(document?.inbox)?.toString() ?? null;
    if (inboxUrl && !sameHost(new URL(inboxUrl), domain)) inboxUrl = null;
  }
  const actor: PoolActor = {
    actorUrl: canonical(actorUrl),
    domain,
    username: `${username}@${domain}`,
    displayName: typeof account?.display_name === 'string' ? account.display_name : null,
    iconUrl: urlOf(account?.avatar)?.toString() ?? null,
    summary: normalizeActorSummary(account?.note),
    inboxUrl: inboxUrl ?? `${canonical(actorUrl)}/inbox`,
  };
  cache.set(key, actor);
  return actor;
}
async function upsertPoolActor(db: D1Database, actor: PoolActor): Promise<void> {
  await db
    .prepare(`INSERT INTO ap_actors (actor_url, inbox_url, shared_inbox_url, public_key_pem, preferred_username,
      display_name, icon_url, domain, summary, fetched_at)
      VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(actor_url) DO UPDATE SET
        preferred_username = COALESCE(ap_actors.preferred_username, excluded.preferred_username),
        display_name = COALESCE(ap_actors.display_name, excluded.display_name),
        icon_url = COALESCE(ap_actors.icon_url, excluded.icon_url),
        domain = COALESCE(ap_actors.domain, excluded.domain),
        summary = COALESCE(ap_actors.summary, excluded.summary),
        inbox_url = COALESCE(ap_actors.inbox_url, excluded.inbox_url)`)
    .bind(
      actor.actorUrl,
      actor.inboxUrl,
      (actor.username ?? 'unknown').split('@')[0],
      actor.displayName,
      actor.iconUrl,
      actor.domain,
      actor.summary,
    )
    .run();
}
async function isMastodon(env: PoolEnv, domain: string): Promise<boolean> {
  const document = recordOf(await fetchInstanceJson(env, domain, '/.well-known/nodeinfo'));
  const link = asRecords(document?.links).find((e) => `${e.rel ?? ''} ${e.href ?? ''}`.includes('nodeinfo/2.1'));
  const href = urlOf(link?.href);
  if (!href || !sameHost(href, domain) || checkUrlForSsrf(href)) return false;
  const info = recordOf(await fetchInstanceJson(env, domain, href.pathname + href.search));
  const software = recordOf(info?.software);
  return typeof software?.name === 'string' && software.name.toLowerCase().includes('mastodon');
}
async function fetchMastodonStatuses(env: PoolEnv, domain: string, cache: Map<string, PoolActor>, cap: number) {
  const pages: unknown[] = [await fetchInstanceJson(env, domain, `/api/v1/trends/statuses?limit=${TIMELINE_LIMIT}`)];
  if (pages[0] !== null) {
    for (const tag of await localTrendingHashtags(env.DB)) {
      if (pages.length > 5) break;
      pages.push(
        await fetchInstanceJson(
          env,
          domain,
          `/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=${TIMELINE_LIMIT}`,
        ),
      );
    }
  }
  const statuses: DiscoveredStatus[] = [];
  let skipped = 0;
  for (const page of pages) {
    for (const raw of asRecords(page)) {
      if (statuses.length >= cap) break;
      const account = recordOf(raw.account);
      const actor = await resolvePoolActor(env, domain, firstString(account?.acct) ?? '', account, cache);
      if (actor) statuses.push({ status: raw, actor });
      else skipped++;
    }
  }
  return { statuses, skipped };
}
/** Non-Mastodon instances: one page of a known actor's outbox. */
async function fetchOutboxStatuses(env: PoolEnv, domain: string, cache: Map<string, PoolActor>, cap: number) {
  const statuses: DiscoveredStatus[] = [];
  const row = await env.DB.prepare(
    `SELECT actor_url, inbox_url, preferred_username, display_name, icon_url, summary
     FROM ap_actors WHERE domain = ? ORDER BY fetched_at DESC LIMIT 1`,
  )
    .bind(domain)
    .first<{
      actor_url: string | null;
      inbox_url: string | null;
      preferred_username: string | null;
      display_name: string | null;
      icon_url: string | null;
      summary: string | null;
    }>();
  const known = urlOf(row?.actor_url);
  if (!row || !known || !sameHost(known, domain)) return { statuses, skipped: 0 };
  const actor: PoolActor = {
    actorUrl: canonical(known),
    domain,
    username: `${row.preferred_username ?? 'unknown'}@${domain}`,
    displayName: row.display_name,
    iconUrl: urlOf(row.icon_url)?.toString() ?? null,
    summary: row.summary,
    inboxUrl: urlOf(row.inbox_url)?.toString() ?? `${canonical(known)}/inbox`,
  };
  cache.set(`${domain}:${(row.preferred_username ?? 'unknown').toLowerCase()}`, actor);
  const actorDoc = await fetchActivityPubJson(actor.actorUrl, env, { sameOrigin: true, timeoutMs: 8000 });
  const outbox = urlOf(actorDoc?.outbox) ?? new URL(`${actor.actorUrl}/outbox`);
  if (!sameHost(outbox, domain)) return { statuses, skipped: 0 };
  let collection = await fetchActivityPubJson(outbox.toString(), env, { timeoutMs: 8000 });
  let items: unknown = collection?.orderedItems ?? collection?.items;
  if (!Array.isArray(items)) {
    const first = collection?.first;
    const firstUrl = urlOf(first) ?? urlOf(recordOf(first)?.id) ?? urlOf(recordOf(first)?.href);
    if (firstUrl && sameHost(firstUrl, domain)) {
      collection = await fetchActivityPubJson(firstUrl.toString(), env, { timeoutMs: 8000 });
      items = collection?.orderedItems ?? collection?.items;
    }
  }
  let skipped = 0;
  for (const entry of asRecords(items)) {
    if (statuses.length >= cap) break;
    const note = recordOf(entry.object) ?? entry;
    if (note.type !== 'Note') continue;
    const audience = (value: unknown): string[] =>
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === 'string')
          : [];
    const to = audience(note.to);
    const cc = audience(note.cc);
    // `cc`-only PUBLIC is an unlisted Note: normalizeMastodonStatus rejects it.
    const visibility = to.includes(PUBLIC_COLLECTION)
      ? 'public'
      : cc.includes(PUBLIC_COLLECTION)
        ? 'unlisted'
        : 'private';
    const attributedTo = urlOf(note.attributedTo);
    if (visibility === 'private' || canonical(attributedTo ?? known) !== actor.actorUrl) {
      skipped++;
      continue;
    }
    statuses.push({
      actor,
      status: {
        id: note.id,
        url: note.url ?? note.id,
        content: note.content,
        created_at: note.published,
        visibility,
        sensitive: note.sensitive === true,
        attributedTo: attributedTo?.toString(),
        account: { url: actor.actorUrl, acct: row.preferred_username ?? 'unknown' },
        tags: asRecords(note.tag).map((tag) => ({ name: tag.name })),
        favourites_count: 0,
        reblogs_count: 0,
      },
    });
  }
  return { statuses, skipped };
}
/** Store one status, or refresh an existing pool row. Inbox posts are left alone. */
async function storeDiscoveredStatus(env: PoolEnv, entry: DiscoveredStatus, instance: string, baseUrl: string) {
  const normalized = normalizeMastodonStatus(entry.status, entry.actor, baseUrl);
  if (!normalized) return false;
  const objectId = normalized.post.ap_object_id as string;
  const blocked = await env.DB.prepare('SELECT 1 AS blocked FROM ap_blocks WHERE actor_url = ? LIMIT 1')
    .bind(entry.actor.actorUrl)
    .first();
  if (blocked) return false;
  const existing = await env.DB.prepare('SELECT id FROM posts WHERE ap_object_id = ?')
    .bind(objectId)
    .first<{ id: string }>();
  // The score depends on the current clock: recompute it on every discovery,
  // otherwise a viral post keeps its original boost and never decays.
  const score = currentScore(normalized.metrics, String(normalized.post.created_at));
  const fetchedAt = new Date(Date.now()).toISOString();
  if (existing) {
    // A Note received through the inbox has no pool metrics: it belongs to a
    // followed actor's timeline, not to public discovery. Only rows the pool
    // created (marked by a metrics row) are refreshed.
    const poolRow = await env.DB.prepare('SELECT post_id FROM ap_pool_metrics WHERE post_id = ?')
      .bind(existing.id)
      .first();
    if (!poolRow) return false;
    await upsertPoolActor(env.DB, entry.actor);
    await env.DB.prepare(`UPDATE ap_pool_metrics SET instance = ?, favourites = ?, reblogs = ?,
      score = ?, fetched_at = ? WHERE post_id = ?`)
      .bind(instance, normalized.metrics.favourites, normalized.metrics.reblogs, score, fetchedAt, existing.id)
      .run();
    return true;
  }
  await upsertPoolActor(env.DB, entry.actor);
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO posts
    (id, user_id, username, text, hashtags, status, hidden, actor_id, ap_object_id, visibility, created_at)
    VALUES (?, '', ?, ?, ?, 'published', ?, ?, ?, 'public', ?)`)
    .bind(
      normalized.post.id,
      normalized.post.username,
      normalized.post.text,
      normalized.post.hashtags,
      normalized.post.hidden,
      normalized.post.actor_id,
      objectId,
      normalized.post.created_at,
    )
    .run();
  if ((inserted.meta?.changes ?? 0) === 0) return false;
  await env.DB.prepare(`INSERT INTO ap_pool_metrics (post_id, instance, favourites, reblogs, score, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_id) DO UPDATE SET instance = excluded.instance, favourites = excluded.favourites,
      reblogs = excluded.reblogs, score = excluded.score, fetched_at = excluded.fetched_at`)
    .bind(normalized.post.id, instance, normalized.metrics.favourites, normalized.metrics.reblogs, score, fetchedAt)
    .run();
  return true;
}
/** Sample public posts from known instances and refresh their scores. */
export async function runPoolDiscovery(env: PoolEnv, options: PoolOptions = {}): Promise<PoolResult> {
  const maxInstances = Math.max(0, options.maxInstances ?? 20);
  const maxPostsPerInstance = Math.max(0, options.maxPostsPerInstance ?? TIMELINE_LIMIT);
  const maxTotal = Math.max(0, options.maxTotal ?? 500);
  const result: PoolResult = { instances: 0, fetched: 0, stored: 0, skipped: 0, errors: 0 };
  if (!maxInstances || !maxPostsPerInstance || !maxTotal) return result;
  const actors = new Map<string, PoolActor>();
  const perActor = new Map<string, number>();
  const baseUrl = env.BASE_URL ?? 'https://flaxia.app';
  for (const domain of await discoverInstances(env, maxInstances)) {
    if (result.stored >= maxTotal) break;
    result.instances++;
    const cap = Math.min(maxPostsPerInstance, maxTotal - result.stored);
    try {
      const discovered = (await isMastodon(env, domain))
        ? await fetchMastodonStatuses(env, domain, actors, cap)
        : await fetchOutboxStatuses(env, domain, actors, cap);
      result.fetched += discovered.statuses.length;
      result.skipped += discovered.skipped;
      let perInstance = 0;
      for (const entry of discovered.statuses) {
        const count = perActor.get(entry.actor.actorUrl) ?? 0;
        if (perInstance >= cap || result.stored >= maxTotal || count >= MAX_POSTS_PER_ACTOR) {
          result.skipped++;
          continue;
        }
        try {
          if (await storeDiscoveredStatus(env, entry, domain, baseUrl)) {
            result.stored++;
            perInstance++;
            perActor.set(entry.actor.actorUrl, count + 1);
          } else result.skipped++;
        } catch (error) {
          console.error(`Could not store a pool post from ${domain}:`, (error as Error).message);
          result.errors++;
        }
      }
    } catch (error) {
      console.error(`Pool discovery failed for ${domain}:`, (error as Error).message);
      result.errors++;
    }
  }
  return result;
}
/** Remove old pool rows and their counters; local posts are never eligible. */
export async function prunePool(env: PoolEnv, olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * DAY_MS).toISOString();
  await env.DB.prepare('DELETE FROM ap_pool_metrics WHERE post_id NOT IN (SELECT id FROM posts)').run();
  // Only rows the pool created are eligible. Notes received from actors a
  // local user follows (and any local replies to them) are not pool content,
  // even though they look remote in the posts table.
  const stalePoolPost = `ap_object_id IS NOT NULL AND user_id = '' AND created_at < ?
    AND EXISTS (SELECT 1 FROM ap_pool_metrics pm WHERE pm.post_id = posts.id)`;
  // Capture the ids before deleting metrics: the marker itself lives there.
  const stale = await env.DB.prepare(`SELECT posts.id FROM posts WHERE ${stalePoolPost}`)
    .bind(cutoff)
    .all<{ id: string }>();
  const ids = (stale.results ?? []).map((row) => row.id);
  if (ids.length === 0) return 0;
  // A single JSON bind avoids D1's bind-parameter limit on a large prune.
  const idList = JSON.stringify(ids);
  const metrics = await env.DB.prepare('DELETE FROM ap_pool_metrics WHERE post_id IN (SELECT value FROM json_each(?))')
    .bind(idList)
    .run();
  const posts = await env.DB.prepare('DELETE FROM posts WHERE id IN (SELECT value FROM json_each(?))')
    .bind(idList)
    .run();
  return (metrics.meta?.changes ?? 0) + (posts.meta?.changes ?? 0);
}
