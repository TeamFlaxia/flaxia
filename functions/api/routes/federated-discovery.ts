/** Bounded on-demand popularity discovery for an empty federated feed. */
import { type PoolEnv, type PoolResult, runPoolDiscovery } from '../../lib/activitypub/ap-pool.ts';
import type { Bindings } from '../types.ts';

/** One lock for all viewers: an empty first page must not stampede the peers. */
export const ONDEMAND_LOCK_KEY = 'ap:pool:ondemand';
const LOCK_TTL_MS = 5 * 60 * 1000;

export type DiscoveryOptions = {
  maxInstances: number;
  maxPostsPerInstance: number;
  maxTotal: number;
  /** Empty-pool cold start must not spend the hourly worker's refresh budget. */
  maxRefreshes: number;
};

/** A short, seed-sized run; the hourly worker still owns the full refresh. */
export const ONDEMAND_OPTIONS: DiscoveryOptions = {
  maxInstances: 4,
  maxPostsPerInstance: 40,
  maxTotal: 500,
  maxRefreshes: 0,
};

type Runner = (env: Bindings, options: DiscoveryOptions) => Promise<PoolResult>;
type Delegate = (env: PoolEnv, options: DiscoveryOptions) => Promise<PoolResult>;

function toPoolEnv(env: Bindings): PoolEnv {
  const { DB, CACHE, BASE_URL, ENVIRONMENT } = env;
  const extras = env as Bindings & {
    AP_POOL_SEED_DOMAINS?: string;
    AP_ALLOWED_PRIVATE_PEERS?: string;
  };
  return {
    DB: DB as unknown as PoolEnv['DB'],
    CACHE: CACHE as PoolEnv['CACHE'],
    BASE_URL,
    ENVIRONMENT,
    AP_POOL_SEED_DOMAINS: extras.AP_POOL_SEED_DOMAINS,
    AP_ALLOWED_PRIVATE_PEERS: extras.AP_ALLOWED_PRIVATE_PEERS,
  };
}

/** The single injectable seam between the feed route and the AP pool. */
export async function runDiscoveryForRequest(
  env: Bindings,
  options: DiscoveryOptions = ONDEMAND_OPTIONS,
  delegate: Delegate = runPoolDiscovery,
): Promise<PoolResult> {
  return delegate(toPoolEnv(env), options);
}

/**
 * Acquire the lock atomically. KV cannot do this: it is eventually consistent,
 * so two cold requests can both see "unlocked" and both hammer the peers.
 * The D1 primary key makes exactly one INSERT OR IGNORE win; expired rows are
 * reclaimed first. Returns the owner token, or null when another run holds it.
 */
async function acquireLock(db: Bindings['DB'], now: number): Promise<string | null> {
  const owner = crypto.randomUUID();
  await db
    .prepare('DELETE FROM ap_discovery_locks WHERE key = ? AND expires_at <= ?')
    .bind(ONDEMAND_LOCK_KEY, now)
    .run();
  const result = await db
    .prepare('INSERT OR IGNORE INTO ap_discovery_locks (key, owner, expires_at) VALUES (?, ?, ?)')
    .bind(ONDEMAND_LOCK_KEY, owner, now + LOCK_TTL_MS)
    .run();
  return (result.meta?.changes ?? 0) > 0 ? owner : null;
}

/**
 * Run one rate-limited discovery attempt. Returns true only when this caller
 * acquired the lock and the run finished; the route then re-queries the feed.
 * A dry run keeps the lock until its TTL so a failing peer is not retried on
 * every request. Lock and discovery failures are logged and swallowed so an
 * empty tab stays a valid empty tab rather than a 500.
 */
export async function discoverForEmptyFeed(env: Bindings, runner: Runner = runDiscoveryForRequest): Promise<boolean> {
  const now = Date.now();
  let owner: string | null;
  try {
    owner = await acquireLock(env.DB, now);
  } catch (error) {
    // A missing/unavailable lock table must fail closed: never stampede peers.
    console.error('Federated on-demand lock failed:', (error as Error).message);
    return false;
  }
  if (!owner) return false;

  let result: PoolResult;
  try {
    result = await runner(env, ONDEMAND_OPTIONS);
  } catch (error) {
    console.error('Federated on-demand discovery failed:', (error as Error).message);
    return false;
  }
  console.log('Federated on-demand discovery:', JSON.stringify(result));

  if (result.stored > 0) {
    try {
      await env.DB.prepare('DELETE FROM ap_discovery_locks WHERE key = ? AND owner = ?')
        .bind(ONDEMAND_LOCK_KEY, owner)
        .run();
    } catch (error) {
      console.error('Federated on-demand lock release failed:', (error as Error).message);
    }
  }
  return true;
}
