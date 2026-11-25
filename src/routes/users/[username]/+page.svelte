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

const SITE_ORIGIN = 'https://flaxia.app';
const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/og-default-v2.png`;

let { data }: PageProps = $props();

const ssrUser = $derived(data.user);
const ssrAvatar = $derived(ssrUser?.avatar_key ? `/api/images/${String(ssrUser.avatar_key)}` : '/default-avatar.png');
const username = $derived(ssrUser?.username || page.params.username || '');
const metaTitle = $derived(`${ssrUser?.display_name || username} (@${username}) - Flaxia`);
const description = $derived(ssrUser?.bio?.trim() ? ssrUser.bio.slice(0, 160) : `@${username}'s profile on Flaxia`);
const canonicalUrl = $derived(username ? `${SITE_ORIGIN}/users/${encodeURIComponent(username)}` : page.url.href);
const ogImage = $derived(
  ssrUser?.avatar_key
    ? `${SITE_ORIGIN}/api/images/${encodeURIComponent(String(ssrUser.avatar_key))}`
    : DEFAULT_OG_IMAGE,
);
let currentUser = $state<unknown>(null);
onMount(() => {
  currentUser = getSessionUser() ?? null;
});
</script>

<svelte:head>
  <meta name="description" content={description} />
  <meta property="og:title" content={metaTitle} />
  <meta property="og:description" content={description} />
  <meta property="og:url" content={canonicalUrl} />
  <meta property="og:image" content={ogImage} />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={metaTitle} />
  <meta name="twitter:description" content={description} />
  <meta name="twitter:image" content={ogImage} />
  <link rel="canonical" href={canonicalUrl} />
</svelte:head>

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
