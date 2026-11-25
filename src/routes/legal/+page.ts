import { redirect } from '@sveltejs/kit';

// Dev/native fallback for the edge-level `/legal → /privacy` redirect in
// `_redirects`. adapter-cloudflare excludes `_redirects` sources from the
// worker, so production still uses the edge redirect; plain `vite dev` has no
// `_redirects` and would otherwise fall through to the catch-all 404.
export function load(): never {
  redirect(308, '/privacy');
}
