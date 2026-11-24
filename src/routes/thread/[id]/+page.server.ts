import { error } from '@sveltejs/kit';
import { loadThread } from '../../../lib/server/ssr-data.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, request, platform, setHeaders }) => {
  const env = platform?.env;
  if (!env?.DB) throw error(500, 'Database not available');
  if (!params.id) throw error(404, 'Thread not found');
  // Threads include per-viewer flags (fresh/bookmark) from the session cookie.
  setHeaders({ 'Cache-Control': 'private, no-store' });
  const thread = await loadThread(request, env as never, params.id);
  if (!thread.root) throw error(404, 'Thread not found');
  return thread;
};
