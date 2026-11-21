<script lang="ts">
import { onMount } from 'svelte';
import SettingsPage from '../../lib/svelte/SettingsPage.svelte';
import ShellLayout from '../../lib/svelte/ShellLayout.svelte';
import { getSessionUser } from '../../lib/svelte/session.ts';

let user = $state<Record<string, unknown> | null>(null);

onMount(() => {
  user = (getSessionUser() ?? null) as unknown as Record<string, unknown> | null;
});
</script>

<ShellLayout navProps={{ activeItem: 'settings', currentUser: user }}>
  {#if user}
    <SettingsPage currentUser={user} />
  {/if}
</ShellLayout>
