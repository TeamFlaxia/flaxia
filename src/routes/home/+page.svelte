<script lang="ts">
import { onMount } from 'svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../lib/svelte/ShellLayout.svelte';
import SsrPostList from '../../lib/svelte/SsrPostList.svelte';
import { getSessionUser } from '../../lib/svelte/session.ts';
import Timeline from '../../lib/svelte/Timeline.svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

// biome-ignore lint/correctness/noUnusedVariables: Svelte shorthand prop in markup
let navProps = $state<Record<string, unknown>>({});
// Start null so SSR and the first client render match, then hydrate the session.
let currentUser = $state<{ id: string; username: string } | null>(null);

onMount(() => {
  void (async () => {
    const { initI18n } = await import('../../lib/i18n.ts');
    await initI18n();
    const user = getSessionUser() as
      | { id: string; username: string; display_name?: string; avatar_key?: string; badge_type?: string | null }
      | undefined;
    currentUser = user ?? null;
    navProps = { activeItem: 'home', currentUser: user };
  })();
});
</script>

<ShellLayout {navProps}>
  <Timeline
    sandboxOrigin={import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app'}
    currentUser={currentUser}
  />
  <SsrPostList posts={data.posts} label="Timeline" />
</ShellLayout>
