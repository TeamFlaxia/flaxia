<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import type { PostAttachment } from '../../../shared/types/post.ts';
import { attachmentUrl, isAbsoluteMediaUrl } from '../../components/MediaCarousel.ts';
import { t } from '../i18n.ts';
import { navigate } from '../navigation.ts';
import { signalSsrHandover } from '../ssr-handover.ts';

interface Props {
  domain: string;
  username: string;
  currentUser?: { username: string } | null;
  /** SSR-loaded profile; when present the client does not fetch it again. */
  initialProfile?: {
    actor?: {
      actor_url?: string | null;
      display_name?: string | null;
      icon_url?: string | null;
      bio?: string | null;
    } | null;
    following?: boolean;
    follow_state?: string | null;
    posts?: RemotePost[];
  } | null;
}

interface RemotePost {
  id: string;
  text: string;
  created_at: string;
  attachments?: PostAttachment[];
}

let { domain, username, currentUser, initialProfile }: Props = $props();

const initialActor = initialProfile?.actor ?? null;
let displayName = $state(
  initialActor?.display_name || (initialProfile ? `@${username}@${domain}` : t('profile.loading')),
);
let avatarUrl = $state<string | null>(initialActor?.icon_url ?? null);
let bio = $state<string | null>(initialActor?.bio ?? null);
let actorUrl = $state<string | null>(initialActor?.actor_url ?? null);
let posts = $state<RemotePost[]>(initialProfile?.posts ?? []);
let notFound = $state(Boolean(initialProfile) && !initialActor);
// `follow_state` distinguishes an accepted follow from a pending request,
// which the old boolean `following` alone could not express.
let following = $state(
  initialProfile?.follow_state ? initialProfile.follow_state === 'accepted' : Boolean(initialProfile?.following),
);
let followPending = $state(initialProfile?.follow_state === 'pending');
let followVisible = $state(Boolean(initialActor));
let followBusy = $state(false);

const handle = $derived(`@${username}@${domain}`);
const followLabel = $derived(
  followPending ? t('search.remote_follow_pending') : following ? t('profile.unfollow') : t('profile.follow'),
);
// Actor links and avatars come from a remote document: only http(s) URLs may
// be loaded or opened.
const safeActorUrl = $derived(actorUrl && /^https?:\/\//i.test(actorUrl) ? actorUrl : null);
const safeAvatarUrl = $derived(avatarUrl && /^https?:\/\//i.test(avatarUrl) ? avatarUrl : null);

// The SSR load already supplied this handle's data. Skip the duplicate fetch on
// the first client effect; later param changes (outside the keyed route) fetch.
let skipInitialFetch = Boolean(initialProfile);

$effect(() => {
  const d = domain;
  const u = username;
  let cancelled = false;

  if (skipInitialFetch) {
    skipInitialFetch = false;
    if (initialActor) signalSsrHandover();
    return;
  }

  notFound = false;
  avatarUrl = null;
  bio = null;
  actorUrl = null;
  posts = [];
  followVisible = false;
  followPending = false;
  displayName = t('profile.loading');

  void (async () => {
    try {
      const response = await fetch(`/api/remote/actors/${encodeURIComponent(d)}/${encodeURIComponent(u)}`);
      if (!response.ok) {
        if (!cancelled) {
          notFound = true;
          displayName = t('remote_profile.not_found');
        }
        return;
      }
      const data = (await response.json()) as {
        actor?: {
          actor_url?: string | null;
          display_name: string | null;
          icon_url: string | null;
          bio?: string | null;
        };
        following?: boolean;
        follow_state?: string | null;
        posts?: RemotePost[];
      };
      if (cancelled) return;
      displayName = data.actor?.display_name || `@${u}@${d}`;
      avatarUrl = data.actor?.icon_url ?? null;
      bio = data.actor?.bio ?? null;
      actorUrl = data.actor?.actor_url ?? null;
      following = data.follow_state ? data.follow_state === 'accepted' : Boolean(data.following);
      followPending = data.follow_state === 'pending';
      followVisible = true;
      posts = data.posts ?? [];
      signalSsrHandover();
    } catch {
      if (!cancelled) {
        notFound = true;
        displayName = t('remote_profile.not_found');
      }
    }
  })();

  return () => {
    cancelled = true;
  };
});

async function toggleFollow(): Promise<void> {
  if (!currentUser) {
    void navigate('/login');
    return;
  }
  if (followBusy) return;
  if (followPending) return;
  followBusy = true;
  const wasFollowing = following;
  // Federation can be slow: show the new state immediately, restore on failure.
  following = !following;
  try {
    const response = await fetch('/api/remote-follow', {
      method: wasFollowing ? 'DELETE' : 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: `${username}@${domain}` }),
    });
    if (!response.ok) {
      following = !following;
      return;
    }
    // apiJson() caches the SSR profile for 10s; a successful follow/unfollow
    // must evict it so navigating back reloads the current follow state.
    window.dispatchEvent(new CustomEvent('followChanged'));
    if (wasFollowing) {
      followPending = false;
    } else {
      const body = (await response.json().catch(() => ({}))) as { status?: string };
      followPending = body.status !== 'accepted';
      following = body.status === 'accepted';
    }
  } catch {
    following = !following;
    followPending = false;
  } finally {
    followBusy = false;
  }
}
</script>

