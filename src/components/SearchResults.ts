import { t } from '../lib/i18n.js';
import { registerModal } from '../lib/modal-state.js';

export interface SearchResultsProps {
  query: string;
  posts: any[];
  users: any[];
  type?: 'posts' | 'users' | 'arcade';
  onClose: () => void;
}

export function createSearchResults(props: SearchResultsProps): HTMLElement {
  const unregister = registerModal();
  const container = document.createElement('div');
  container.className = 'search-results-overlay';
  container.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  `;

  const modal = document.createElement('div');
  modal.className = 'search-results-modal';
  modal.style.cssText = `
    background: var(--bg-primary);
    border-radius: 0.5rem;
    max-width: 600px;
    width: 100%;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  `;

  // Header
  const header = document.createElement('div');
  header.className = 'search-results-header';
  header.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem;
    border-bottom: 1px solid var(--border);
  `;

  const title = document.createElement('h3');
  title.textContent = t('search.results_for', { query: props.query });
  title.style.cssText = `
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text-primary);
  `;

  const closeBtn = document.createElement('button');
  closeBtn.textContent = t('search.close');
  closeBtn.style.cssText = `
    background: none;
    border: none;
    font-size: 1.25rem;
    cursor: pointer;
    color: var(--text-muted);
    padding: 0.25rem;
  `;
  closeBtn.onclick = props.onClose;

  header.appendChild(title);
  header.appendChild(closeBtn);

  // Content
  const content = document.createElement('div');
  content.className = 'search-results-content';
  content.style.cssText = `
    padding: 1rem;
  `;

  // Users section
  if (props.users.length > 0) {
    const usersSection = document.createElement('div');
    usersSection.className = 'search-results-section';

    const usersTitle = document.createElement('h4');
    usersTitle.style.cssText = 'margin: 0 0 1rem 0; font-size: 1rem; font-weight: 600; color: var(--text-primary);';
    usersTitle.textContent = t('search.users');
    usersSection.appendChild(usersTitle);

    props.users.forEach((user) => {
      const userItem = document.createElement('div');
      userItem.className = 'search-result-user';
      userItem.style.cssText = `
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.75rem;
        border-radius: 0.25rem;
        cursor: pointer;
        transition: background-color 0.2s ease;
      `;
      userItem.onmouseover = () => (userItem.style.background = 'var(--bg-secondary)');
      userItem.onmouseout = () => (userItem.style.background = 'transparent');

      // Navigate to user profile on click
      userItem.onclick = () => {
        // Use SPA navigation instead of full page reload
        window.history.pushState({ username: user.username }, '', `/profile/${user.username}`);
        // Dispatch custom event to trigger SPA navigation
        window.dispatchEvent(
          new CustomEvent('spaNavigate', {
            detail: { view: 'profile', username: user.username },
          }),
        );
        props.onClose();
      };

      const avatar = document.createElement('div');
      avatar.className = 'search-result-avatar';
      avatar.style.cssText = `
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: var(--accent);
        color: var(--bg-primary);
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: bold;
        font-size: 0.875rem;
      `;
      avatar.textContent = user.display_name?.[0]?.toUpperCase() || user.username[0].toUpperCase();

      const userInfo = document.createElement('div');

      const usernameEl = document.createElement('div');
      usernameEl.style.cssText = 'font-weight: 600; color: var(--text-primary);';
      usernameEl.textContent = `@${user.username}`;

      const displayNameEl = document.createElement('div');
      displayNameEl.style.cssText = 'font-size: 0.875rem; color: var(--text-muted);';
      displayNameEl.textContent = user.display_name || '';

      userInfo.appendChild(usernameEl);
      userInfo.appendChild(displayNameEl);

      userItem.appendChild(avatar);
      userItem.appendChild(userInfo);
      usersSection.appendChild(userItem);
    });

    content.appendChild(usersSection);
  }

  // Posts section
  if (props.posts.length > 0) {
    const postsSection = document.createElement('div');
    postsSection.className = 'search-results-section';
    postsSection.style.cssText = `
      margin-top: ${props.users.length > 0 ? '2rem' : '0'};
    `;

    const postsTitle = document.createElement('h4');
    postsTitle.style.cssText = 'margin: 0 0 1rem 0; font-size: 1rem; font-weight: 600; color: var(--text-primary);';
    postsTitle.textContent = props.type === 'arcade' ? t('search.arcade_games') : t('search.posts');
    postsSection.appendChild(postsTitle);

    props.posts.forEach((post) => {
      const postItem = document.createElement('div');
      postItem.className = 'search-result-post';
      postItem.style.cssText = `
        padding: 1rem;
        border: 1px solid var(--border);
        border-radius: 0.25rem;
        margin-bottom: 0.75rem;
        cursor: pointer;
        transition: background-color 0.2s ease;
      `;
      postItem.onmouseover = () => (postItem.style.background = 'var(--bg-secondary)');
      postItem.onmouseout = () => (postItem.style.background = 'transparent');

      // Navigate to thread on click
      postItem.onclick = () => {
        // Use SPA navigation instead of full page reload
        window.history.pushState({ postId: post.id }, '', `/thread/${post.id}`);
        // Dispatch custom event to trigger SPA navigation
        window.dispatchEvent(
          new CustomEvent('spaNavigate', {
            detail: { view: 'thread', postId: post.id },
          }),
        );
        props.onClose();
      };

      const postHeader = document.createElement('div');
      postHeader.style.cssText = `
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 0.5rem;
      `;

      const postUser = document.createElement('span');
      postUser.style.cssText = 'font-weight: 600; color: var(--text-primary);';
      postUser.textContent = `@${post.username}`;

      const postDate = document.createElement('span');
      postDate.style.cssText = 'font-size: 0.75rem; color: var(--text-muted);';
      postDate.textContent = new Date(post.created_at).toLocaleDateString();

      postHeader.appendChild(postUser);
      postHeader.appendChild(postDate);

      const postText = document.createElement('div');
      postText.style.cssText = `
        color: var(--text-primary);
        line-height: 1.4;
        font-family: inherit;
        font-size: 0.875rem;
      `;
      postText.textContent = post.text;

      // If arcade, show a small badge
      if (props.type === 'arcade' || post.swf_key || post.payload_key) {
        const badge = document.createElement('span');
        badge.style.cssText =
          'margin-left: 0.5rem; padding: 0.1rem 0.4rem; background: var(--accent); color: white; border-radius: 4px; font-size: 0.7rem; vertical-align: middle;';
        badge.textContent = post.swf_key
          ? t('search.media_flash')
          : post.payload_key?.startsWith('dos/')
            ? t('search.media_dos')
            : t('search.media_game');
        postHeader.appendChild(badge);
      }

      postItem.appendChild(postHeader);
      postItem.appendChild(postText);
      postsSection.appendChild(postItem);
    });

    content.appendChild(postsSection);
  }

  // No results
  if (props.posts.length === 0 && props.users.length === 0) {
    content.replaceChildren();
    const empty = document.createElement('div');
    empty.style.cssText =
      "text-align: center; padding: 2rem; color: var(--text-muted); font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;";
    empty.textContent = t('search.no_results', { query: props.query });
    content.appendChild(empty);
  }

  modal.appendChild(header);
  modal.appendChild(content);
  container.appendChild(modal);

  // Close on overlay click
  container.onclick = (e) => {
    if (e.target === container) {
      unregister();
      props.onClose();
    }
  };

  return container;
}
