<script lang="ts">
import { onMount } from 'svelte';
import { page } from '$app/state';
import { navigate } from '../../../lib/navigation.ts';
import ProfilePage from '../../../lib/svelte/ProfilePage.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../../lib/svelte/ShellLayout.svelte';
import { getSessionUser } from '../../../lib/svelte/session.ts';

// The session is client-only; start null so SSR and the first client render agree.
let currentUser = $state<unknown>(null);
onMount(() => {
  currentUser = getSessionUser() ?? null;
});
</script>

<ShellLayout navProps={{ activeItem: "profile", currentUser }}>
{#key page.params.username}
    <ProfilePage
      username={page.params.username ?? ""}
      currentUser={currentUser as never}
      sandboxOrigin={import.meta.env.VITE_SANDBOX_ORIGIN || "https://sandbox.flaxia.app"}
      onOpenSettings={() => void navigate("/settings")}
    />
{/key}
</ShellLayout>
