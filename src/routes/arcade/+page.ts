import { browser } from '$app/env';
import { loadGames } from '../../lib/ssr-data.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, setHeaders }) => {
  if (browser) return { games: [] };
  setHeaders({ 'Cache-Control': 'private, max-age=0, s-maxage=60' });
  return { games: await loadGames(fetch, 30) };
};
