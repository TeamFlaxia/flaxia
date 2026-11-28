import { error, redirect } from '@sveltejs/kit';
import { loadRemoteProfile } from '../../../lib/ssr-data.ts';
import type { PageLoad } from './$types';

const DOMAIN_PATTERN = /^[a-z0-9.-]+$/i;
// Same grammar as parseRemoteHandle(): the follow endpoint splits its target
// on '@', so a username containing one would redirect to a different account.
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,30}$/;

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

  // Domains are case-insensitive; the API lowercase-matches them. Serve one
  // canonical URL per account instead of a separate URL for every casing.
  const normalizedDomain = domain.toLowerCase();
  if (normalizedDomain !== domain) throw redirect(308, `/@${normalizedDomain}/${encodeURIComponent(username)}`);

  const profile = await loadRemoteProfile(fetch, normalizedDomain, username);
  if (!profile) throw error(404, 'Remote account not found');
  return { profile };
};
