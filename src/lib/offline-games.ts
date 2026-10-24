import type { Game } from '../types/game.ts';
import type { Post } from '../types/post.ts';
import type { DownloadedGame, GameFile, OfflineGameStore } from './offline-game-store.ts';

const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const MAX_ZIP_BYTES = 25 * 1024 * 1024;
interface Options {
  store: OfflineGameStore;
  network: typeof fetch;
  extract: (bytes: ArrayBuffer) => Promise<GameFile[]>;
  online: () => boolean;
  changed?: () => void;
  now?: () => number;
  baseUrl?: string;
}
export type DownloadState = 'downloading' | 'saved' | 'error';

export function createOfflineGames(options: Options) {
  let owner: string | null = null;
  let generation = 0;
  let queue = Promise.resolve();
  let syncing: Promise<void> | undefined;
  const jobs = new Map<string, symbol>();
  const pendingDownloads = new Map<string, Promise<void>>();
  const removed = new Set<string>();
  const bookmarkVersions = new Map<string, symbol>();
  let bookmarkGeneration = 0;
  const states = new Map<string, DownloadState>();
  const transportFailures = new Set<string>();
  const now = options.now ?? Date.now;
  const changed = () => options.changed?.();
  async function account(next: string | null) {
    if (next === owner && next !== null) return;
    generation++;
    owner = next;
    jobs.clear();
    pendingDownloads.clear();
    removed.clear();
    bookmarkVersions.clear();
    states.clear();
    transportFailures.clear();
    syncing = undefined;
    await options.store.activate(next).catch(() => {});
    changed();
  }
  async function list() {
    if (!owner) return [];
    return (await options.store.list(owner).catch(() => [])).filter((game) => now() - game.savedAt <= MAX_AGE);
  }
  async function remove(id: string) {
    removed.add(id);
    bookmarkVersions.delete(id);
    jobs.delete(id);
    pendingDownloads.delete(id);
    states.delete(id);
    await options.store.delete(id).catch(() => {});
    changed();
  }
  async function request(path: string): Promise<Response> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        options.network(
          new Request(new URL(path, 'https://flaxia.app'), {
            credentials: 'include',
            cache: 'no-store',
            signal: controller.signal,
          }),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new TypeError('Game download timed out'));
          }, 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function download(post: Post): Promise<void> {
    if (jobs.has(post.id)) return pendingDownloads.get(post.id) ?? Promise.resolve();
    if (!owner || !post.payload_key || !options.online() || removed.has(post.id)) return Promise.resolve();
    const savedOwner = owner;
    const savedGeneration = generation;
    const job = Symbol();
    jobs.set(post.id, job);
    const valid = () => savedGeneration === generation && owner === savedOwner && jobs.get(post.id) === job;
    states.set(post.id, 'downloading');
    transportFailures.delete(post.id);
    changed();
    const run = queue.then(async () => {
      if (!valid()) return;
      try {
        const descriptor = await request(`/api/game-loader/${encodeURIComponent(post.id)}`).catch((error) => {
          if (valid()) transportFailures.add(post.id);
          throw error;
        });
        if (!valid()) return;
        if ([401, 403, 404, 410].includes(descriptor.status)) await options.store.delete(post.id);
        if (!descriptor.ok) throw new Error('Game is unavailable');
        const data = (await descriptor.json()) as {
          postId: string;
          revision: string;
          cacheable: boolean;
          archiveUrl: string;
          format?: 'zip' | 'html';
        };
        const archiveUrl = new URL(data.archiveUrl);
        if (
          data.postId !== post.id ||
          !/^[a-f0-9]{64}$/.test(data.revision) ||
          !data.cacheable ||
          archiveUrl.origin !== 'https://flaxia.app' ||
          archiveUrl.pathname !== `/api/game-loader/${post.id}/archive`
        )
          throw new Error('Game cannot be downloaded');
        const previous = await options.store.get(post.id, savedOwner);
        if (previous && previous.revision !== data.revision) await options.store.delete(post.id);
        let files = previous?.revision === data.revision ? previous.files : undefined;
        if (!files) {
          const response = await request(archiveUrl.href);
          if (!response.ok) throw new Error('Archive download failed');
          if (Number(response.headers.get('Content-Length')) > MAX_ZIP_BYTES) throw new Error('Archive too large');
          const reader = response.body?.getReader();
          if (!reader) throw new Error('Empty archive');
          const chunks: Uint8Array[] = [];
          let size = 0;
          let bodyTimer: ReturnType<typeof setTimeout> | undefined;
          const deadline = new Promise<never>((_, reject) => {
            bodyTimer = setTimeout(() => reject(new TypeError('Archive body timed out')), 30_000);
          });
          try {
            while (true) {
              const { done, value } = await Promise.race([reader.read(), deadline]);
              if (done) break;
              size += value.byteLength;
              if (size > MAX_ZIP_BYTES || !valid()) throw new Error('Archive too large or cancelled');
              chunks.push(value);
            }
          } finally {
            clearTimeout(bodyTimer);
            void reader.cancel().catch(() => {});
          }
          const joined = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            joined.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const bytes = joined.buffer;
          if (bytes.byteLength > MAX_ZIP_BYTES || !valid()) throw new Error('Archive too large or cancelled');
          files = data.format === 'html' ? [{ path: 'index.html', bytes }] : await options.extract(bytes);
        }
        if (!valid()) return;
        const record: DownloadedGame = {
          id: post.id,
          owner: savedOwner,
          post: { ...post, is_bookmarked: true },
          revision: data.revision,
          savedAt: now(),
          files,
          size: files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
        };
        await options.store.put(record, valid);
        if (valid()) states.set(post.id, 'saved');
      } catch {
        if (valid()) states.set(post.id, 'error');
      } finally {
        if (valid()) {
          jobs.delete(post.id);
          pendingDownloads.delete(post.id);
        }
        changed();
      }
    });
    queue = run.catch(() => {});
    pendingDownloads.set(post.id, run);
    return run;
  }
  function sync(): Promise<void> {
    if (!owner || !options.online()) return Promise.resolve();
    if (syncing) return syncing;
    const savedGeneration = generation;
    const savedBookmarks = bookmarkGeneration;
    removed.clear();
    const work = (async () => {
      const ids = new Set<string>();
      const cursors = new Set<string>();
      let cursor = '';
      do {
        const response = await request(
          `/api/bookmarks?limit=50${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
        );
        if (!response.ok || savedGeneration !== generation || savedBookmarks !== bookmarkGeneration) return;
        const { posts } = (await response.json()) as { posts: Post[] };
        if (!Array.isArray(posts)) return;
        for (const post of posts) {
          ids.add(post.id);
          await download(post);
          if (savedGeneration !== generation || savedBookmarks !== bookmarkGeneration) return;
        }
        if (posts.length < 50) break;
        cursor = posts.at(-1)?.created_at ?? '';
        if (!cursor || cursors.has(cursor)) return;
        cursors.add(cursor);
      } while (savedGeneration === generation);
      if (savedGeneration !== generation || savedBookmarks !== bookmarkGeneration || !owner) return;
      for (const game of await options.store.list(owner)) if (!ids.has(game.id)) await remove(game.id);
    })()
      .catch(() => {})
      .finally(() => {
        if (savedGeneration === generation) syncing = undefined;
      });
    syncing = work;
    return work;
  }
  async function files(id: string, versionId?: string): Promise<GameFile[] | undefined> {
    const savedGeneration = generation;
    const game = (await list()).find((item) => item.id === id);
    if (!game || versionId) return undefined;
    if (options.online()) {
      await download(game.post);
      if (states.get(id) === 'error') {
        if (!transportFailures.has(id)) return undefined;
        // Transport outages may use the snapshot; HTTP revocations delete it.
        const retained = (await list()).find((item) => item.id === id);
        return generation === savedGeneration && retained && owner
          ? (await options.store.get(id, owner))?.files
          : undefined;
      }
    }
    return generation === savedGeneration && owner ? (await options.store.get(id, owner))?.files : undefined;
  }
  const wrap =
    (next: typeof fetch): typeof fetch =>
    async (input, init) => {
      const base = new URL(options.baseUrl ?? 'https://flaxia.app');
      const url = new URL(input instanceof Request ? input.url : String(input), base);
      if (url.origin !== 'https://flaxia.app' && !(url.protocol === base.protocol && url.host === base.host))
        return next(input, init);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (headers.has('Authorization') || headers.has('Range')) return next(input, init);
      const noStore = (init?.cache ?? (input instanceof Request ? input.cache : undefined)) === 'no-store';
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (signal?.aborted) throw new DOMException('The request was aborted', 'AbortError');
      if (method === 'POST' && /^\/api\/auth\/(?:register|login(?:\/(?:start|verify))?|logout)$/.test(url.pathname))
        await account(null);
      const savedGeneration = generation;
      let response: Response;
      let transportFailed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const pending = next(input, init);
        response =
          method === 'GET' && url.pathname === '/api/bookmarks'
            ? await Promise.race([
                pending,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new TypeError('Bookmark read timed out')), 8000);
                }),
              ])
            : await pending;
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
        if (!['/api/bookmarks', '/api/games'].includes(url.pathname) || method !== 'GET') throw error;
        transportFailed = true;
        response = new Response(null, { status: 503 });
      } finally {
        clearTimeout(timer);
      }
      if (savedGeneration !== generation) return response;
      if (url.pathname === '/api/me' && method === 'GET') {
        if (response.status === 401) await account(null);
        else if (response.ok) {
          const data = (await response.clone().json()) as { user?: { id?: string } };
          if (typeof data.user?.id === 'string') {
            const switched = owner !== data.user.id;
            await account(data.user.id);
            if (switched && !response.headers.has('X-Flaxia-Offline')) void sync();
          }
        }
      }
      if (method === 'DELETE' && url.pathname === '/api/users/me' && response.ok) await account(null);
      const bookmark = url.pathname.match(/^\/api\/posts\/([^/]+)\/bookmark$/);
      if (bookmark && method === 'POST' && response.ok) {
        bookmarkGeneration++;
        const bookmarkVersion = Symbol();
        bookmarkVersions.set(bookmark[1], bookmarkVersion);
        const data = (await response.clone().json()) as { bookmarked: boolean };
        if (!data.bookmarked) await remove(bookmark[1]);
        else {
          removed.delete(bookmark[1]);
          void (async () => {
            const postResponse = await request(`/api/posts/${bookmark[1]}`);
            if (
              savedGeneration !== generation ||
              bookmarkVersions.get(bookmark[1]) !== bookmarkVersion ||
              !postResponse.ok
            )
              return;
            const postData = (await postResponse.json()) as { post: Post };
            if (postData.post) await download(postData.post);
          })().catch(() => {});
        }
      }
      if (
        method === 'GET' &&
        !noStore &&
        ['/api/bookmarks', '/api/games'].includes(url.pathname) &&
        (transportFailed || response.headers.has('X-Flaxia-Offline'))
      ) {
        const saved = (await list()).sort((a, b) => b.post.created_at.localeCompare(a.post.created_at));
        if (savedGeneration !== generation) return response;
        if (url.pathname === '/api/bookmarks') {
          const cursor = url.searchParams.get('cursor');
          return Response.json(
            {
              posts: saved
                .filter((game) => !cursor || game.post.created_at < cursor)
                .slice(0, Math.min(50, Number(url.searchParams.get('limit')) || 10))
                .map((game) => game.post),
            },
            { headers: { 'X-Flaxia-Offline': '1', 'Cache-Control': 'no-store' } },
          );
        }
        const games: Game[] = saved.map(({ post }) => ({
          id: post.id,
          postId: post.id,
          title: post.text,
          username: post.username,
          displayName: post.display_name,
          avatarKey: post.avatar_key,
          type: 'zip',
          payloadKey: post.payload_key,
          thumbnailKey: post.thumbnail_key,
          freshCount: post.fresh_count,
          replyCount: post.reply_count,
          bookmarkCount: post.bookmark_count,
          impressions: post.impressions,
          isBookmarked: true,
          createdAt: post.created_at,
        }));
        return Response.json(
          { games, hasMore: false },
          { headers: { 'X-Flaxia-Offline': '1', 'Cache-Control': 'no-store' } },
        );
      }
      return response;
    };
  return {
    wrap,
    list,
    files,
    download,
    sync,
    account,
    remove,
    states,
    storageKey: (id: string) => (owner ? `flaxia:offline-game:${owner}:${id}` : undefined),
  };
}
