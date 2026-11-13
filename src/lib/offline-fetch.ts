import { logEvent } from './diagnostics.ts';
import type { OfflineStore } from './offline-store.ts';

const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const READ_TIMEOUT_MS = 8000;
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 20000, 30000];
const PROBE_TIMEOUT_MS = 15000;
// Stop background probing after this many consecutive failures so an
// offline episode cannot runaway-probe a server forever. An 'online'
// event or the timeline reload button resets the counter.
const MAX_PROBE_FAILURES = 20;

interface OfflineFetchOptions {
  store: OfflineStore;
  baseUrl: string;
  apiOrigin: string;
  isOnline: () => boolean;
  setOffline: (offline: boolean) => void;
  /**
   * A raw network request used to recover from a stale offline state. It must
   * bound its own duration; the offline layer also races it against a deadline.
   */
  probe?: () => Promise<boolean>;
  now?: () => number;
}

// Auth proofs, vault material, notifications, account settings, billing, and
// admin data are intentionally excluded. Posts/media are public by design.
export function isOfflineReadable(path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  return (
    decoded === '/api/me' ||
    decoded === '/api/posts' ||
    decoded === '/api/posts/recommended' ||
    /^\/api\/posts\/[^/]+(?:\/(?:replies|thread))?$/.test(decoded) ||
    decoded === '/api/games' ||
    decoded === '/api/tags/trending' ||
    /^\/api\/thumbnail\/[^/]+$/.test(decoded) ||
    /^\/api\/images\/(?!dm\/)[^?]+$/.test(decoded)
  );
}

/** A display identity only; never persist the rest of /me (email, settings…). */
function displayIdentity(
  data: unknown,
): { user: { id: string; username: string; [key: string]: string | null } } | null {
  if (!data || typeof data !== 'object' || !('user' in data)) return null;
  const user = data.user;
  if (!user || typeof user !== 'object' || !('id' in user) || !('username' in user)) return null;
  if (typeof user.id !== 'string' || typeof user.username !== 'string') return null;
  const result: { id: string; username: string; [key: string]: string | null } = {
    id: user.id,
    username: user.username,
  };
  for (const field of ['display_name', 'avatar_key', 'badge_type', 'name_color']) {
    const value = (user as Record<string, unknown>)[field];
    if (typeof value === 'string' || value === null) result[field] = value;
  }
  return { user: result };
}

