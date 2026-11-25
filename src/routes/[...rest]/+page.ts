import { error } from '@sveltejs/kit';

// Every known view has its own Svelte route. Anything else is a real 404 so
// crawlers see the +error.svelte head (single title, noindex) instead of a
// 200 shell that redirects to /home in the browser.
export function load(): never {
  error(404, 'Not Found');
}
