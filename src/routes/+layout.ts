// The legacy SPA owns rendering for now. F5-F8 will move pages into Svelte
// one at a time; until then SvelteKit only supplies the static shell.
export const ssr = false;
export const prerender = false;