/** Network first, with bounded persistent reads. Mutations are never replayed. */
export function createOfflineFetch(networkFetch: typeof fetch, options: OfflineFetchOptions): typeof fetch {
  const { store } = options;
  const now = options.now ?? Date.now;
  let owner = 'guest';
  let generation = 0;
  // navigator.onLine is only a hint: a false negative must not latch the app
  // offline. Any response that actually reaches the network sets this true.
  let reachable = false;
  let retryIndex = 0;
  let probeFailures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let probing = false;
  let connectivityEpoch = 0;
  let initialized: Promise<void> | undefined;
  const safely = async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await operation();
    } catch {
      return undefined;
    }
  };
  const initialize = () => {
    initialized ??= (async () => {
      const saved = await safely(() => store.get('identity'));
      if (!saved) return;
      const data = await safely(async () => displayIdentity(JSON.parse(await saved.body.text())));
      if (now() - saved.savedAt > MAX_AGE || !data) {
        await safely(() => store.clear());
        return;
      }
      owner = data.user.id;
    })();
    return initialized;
  };
  const reset = async () => {
    generation++;
    owner = 'guest';
    await safely(() => store.clear());
  };
  const clearRetry = () => {
    connectivityEpoch++;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    retryIndex = 0;
    probeFailures = 0;
  };
  const scheduleRetry = () => {
    if (!options.probe || retryTimer !== undefined || probing || probeFailures >= MAX_PROBE_FAILURES) return;
    const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void runProbe();
    }, delay);
  };
  const runProbe = async (): Promise<void> => {
    if (!options.probe || probing) return;
    probing = true;
    const epoch = connectivityEpoch;
    let reconnected = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      reconnected = await Promise.race([
        options.probe(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      reconnected = false;
    } finally {
      clearTimeout(timer);
      probing = false;
    }
    // A real request may have proven connectivity while the probe was in flight.
    if (epoch !== connectivityEpoch) return;
    if (reconnected) {
      reachable = true;
      clearRetry();
      logEvent('offline-fetch', 'probe_recovered');
      options.setOffline(false);
      return;
    }
    // A failed probe invalidates any earlier proof of reachability.
    reachable = false;
    retryIndex++;
    probeFailures++;
    logEvent('offline-fetch', 'probe_failed', { retryIndex, probeFailures });
    options.setOffline(true);
    scheduleRetry();
  };
  if (!options.isOnline()) scheduleRetry();
  const retryNow = () => {
    if (!options.probe) return;
    // An explicit retry (online event or reload) should let the next request
    // try the network even while another probe is still in flight. A failed
    // probe clears this again.
    reachable = true;
    if (probing) return;
    clearRetry();
    void runProbe();
  };
  if (typeof window !== 'undefined') {
    // Keep retrying even when the app is idle or the browser reports a false
    // negative. A successful probe is the only thing that trusts the network.
    window.addEventListener('offline', () => {
      // The browser's offline signal is positive evidence, so honour it for
      // reads; auth requests still bypass it and the probe can recover.
      reachable = false;
      scheduleRetry();
    });
    window.addEventListener('online', retryNow);
    // The timeline reload button requests an immediate probe. runProbe ignores
    // the call while another probe is pending.
    window.addEventListener('flaxiaRetryConnectivity', retryNow);
  }
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString(), options.baseUrl);
    const appUrl = new URL(options.baseUrl);
    const appOrigin = url.protocol === appUrl.protocol && url.host === appUrl.host;
    if ((!appOrigin && url.origin !== options.apiOrigin) || !url.pathname.startsWith('/api/'))
      return networkFetch(input, init);
    const request = new Request(input instanceof Request ? input : url, init);
    if (request.signal.aborted) throw new DOMException('The request was aborted', 'AbortError');
    await initialize();
    const isMe = url.pathname === '/api/me';
    // Reauthentication and SRP upgrades do not change the active account.
    const authMutation =
      request.method === 'POST' &&
      /^\/api\/auth\/(?:register|login(?:\/(?:start|verify))?|flaxia\/exchange|logout)$/.test(url.pathname);
    if (authMutation) await reset();
    const currentGeneration = generation;
    const key = isMe ? 'identity' : owner + ':' + url.pathname + url.search;
    const cacheable =
      request.method === 'GET' &&
      isOfflineReadable(url.pathname) &&
      request.cache !== 'no-store' &&
      !request.headers.has('Authorization') &&
      !request.headers.has('Range');
    // Sign-in must never be suppressed by a stale navigator.onLine value.
    const authRequest = url.pathname.startsWith('/api/auth/');
    const fallback = async (): Promise<Response> => {
      // A single failed read must not invalidate the sticky proof that the
      // network works: one stalled /api/posts used to flip the whole app
      // offline and gate every later read into 503s. The probe (and the
      // browser 'offline' event) remain the only things allowed to clear
      // `reachable`; a failed read only schedules another probe.
      options.setOffline(true);
      scheduleRetry();
      const record = cacheable ? await safely(() => store.get(key)) : undefined;
      if (request.signal.aborted) throw new DOMException('The request was aborted', 'AbortError');
      if (record && generation === currentGeneration && now() - record.savedAt <= MAX_AGE) {
        logEvent('offline-fetch', 'fallback_cache', { method: request.method, path: url.pathname });
        return new Response(record.body, {
          headers: {
            'Content-Type': record.body.type,
            'X-Flaxia-Offline': '1',
            'X-Flaxia-Saved-At': String(record.savedAt),
            'Cache-Control': 'no-store',
          },
        });
      }
      if (record && now() - record.savedAt > MAX_AGE) await safely(() => store.delete(key));
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        logEvent('offline-fetch', 'fallback_throw', { method: request.method, path: url.pathname });
        throw new TypeError('This action requires an internet connection');
      }
      logEvent('offline-fetch', 'fallback_denied', { method: request.method, path: url.pathname });
      return new Response(JSON.stringify({ error: 'offline_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'X-Flaxia-Offline': '1', 'Cache-Control': 'no-store' },
      });
    };
    if (!options.isOnline() && !reachable && !authRequest) {
      logEvent('offline-fetch', 'read_gated', { path: url.pathname });
      return fallback();
    }
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Response;
    let savedBody: Blob | undefined;
    try {
      const attempt = (async () => {
        const result = await networkFetch(new Request(request, { signal: controller.signal }));
        const type = result.headers.get('Content-Type') ?? '';
        const media = /^\/api\/(?:images|thumbnail)\//.test(url.pathname);
        if (
          cacheable &&
          result.status === 200 &&
          (media ? type.startsWith('image/') : type.includes('application/json'))
        ) {
          savedBody = await result.clone().blob();
        }
        return result;
      })();
      response = cacheable
        ? await Promise.race([
            attempt,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new TypeError('Offline read timed out'));
              }, READ_TIMEOUT_MS);
            }),
          ])
        : await attempt;
    } catch (error) {
      if (request.signal.aborted) throw error;
      return fallback();
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
    }
    if (currentGeneration !== generation) return response;
    // Any response proves the network is reachable, even a saved-feed warning
    // or an HTTP error. A false navigator.onLine must not keep the banner up.
    reachable = true;
    clearRetry();
    options.setOffline(false);
    // A guest's /api/me is always 401. Only clear snapshots when an
    // authenticated owner is losing its session; otherwise the guest feed that
    // was just cached (or is about to be) would be wiped on every visit.
    if (
      (isMe && response.status === 401 && owner !== 'guest') ||
      (request.method === 'DELETE' && url.pathname === '/api/users/me' && response.ok)
    ) {
      await reset();
      return response;
    }
    if (!cacheable) return response;
    if (!response.ok) {
      if ([401, 403, 404, 410].includes(response.status)) await safely(() => store.delete(key));
      return response;
    }
    await safely(async () => {
      if (!isMe && /\bno-store\b/i.test(response.headers.get('Cache-Control') ?? '')) return;
      const body = savedBody;
      if (!body || body.size > MAX_RESPONSE_BYTES || generation !== currentGeneration) return;
      if (isMe) {
        const data = displayIdentity(JSON.parse(await body.text()));
        if (!data || generation !== currentGeneration) return;
        if (owner !== data.user.id) {
          generation++;
          owner = data.user.id;
          const identityGeneration = generation;
          await store.clear();
          if (generation !== identityGeneration) return;
        }
        await store.put({
          key: 'identity',
          body: new Blob([JSON.stringify(data)], { type: 'application/json' }),
          savedAt: now(),
        });
      } else {
        await store.put({ key, body, savedAt: now() });
      }
    });
    return response;
  };
}
