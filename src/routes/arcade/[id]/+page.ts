import { error } from '@sveltejs/kit';
import { arcadeGameTitle } from '../../../../shared/game-title.ts';
import { loadThread, type SsrGame } from '../../../lib/ssr-data.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, setHeaders }) => {
  if (import.meta.env.BUILD_TARGET === 'native') return { game: null, post: null, replies: [] };
  setHeaders({ 'Cache-Control': 'private, no-store' });
  if (!params.id) throw error(404, 'Game not found');
  // There is no per-game /api/games endpoint. The thread load already returns
  // the game post with its text and author, so build the small game header
  // from that instead of fetching 50 games just to find the matching id.
  const thread = await loadThread(fetch, params.id);
  if (!thread.root) throw error(404, 'Game not found');
  const root = thread.root;
  const game: SsrGame | null = {
    postId: root.id,
    title: arcadeGameTitle(root.game_title, root.text, root.username),
    username: root.username,
    thumbnailKey: root.thumbnail_key ?? null,
    createdAt: root.created_at,
  };
  return {
    game,
    post: root,
    replies: thread.replies,
  };
};
