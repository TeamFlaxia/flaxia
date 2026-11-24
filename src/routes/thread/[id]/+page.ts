import { error } from '@sveltejs/kit';
import { browser } from '$app/env';
import { loadThread } from '../../../lib/ssr-data.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, setHeaders }) => {
  if (browser) return { root: null, replies: [] };
  // Threads include per-viewer flags (fresh/bookmark) from the session cookie.
  setHeaders({ 'Cache-Control': 'private, no-store' });
  if (!params.id) throw error(404, 'Thread not found');
  const thread = await loadThread(fetch, params.id);
  if (!thread.root) throw error(404, 'Thread not found');
  return thread;
};
