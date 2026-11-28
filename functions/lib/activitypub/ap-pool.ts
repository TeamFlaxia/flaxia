/** Federated popularity pool: public posts from known instances, SSRF-safe. */
import type { Db } from '../ports/index.ts';
import { checkUrlForSsrf } from '../url-guard.ts';
import { audienceEntries, isPublicAddress } from './context.ts';
import {
  type FederationEnv,
  fetchActivityPubJson,
  fetchFederationDocument,
  isPrivatePeerAllowed,
  normalizeActorSummary,
} from './fetch.ts';
import {
  asRecords,
  canonical,
  currentScore,
  firstString,
  normalizeMastodonStatus,
  type PoolActorInfo,
  recordOf,
  sameHost,
  urlOf,
} from './pool-normalize.ts';
import { prunePool } from './pool-prune.ts';

export type { PoolActorInfo } from './pool-normalize.ts';
export { computePoolScore, normalizeMastodonStatus } from './pool-normalize.ts';
export { prunePool } from './pool-prune.ts';
export const POOL_JOIN_SQL = 'LEFT JOIN ap_pool_metrics pm ON pm.post_id = p.id';
export const POOL_SCORE_SQL = 'COALESCE(pm.score, 0)';
export interface PoolEnv extends FederationEnv {
  DB: Db;
  AP_POOL_SEED_DOMAINS?: string;
}
export type PoolResult = {
  instances: number;
  fetched: number;
  /** Insertions plus refreshes; kept for the cron log and existing callers. */
  stored: number;
  /** How many of `stored` were brand-new pool rows. Insert budget counts these. */
  inserted: number;
  /** How many of `stored` were refreshes of an existing pool row. */
  refreshed: number;
  skipped: number;
  errors: number;
};
type PoolOptions = {
  maxInstances?: number;
  maxPostsPerInstance?: number;
  maxTotal?: number;
  maxRefreshes?: number;
};
const SEED_DOMAINS = ['mastodon.social', 'mastodon.online', 'fosstodon.org', 'tech.lgbt'];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_POSTS_PER_ACTOR = 5;
const TIMELINE_LIMIT = 40;
/** Refreshing scores must not crowd out new discoveries, but still be bounded. */
const MAX_REFRESHES_PER_RUN = 500;
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
async function localTrendingHashtags(db: Db): Promise<string[]> {
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
/** Failed resolutions are cached too, so one broken actor is fetched at most once per run. */
type ActorCache = Map<string, PoolActor | null>;
/** Resolve an author from the status, our actor cache, or WebFinger on the instance. */
async function resolvePoolActor(
  env: PoolEnv,
  domain: string,
  acct: string,
  account: Record<string, unknown> | null,
  cache: ActorCache,
): Promise<PoolActor | null> {
  const username = acct.split('@')[0];
  const key = `${domain}:${username.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const fail = (): null => {
    cache.set(key, null);
    return null;
  };
  if (!/^[A-Za-z0-9_]{1,30}$/.test(username)) return fail();
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
  if (!actorUrl) return fail();
  if (!inboxUrl) {
    const document = await fetchActivityPubJson(actorUrl.toString(), env, { sameOrigin: true, timeoutMs: 8000 });
    const documentId = urlOf(document?.id);
    if (documentId && canonical(documentId) !== canonical(actorUrl)) return fail();
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
async function upsertPoolActor(db: Db, actor: PoolActor): Promise<void> {
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
  // Mastodon instances may advertise only schema 2.0 (e.g. mastodon.social),
  // so accept either version before falling back to the outbox.
  const link = asRecords(document?.links).find((e) => {
    const candidate = `${e.rel ?? ''} ${e.href ?? ''}`;
    return candidate.includes('nodeinfo/2.1') || candidate.includes('nodeinfo/2.0');
  });
  const href = urlOf(link?.href);
  if (!href || !sameHost(href, domain) || checkUrlForSsrf(href)) return false;
  const info = recordOf(await fetchInstanceJson(env, domain, href.pathname + href.search));
  const software = recordOf(info?.software);
  return typeof software?.name === 'string' && software.name.toLowerCase().includes('mastodon');
}
async function fetchMastodonStatuses(env: PoolEnv, domain: string, cache: ActorCache, cap: number) {
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
async function fetchOutboxStatuses(env: PoolEnv, domain: string, cache: ActorCache, cap: number) {
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
    const to = audienceEntries(note.to);
    const cc = audienceEntries(note.cc);
    // `cc`-only PUBLIC is an unlisted Note: normalizeMastodonStatus rejects it.
    const visibility = to.some(isPublicAddress) ? 'public' : cc.some(isPublicAddress) ? 'unlisted' : 'private';
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
/** `'refreshed'` counts separately from a newly `'inserted'` pool row. */
type StoreOutcome = 'inserted' | 'refreshed' | null;
type StoreBudget = { canInsert: boolean; canRefresh: boolean };
/** Store one status, or refresh an existing pool row. Inbox posts are left alone. */
async function storeDiscoveredStatus(
  env: PoolEnv,
  entry: DiscoveredStatus,
  instance: string,
  baseUrl: string,
  budget: StoreBudget,
): Promise<StoreOutcome> {
  const normalized = normalizeMastodonStatus(entry.status, entry.actor, baseUrl);
  if (!normalized) return null;
  const objectId = normalized.post.ap_object_id as string;
  const blocked = await env.DB.prepare('SELECT 1 AS blocked FROM ap_blocks WHERE actor_url = ? LIMIT 1')
    .bind(entry.actor.actorUrl)
    .first();
  if (blocked) return null;
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
    if (!poolRow || !budget.canRefresh) return null;
    await upsertPoolActor(env.DB, entry.actor);
    await env.DB.prepare(`UPDATE ap_pool_metrics SET instance = ?, favourites = ?, reblogs = ?,
      score = ?, fetched_at = ? WHERE post_id = ?`)
      .bind(instance, normalized.metrics.favourites, normalized.metrics.reblogs, score, fetchedAt, existing.id)
      .run();
    return 'refreshed';
  }
  if (!budget.canInsert) return null;
  await upsertPoolActor(env.DB, entry.actor);
  // Both writes must land together. A public post with an ap_object_id but no
  // metrics row is invisible to the ranked feed and can never be pruned; D1's
  // batch is atomic, so a failing metrics insert rolls the post back too.
  const insertPost = env.DB.prepare(`INSERT OR IGNORE INTO posts
    (id, user_id, username, text, hashtags, status, hidden, actor_id, ap_object_id, visibility, created_at)
    VALUES (?, '', ?, ?, ?, 'published', ?, ?, ?, 'public', ?)`).bind(
    normalized.post.id,
    normalized.post.username,
    normalized.post.text,
    normalized.post.hashtags,
    normalized.post.hidden,
    normalized.post.actor_id,
    objectId,
    normalized.post.created_at,
  );
  // `changes()` reflects the INSERT OR IGNORE above inside the same batch. The
  // EXISTS guard also prevents metrics for a post that was ignored because its
  // id or ap_object_id already existed, without relying on batch-local state.
  const insertMetrics = env.DB.prepare(`INSERT INTO ap_pool_metrics
    (post_id, instance, favourites, reblogs, score, fetched_at)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE changes() > 0 AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND ap_object_id = ?)
    ON CONFLICT(post_id) DO UPDATE SET instance = excluded.instance, favourites = excluded.favourites,
      reblogs = excluded.reblogs, score = excluded.score, fetched_at = excluded.fetched_at`).bind(
    normalized.post.id,
    instance,
    normalized.metrics.favourites,
    normalized.metrics.reblogs,
    score,
    fetchedAt,
    normalized.post.id,
    objectId,
  );
  const [postWrite] = await env.DB.batch([insertPost, insertMetrics]);
  // INSERT OR IGNORE may be a no-op; then this is not a new pool row and must
  // not be counted as an insertion.
  const changes = (postWrite as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0;
  return changes > 0 ? 'inserted' : null;
}
/** Sample public posts from known instances and refresh their scores. */
export async function runPoolDiscovery(env: PoolEnv, options: PoolOptions = {}): Promise<PoolResult> {
  const maxInstances = Math.max(0, options.maxInstances ?? 20);
  const maxPostsPerInstance = Math.max(0, options.maxPostsPerInstance ?? TIMELINE_LIMIT);
  const maxTotal = Math.max(0, options.maxTotal ?? 500);
  const maxRefreshes = Math.max(0, options.maxRefreshes ?? MAX_REFRESHES_PER_RUN);
  const result: PoolResult = {
    instances: 0,
    fetched: 0,
    stored: 0,
    inserted: 0,
    refreshed: 0,
    skipped: 0,
    errors: 0,
  };
  if (!maxInstances || !maxPostsPerInstance || !maxTotal) return result;
  const actors: ActorCache = new Map();
  const perActor = new Map<string, number>();
  const baseUrl = env.BASE_URL ?? 'https://flaxia.app';
  for (const domain of await discoverInstances(env, maxInstances)) {
    const canInsert = result.inserted < maxTotal;
    const canRefresh = result.refreshed < maxRefreshes;
    if (!canInsert && !canRefresh) break;
    result.instances++;
    // Insertions and refreshes have separate budgets: refreshing 500 known
    // posts must not leave the run with no room for a single new discovery.
    const cap = Math.min(maxPostsPerInstance, maxTotal - result.inserted + maxRefreshes - result.refreshed);
    try {
      const discovered = (await isMastodon(env, domain))
        ? await fetchMastodonStatuses(env, domain, actors, cap)
        : await fetchOutboxStatuses(env, domain, actors, cap);
      result.fetched += discovered.statuses.length;
      result.skipped += discovered.skipped;
      let perInstance = 0;
      for (const entry of discovered.statuses) {
        const count = perActor.get(entry.actor.actorUrl) ?? 0;
        const budget = { canInsert: result.inserted < maxTotal, canRefresh: result.refreshed < maxRefreshes };
        if (perInstance >= cap || (!budget.canInsert && !budget.canRefresh) || count >= MAX_POSTS_PER_ACTOR) {
          result.skipped++;
          continue;
        }
        try {
          const outcome = await storeDiscoveredStatus(env, entry, domain, baseUrl, budget);
          if (outcome) {
            result.stored++;
            if (outcome === 'inserted') result.inserted++;
            else result.refreshed++;
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