<div class="profile-page remote-profile-page">
  <div class="profile-topbar">
    <button type="button" class="profile-back-button" onclick={() => window.history.back()}>←</button>
    <span class="profile-topbar-title">{handle}</span>
  </div>

  <div class="profile-header">
    <div class="profile-avatar-section">
      <div class="profile-avatar fx-display">
        {#if safeAvatarUrl}
          <img class="profile-avatar-image" src={safeAvatarUrl} alt={displayName} />
        {:else}
          {username.charAt(0).toUpperCase()}
        {/if}
      </div>
      <div class="profile-info">
        <div class="profile-display-name fx-display">{displayName}</div>
        <div class="profile-username">{handle}</div>
        {#if bio}
          <div class="profile-bio-label">{t('remote_profile.bio_label')}</div>
          <div class="profile-bio">{bio}</div>
        {/if}
        {#if safeActorUrl}
          <a class="profile-instance-link" href={safeActorUrl} target="_blank" rel="noopener noreferrer">
            {t('remote_profile.view_on_instance')}
          </a>
        {/if}
        <div class="profile-stats">
          <div class="profile-stat">
            <span>{posts.length}</span>
            <span>{t('remote_profile.posts')}</span>
          </div>
        </div>
        {#if followVisible}
          <button
            type="button"
            class="profile-follow-button"
            aria-busy={followBusy}
            disabled={followPending}
            onclick={toggleFollow}
          >
            {followLabel}
          </button>
        {/if}
      </div>
    </div>
  </div>

  <div class="timeline-container">
    {#if notFound}
      <div class="timeline-empty">{t('remote_profile.not_found')}</div>
    {:else if posts.length === 0}
      <div class="timeline-empty">{t('remote_profile.empty')}</div>
    {:else}
      {#each posts as post (post.id)}
        <div class="post-card">
          <div class="post-author">{handle}</div>
          <div class="post-text">{post.text}</div>
          {#if post.attachments?.length}
            <div class="remote-post-attachments">
              {#each post.attachments as att (att.position)}
                {#if att.kind === 'image'}
                  <img src={attachmentUrl(att)} alt="" loading="lazy" decoding="async" />
                {:else if att.kind === 'video'}
                  <video src={attachmentUrl(att)} controls playsinline preload="metadata"></video>
                {:else if att.kind === 'audio'}
                  <audio src={attachmentUrl(att)} controls preload="metadata"></audio>
                {:else}
                  <a
                    class="remote-post-attachment-link"
                    href={attachmentUrl(att)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    ↗ {isAbsoluteMediaUrl(att.r2_key)
                      ? att.r2_key.split('/').pop()?.split('?')[0] || t('composer.preview_open_document')
                      : att.r2_key.split('/').pop() || t('composer.download_file')}
                  </a>
                {/if}
              {/each}
            </div>
          {/if}
          <div class="post-meta">{new Date(post.created_at).toLocaleString()}</div>
        </div>
      {/each}
    {/if}
  </div>
</div>
