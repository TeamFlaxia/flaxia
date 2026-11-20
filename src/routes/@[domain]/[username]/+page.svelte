<script lang="ts">
import { page } from '$app/state';
import RemoteProfilePage from '../../../lib/svelte/RemoteProfilePage.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../../lib/svelte/ShellLayout.svelte';
import { getSessionUser } from '../../../lib/svelte/session.ts';
</script>

<ShellLayout navProps={{ activeItem: 'profile', currentUser: getSessionUser() ?? undefined }}>
  <RemoteProfilePage
    domain={page.params.domain}
    username={page.params.username}
    currentUser={getSessionUser() ?? null}
  />
</ShellLayout>
