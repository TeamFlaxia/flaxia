import type { OfflineStore } from './offline-store.ts';

const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const READ_TIMEOUT_MS = 8000;

interface OfflineFetchOptions {
  store: OfflineStore;
  baseUrl: string;
  apiOrigin: string;
  isOnline: () => boolean;
  setOffline: (offline: boolean) => void;
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
  for (const field of ['display_name', 'avatar_key', 'badge_type']) {
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
  const unavailableReads = new Map<string, string>();
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
    unavailableReads.clear();
    await safely(() => store.clear());
  };
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
      request.method === 'POST' && /^\/api\/auth\/(?:register|login(?:\/(?:start|verify))?|logout)$/.test(url.pathname);
    if (authMutation) await reset();
    const currentGeneration = generation;
    const key = isMe ? 'identity' : owner + ':' + url.pathname + url.search;
    const isFeed = url.pathname === '/api/posts' || url.pathname === '/api/posts/recommended';
    const feedParams = new URLSearchParams(url.search);
    feedParams.delete('cursor');
    feedParams.sort();
    const readGroup = isFeed ? owner + ':' + url.pathname + '?' + feedParams.toString() : key;
    const cacheable =
      request.method === 'GET' &&
      isOfflineReadable(url.pathname) &&
      request.cache !== 'no-store' &&
      !request.headers.has('Authorization') &&
      !request.headers.has('Range');
    const fallback = async (): Promise<Response> => {
      options.setOffline(true);
      const record = cacheable ? await safely(() => store.get(key)) : undefined;
      if (request.signal.aborted) throw new DOMException('The request was aborted', 'AbortError');
      if (record && generation === currentGeneration && now() - record.savedAt <= MAX_AGE) {
        // Only saved content can stay stale after connectivity recovers.
        unavailableReads.set(key, readGroup);
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
      if (request.method !== 'GET' && request.method !== 'HEAD')
        throw new TypeError('This action requires an internet connection');
      return new Response(JSON.stringify({ error: 'offline_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'X-Flaxia-Offline': '1', 'Cache-Control': 'no-store' },
      });
    };
    if (!options.isOnline()) return fallback();
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
    // A notification/image success cannot make a saved feed fresh.
    if (request.method === 'GET') {
      unavailableReads.delete(key);
      // A fresh first page replaces the feed, including previously saved pages.
      // Keep other feed filters and unrelated reads independently stale.
      if (response.ok && isFeed && !url.searchParams.has('cursor')) {
        for (const [savedKey, group] of unavailableReads) {
          if (group === readGroup) unavailableReads.delete(savedKey);
        }
      }
    }
    options.setOffline(unavailableReads.size > 0 || !options.isOnline());
    if (
      (isMe && response.status === 401) ||
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
