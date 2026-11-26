<script lang="ts">
import { onMount } from 'svelte';
import { page } from '$app/state';
import { t } from '../../../lib/i18n.ts';
import { renderPersonJsonLd, SEO_ORIGIN } from '../../../lib/seo-jsonld.ts';
import RemoteProfilePage from '../../../lib/svelte/RemoteProfilePage.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../../lib/svelte/ShellLayout.svelte';
import SsrOnly from '../../../lib/svelte/SsrOnly.svelte';
import { getSessionUser } from '../../../lib/svelte/session.ts';
import type { PageProps } from './$types';

const DEFAULT_OG_IMAGE = `${SEO_ORIGIN}/og-default-v2.png`;

let { data }: PageProps = $props();

const domain = $derived(page.params.domain ?? '');
const username = $derived(page.params.username ?? '');
const actor = $derived(data.profile?.actor ?? null);
const handle = $derived(`@${username}@${domain}`);
const bio = $derived(actor?.bio ?? null);
const ssrPosts = $derived(data.profile?.posts ?? []);
const metaTitle = $derived(`Flaxia - ${t('remote_profile.title')} · ${handle}`);
const description = $derived(bio?.trim() ? bio.slice(0, 160) : `${t('remote_profile.title')} · ${handle} on Flaxia`);
const canonicalUrl = $derived(`${SEO_ORIGIN}/@${encodeURIComponent(domain)}/${encodeURIComponent(username)}`);
const ogImage = $derived(actor?.icon_url && /^https?:\/\//i.test(actor.icon_url) ? actor.icon_url : DEFAULT_OG_IMAGE);
const jsonLd = $derived.by(() => {
  if (!actor) return '';
  return renderPersonJsonLd(
    {
      display_name: String(actor.display_name || handle),
      username: `${username}@${domain}`,
      bio: bio ?? '',
    },
    canonicalUrl,
  );
});

// The session is client-only; start null so SSR and the first client render agree.
let currentUser = $state<unknown>(null);
onMount(() => {
  currentUser = getSessionUser() ?? null;
});
</script>

<svelte:head>
  <title>{metaTitle}</title>
  {#if jsonLd}{@html jsonLd}{/if}
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

<ShellLayout navProps={{ activeItem: 'profile', currentUser }}>
  {#key `${domain}/${username}`}
    <SsrOnly>
      <section class="ssr-remote-profile" aria-label={t('remote_profile.title')}>
        <h1>{actor?.display_name || handle}</h1>
        <p class="ssr-remote-handle">{handle}</p>
        {#if bio}<p class="ssr-remote-bio">{bio}</p>{/if}
        {#each ssrPosts as post (post.id)}
          <p class="ssr-remote-post">{post.text}</p>
        {/each}
      </section>
    </SsrOnly>
    <RemoteProfilePage
      domain={domain}
      username={username}
      initialProfile={data.profile}
      currentUser={currentUser as never}
    />
  {/key}
</ShellLayout>
