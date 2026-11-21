<script lang="ts">
import { onMount } from 'svelte';
import { resolveAuthRedirect } from '../../lib/auth-guard.ts';
import { navigate } from '../../lib/navigation.ts';
import SettingsPage from '../../lib/svelte/SettingsPage.svelte';
import ShellLayout from '../../lib/svelte/ShellLayout.svelte';
import { getSessionUser } from '../../lib/svelte/session.ts';

let user = $state<Record<string, unknown> | null>(null);

onMount(() => {
  const session = getSessionUser();
  // Guests used to get an empty shell with no explanation.
  const redirect = resolveAuthRedirect('/settings', Boolean(session));
  if (redirect) {
    void navigate(redirect.path, { replaceState: true });
    return;
  }
  user = (session ?? null) as unknown as Record<string, unknown> | null;
});
</script>

<ShellLayout navProps={{ activeItem: 'settings', currentUser: user }}>
  {#if user}
    <SettingsPage currentUser={user} />
  {/if}
</ShellLayout>
