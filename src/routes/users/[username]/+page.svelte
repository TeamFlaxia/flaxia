<script lang="ts">
import { page } from '$app/state';
import { navigate } from '../../../lib/navigation.ts';
import ProfilePage from '../../../lib/svelte/ProfilePage.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../../lib/svelte/ShellLayout.svelte';
import { getSessionUser } from '../../../lib/svelte/session.ts';
</script>

<ShellLayout navProps={{ activeItem: "profile", currentUser: getSessionUser() ?? null }}>
{#key page.params.username}
    <ProfilePage
      username={page.params.username ?? ""}
      currentUser={(getSessionUser() ?? null) as never}
      sandboxOrigin={import.meta.env.VITE_SANDBOX_ORIGIN || "https://sandbox.flaxia.app"}
      onOpenSettings={() => void navigate("/settings")}
    />
{/key}
</ShellLayout>
