<script lang="ts">
import { onMount } from 'svelte';
import { page } from '$app/state';
import { navigate } from '../../../lib/navigation.ts';
import AvatarBadge from '../../../lib/svelte/AvatarBadge.svelte';
import ProfilePage from '../../../lib/svelte/ProfilePage.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../../lib/svelte/ShellLayout.svelte';
import SsrOnly from '../../../lib/svelte/SsrOnly.svelte';
import SsrPostList from '../../../lib/svelte/SsrPostList.svelte';
import { getSessionUser } from '../../../lib/svelte/session.ts';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const ssrUser = $derived(data.user);
const ssrAvatar = $derived(ssrUser?.avatar_key ? `/api/images/${String(ssrUser.avatar_key)}` : '/default-avatar.png');
let currentUser = $state<unknown>(null);
onMount(() => {
  currentUser = getSessionUser() ?? null;
});
</script>

<ShellLayout navProps={{ activeItem: "profile", currentUser }}>
{#key page.params.username}
    <SsrOnly>
      <section class="ssr-profile" aria-label="Profile">
        {#if ssrUser}
          <span class="ssr-avatar-wrap">
            <img class="ssr-avatar" src={ssrAvatar} alt="" width="40" height="40" />
            <AvatarBadge badgeType={ssrUser.badge_type as string | null | undefined} />
          </span>
          <h1>{ssrUser.display_name || ssrUser.username}</h1>
          <p class="ssr-profile__handle">@{ssrUser.username}</p>
          {#if ssrUser.bio}<p class="ssr-profile__bio">{ssrUser.bio}</p>{/if}
        {:else}
          <h1>@{page.params.username}</h1>
        {/if}
      </section>
    </SsrOnly>
    <ProfilePage
      username={page.params.username ?? ""}
      currentUser={currentUser as never}
      sandboxOrigin={import.meta.env.VITE_SANDBOX_ORIGIN || "https://sandbox.flaxia.app"}
      onOpenSettings={() => void navigate("/settings")}
    />
    <SsrPostList posts={data.posts} label="Posts" />
{/key}
</ShellLayout>
