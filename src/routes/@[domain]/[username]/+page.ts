import { error } from '@sveltejs/kit';
import { loadRemoteProfile } from '../../../lib/ssr-data.ts';
import type { PageLoad } from './$types';

const DOMAIN_PATTERN = /^[a-z0-9.-]+$/i;
const USERNAME_PATTERN = /^[^\s/]+$/;

export const load: PageLoad = async ({ fetch, params, setHeaders }) => {
  if (import.meta.env.BUILD_TARGET === 'native') return { profile: null };

  // The response carries per-viewer follow state, so it must never be cached.
  setHeaders({ 'Cache-Control': 'private, no-store' });

  const domain = params.domain ?? '';
  const username = params.username ?? '';
  if (
    !DOMAIN_PATTERN.test(domain) ||
    domain.length > 253 ||
    !USERNAME_PATTERN.test(username) ||
    username.length > 100
  ) {
    throw error(404, 'Remote account not found');
  }

  const profile = await loadRemoteProfile(fetch, domain, username);
  if (!profile) throw error(404, 'Remote account not found');
  return { profile };
};
