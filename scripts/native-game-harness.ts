// Test-only entry: copied into the APK only by native-android.yml.

import { initOfflineGames } from '../src/lib/native-offline-games.ts';
import { executeDownloadedGame } from '../src/lib/offline-game-player.ts';
import { executeWvfsZip } from '../src/lib/wvfs-zip-client.ts';
import type { Post } from '../src/types/post.ts';

const post = {
  id: 'offline-fixture',
  user_id: 'fixture-author',
  username: 'fixture',
  text: 'Offline counter game',
  hashtags: '[]',
  payload_key: 'zip/offline-fixture.zip',
  created_at: '2026-10-24T00:00:00Z',
  fresh_count: 0,
  reload_count: 0,
  bookmark_count: 1,
  reply_count: 0,
  impressions: 0,
  depth: 0,
  hidden: 0,
  status: 'published',
  is_bookmarked: true,
} satisfies Post;
let requests = 0;
const modulePost = { ...post, id: 'offline-modules', payload_key: 'html/offline-modules.html' };
const games = initOfflineGames(async (input) => {
  requests++;
  if (!navigator.onLine) throw new TypeError('Offline fixture network');
  const url = new URL((input as Request).url);
  if (url.pathname === '/api/bookmarks') return Response.json({ posts: [post] });
  if (url.pathname.endsWith('/archive')) {
    return url.pathname.includes(modulePost.id)
      ? new Response('<script type="module">export {}</script>')
      : fetch('/__game-fixture.zip');
  }
  const id = url.pathname.split('/').at(-1);
  return Response.json({
    postId: id,
    format: id === modulePost.id ? 'html' : 'zip',
    cacheable: true,
    revision: 'a'.repeat(64),
    archiveUrl: `https://flaxia.app/api/game-loader/${id}/archive`,
  });
});
const container = document.createElement('main');
container.style.cssText = 'width:100vw;height:90vh;';
document.body.appendChild(container);
const harness = {
  async prepare() {
    await games.account('smoke-user');
    await games.sync();
    return games.states.get(post.id);
  },
  async play() {
    await games.account('smoke-user');
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    const before = requests;
    const player = await executeDownloadedGame(post.id, container);
    return { played: Boolean(player), networkRequests: requests - before, saved: (await games.list()).length };
  },
  async prepareUnsupported() {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    await games.account('smoke-user');
    await games.download(modulePost);
    // Avoid the unrelated legacy storage migration during the online fallback.
    localStorage.setItem(`flaxia:game:${modulePost.id}`, '{}');
    return games.states.get(modulePost.id);
  },
  async launchUnsupported(online: boolean) {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
    const capacitor = Object.getOwnPropertyDescriptor(window, 'Capacitor');
    Object.defineProperty(window, 'Capacitor', { configurable: true, value: { isNativePlatform: () => true } });
    try {
      await executeWvfsZip(modulePost.id, container, window.location.origin, true, false);
      return { played: true, error: '' };
    } catch (error) {
      return { played: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (capacitor) Object.defineProperty(window, 'Capacitor', capacitor);
      else Reflect.deleteProperty(window, 'Capacitor');
    }
  },
};
Object.assign(window, { nativeGameHarness: harness });
