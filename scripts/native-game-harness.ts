// Test-only entry: copied into the APK only by native-android.yml.

import { initOfflineGames } from '../src/lib/native-offline-games.ts';
import { executeDownloadedGame } from '../src/lib/offline-game-player.ts';
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
const games = initOfflineGames(async (input) => {
  requests++;
  if (!navigator.onLine) throw new TypeError('Offline fixture network');
  const url = new URL((input as Request).url);
  if (url.pathname === '/api/bookmarks') return Response.json({ posts: [post] });
  if (url.pathname.endsWith('/archive')) return fetch('/__game-fixture.zip');
  return Response.json({
    postId: post.id,
    cacheable: true,
    revision: 'a'.repeat(64),
    archiveUrl: 'https://flaxia.app/api/game-loader/offline-fixture/archive',
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
};
Object.assign(window, { nativeGameHarness: harness });
