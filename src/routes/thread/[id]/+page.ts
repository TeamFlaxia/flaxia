import { error } from '@sveltejs/kit';
import { loadThread } from '../../../lib/ssr-data.ts';
import { takeOptimisticRoot } from '../../../lib/thread/optimistic-thread.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, setHeaders }) => {
  if (import.meta.env.BUILD_TARGET === 'native') return { root: null, replies: [], deferred: false };
  // Threads include per-viewer flags (fresh/bookmark) from the session cookie.
  setHeaders({ 'Cache-Control': 'private, no-store' });
  if (!params.id) throw error(404, 'Thread not found');

  // Client-side navigation only: the clicked card cached its Post, so paint it
  // now and let ThreadPage fetch replies in the background. SSR, crawlers,
  // direct visits and the native build keep the blocking load (and its 404s).
  if (!import.meta.env.SSR) {
    const root = takeOptimisticRoot(params.id);
    if (root) return { root, replies: [], deferred: true };
  }

  const thread = await loadThread(fetch, params.id);
  if (!thread.root) throw error(404, 'Thread not found');
  return { ...thread, deferred: false };
};
