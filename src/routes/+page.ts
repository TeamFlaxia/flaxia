import { redirect } from '@sveltejs/kit';

// GET / is a permanent redirect, resolved during load so crawlers and no-JS
// visitors never receive a shell that only navigates after hydration.
export function load(): never {
  redirect(308, '/home');
}
