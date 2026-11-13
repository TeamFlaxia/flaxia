// The profile of an account that lives on another instance.
//
// The page shows what this instance knows about the account: the profile it
// resolved from the actor document and the notes that arrived from it. The
// account itself is followed from here, so the button sends the follow
// request to the instance of the account.
import { t } from '../lib/i18n.js';

export interface RemoteProfilePageProps {
  domain: string;
  username: string;
  currentUser?: { username: string } | null;
}

interface RemoteProfileResponse {
  actor?: {
    actor_url: string;
    preferred_username: string | null;
    display_name: string | null;
    icon_url: string | null;
    domain: string | null;
  };
  following?: boolean;
  follow_state?: string | null;
  posts?: Array<{
    id: string;
    text: string;
    created_at: string;
    fresh_count?: number;
    reload_count?: number;
    reply_count?: number;
  }>;
}

export function createRemoteProfilePage({ domain, username, currentUser }: RemoteProfilePageProps) {
  const container = document.createElement('div');
  container.className = 'profile-page remote-profile-page';

  // Top bar with back button
  const topBar = document.createElement('div');
  topBar.className = 'profile-topbar';

  const backBtn = document.createElement('button');
  backBtn.className = 'profile-back-button';
  backBtn.textContent = '←';
  backBtn.addEventListener('click', () => window.history.back());
  topBar.appendChild(backBtn);

  const topTitle = document.createElement('span');
  topTitle.className = 'profile-topbar-title';
  topTitle.textContent = `@${username}@${domain}`;
  topBar.appendChild(topTitle);

  container.appendChild(topBar);

  // Header
  const header = document.createElement('div');
  header.className = 'profile-header';

  const avatarSection = document.createElement('div');
  avatarSection.className = 'profile-avatar-section';

  const avatar = document.createElement('div');
  avatar.className = 'profile-avatar fx-display';
  avatar.textContent = username.charAt(0).toUpperCase();

  const info = document.createElement('div');
  info.className = 'profile-info';

  const displayName = document.createElement('div');
  displayName.className = 'profile-display-name fx-display';
  displayName.textContent = t('profile.loading');

  const handle = document.createElement('div');
  handle.className = 'profile-username';
  handle.textContent = `@${username}@${domain}`;

  const bio = document.createElement('div');
  bio.className = 'profile-bio';

  const statsRow = document.createElement('div');
  statsRow.className = 'profile-stats';

  const postsStat = document.createElement('div');
  postsStat.className = 'profile-stat';
  const postsCount = document.createElement('span');
  postsCount.textContent = '0';
  const postsLabel = document.createElement('span');
  postsLabel.textContent = t('remote_profile.posts');
  postsStat.appendChild(postsCount);
  postsStat.appendChild(postsLabel);
  statsRow.appendChild(postsStat);

  const followButton = document.createElement('button');
  followButton.className = 'profile-follow-button';
  followButton.textContent = t('common.loading');
  followButton.style.display = 'none';

  info.appendChild(displayName);
  info.appendChild(handle);
  info.appendChild(bio);
  info.appendChild(statsRow);
  info.appendChild(followButton);

  avatarSection.appendChild(avatar);
  avatarSection.appendChild(info);
  header.appendChild(avatarSection);
  container.appendChild(header);

  // The notes that arrived from the account
  const postsContainer = document.createElement('div');
  postsContainer.className = 'timeline-container';
  container.appendChild(postsContainer);

  let following = false;

  const updateFollowButton = () => {
    if (!currentUser) {
      followButton.textContent = t('profile.following');
      return;
    }
    followButton.textContent = following ? t('profile.unfollowing') : t('profile.following');
  };

  followButton.addEventListener('click', async () => {
    if (!currentUser) {
      window.location.href = '/login';
      return;
    }
    followButton.disabled = true;
    try {
      const response = await fetch('/api/remote-follow', {
        method: following ? 'DELETE' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: `${username}@${domain}` }),
      });
      if (response.ok) {
        following = !following;
        updateFollowButton();
      }
    } catch {
      // the button keeps its state
    } finally {
      followButton.disabled = false;
    }
  });

  const renderPosts = (posts: RemoteProfileResponse['posts']) => {
    postsContainer.innerHTML = '';
    if (!posts || posts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'timeline-empty';
      empty.textContent = t('remote_profile.empty');
      postsContainer.appendChild(empty);
      return;
    }
    for (const post of posts) {
      const card = document.createElement('div');
      card.className = 'post-card';

      const author = document.createElement('div');
      author.className = 'post-author';
      author.textContent = `@${username}@${domain}`;

      const text = document.createElement('div');
      text.className = 'post-text';
      text.textContent = post.text;

      const meta = document.createElement('div');
      meta.className = 'post-meta';
      meta.textContent = new Date(post.created_at).toLocaleString();

      card.appendChild(author);
      card.appendChild(text);
      card.appendChild(meta);
      postsContainer.appendChild(card);
    }
  };

  const load = async () => {
    try {
      const response = await fetch(`/api/remote/actors/${encodeURIComponent(domain)}/${encodeURIComponent(username)}`);
      if (!response.ok) {
        displayName.textContent = t('remote_profile.not_found');
        return;
      }
      const data = (await response.json()) as RemoteProfileResponse;
      const actor = data.actor;
      if (actor?.display_name) displayName.textContent = actor.display_name;
      else displayName.textContent = `@${username}@${domain}`;

      if (actor?.icon_url) {
        const image = document.createElement('img');
        image.className = 'profile-avatar-image';
        image.src = actor.icon_url;
        image.alt = actor.display_name ?? username;
        avatar.textContent = '';
        avatar.appendChild(image);
      }

      following = Boolean(data.following);
      followButton.style.display = '';
      updateFollowButton();

      const posts = data.posts ?? [];
      postsCount.textContent = String(posts.length);
      renderPosts(posts);
    } catch {
      displayName.textContent = t('remote_profile.not_found');
    }
  };

  void load();

  return {
    getElement: () => container,
    destroy: () => {},
  };
}
