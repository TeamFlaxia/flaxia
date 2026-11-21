<script lang="ts">
import { t } from '../i18n.ts';

interface Props {
  domain: string;
  username: string;
  currentUser?: { username: string } | null;
}

interface RemotePost {
  id: string;
  text: string;
  created_at: string;
}

let { domain, username, currentUser }: Props = $props();

let displayName = $state(t('profile.loading'));
let avatarUrl = $state<string | null>(null);
let posts = $state<RemotePost[]>([]);
let notFound = $state(false);
let following = $state(false);
let followVisible = $state(false);
let followBusy = $state(false);

const handle = `@${username}@${domain}`;

$effect(() => {
  const d = domain;
  const u = username;
  let cancelled = false;
  notFound = false;
  avatarUrl = null;
  posts = [];

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
        actor?: { display_name: string | null; icon_url: string | null };
        following?: boolean;
        posts?: RemotePost[];
      };
      if (cancelled) return;
      displayName = data.actor?.display_name || `@${u}@${d}`;
      avatarUrl = data.actor?.icon_url ?? null;
      following = Boolean(data.following);
      followVisible = true;
      posts = data.posts ?? [];
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
    window.location.href = '/login';
    return;
  }
  if (followBusy) return;
  followBusy = true;
  try {
    const response = await fetch('/api/remote-follow', {
      method: following ? 'DELETE' : 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: `${username}@${domain}` }),
    });
    if (response.ok) following = !following;
  } catch {
    // keep the current state
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
        {#if avatarUrl}
          <img class="profile-avatar-image" src={avatarUrl} alt={displayName} />
        {:else}
          {username.charAt(0).toUpperCase()}
        {/if}
      </div>
      <div class="profile-info">
        <div class="profile-display-name fx-display">{displayName}</div>
        <div class="profile-username">{handle}</div>
        <div class="profile-bio"></div>
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
            disabled={followBusy}
            onclick={toggleFollow}
          >
            {following ? t('profile.unfollow') : t('profile.follow')}
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
          <div class="post-meta">{new Date(post.created_at).toLocaleString()}</div>
        </div>
      {/each}
    {/if}
  </div>
</div>
