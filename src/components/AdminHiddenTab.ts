import { createConfirmDialog } from '../lib/confirm-dialog.js';
import { t } from '../lib/i18n.js';

export interface HiddenPost {
  id: string;
  user_id: string;
  username: string;
  display_name: string;
  text: string;
  created_at: string;
  hidden: number;
  category?: string;
}

export interface AdminHiddenTabProps {
  onNavigateToTab: (tab: 'alerts' | 'hidden' | 'users' | 'ads') => void;
}

export function createAdminHiddenTab({ onNavigateToTab }: AdminHiddenTabProps) {
  let element: HTMLElement;
  let posts: HiddenPost[] = [];

  // Create container immediately
  element = document.createElement('div');
  element.style.cssText = 'max-width: 800px;';

  const fetchHiddenPosts = async () => {
    try {
      const response = await fetch('/api/admin/posts/hidden', { credentials: 'include' });
      if (response.status === 403) {
        return null;
      }
      if (!response.ok) {
        throw new Error('Failed to fetch hidden posts');
      }
      const data = await response.json() as { posts: HiddenPost[] };
      return data.posts;
    } catch (error) {
      console.error('Fetch hidden posts error:', error);
      return [];
    }
  };

  const unhidePost = async (postId: string) => {
    try {
      const response = await fetch(`/api/admin/posts/${postId}/unhide`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('Failed to unhide post');
      }
      return true;
    } catch (error) {
      console.error('Unhide post error:', error);
      return false;
    }
  };

  const formatTimeAgo = (dateStr: string): string => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('time.just_now');
    if (diffMins < 60) return t('time.minutes_ago', { n: diffMins });
    if (diffHours < 24) return t('time.hours_ago', { n: diffHours });
    if (diffDays < 7) return t('time.days_ago', { n: diffDays });
    return date.toLocaleDateString();
  };

  const createPostRow = (post: HiddenPost) => {
    const row = document.createElement('div');
    row.style.cssText = `
      background: #1e293b;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 12px;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    `;

    const postId = document.createElement('span');
    postId.style.cssText = 'color: #94a3b8; font-size: 13px; font-family: monospace;';
    postId.textContent = `post_id: ${post.id}`;
    header.appendChild(postId);

    const username = document.createElement('span');
    username.style.cssText = 'color: #22c55e; font-size: 14px; font-weight: 500;';
    username.textContent = `@${post.username}`;
    header.appendChild(username);

    const category = document.createElement('span');
    category.style.cssText = 'color: #94a3b8; font-size: 14px;';
    category.textContent = post.category || 'unknown';
    header.appendChild(category);

    const time = document.createElement('span');
    time.style.cssText = 'color: #64748b; font-size: 13px; margin-left: auto;';
    time.textContent = formatTimeAgo(post.created_at);
    header.appendChild(time);

    row.appendChild(header);

    const text = document.createElement('div');
    text.style.cssText = `
      color: #cbd5e1;
      font-size: 14px;
      margin-bottom: 12px;
      line-height: 1.5;
    `;
    const truncatedText = post.text.length > 50 ? post.text.substring(0, 50) + '...' : post.text;
    text.textContent = t('admin_hidden.quoted_text', { text: truncatedText });
    row.appendChild(text);

    const actions = document.createElement('div');
    actions.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;';

    const viewBtn = document.createElement('button');
    viewBtn.textContent = t('admin_hidden.view');
    viewBtn.style.cssText = `
      background: #334155;
      color: #f1f5f9;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.2s;
    `;
    viewBtn.addEventListener('click', () => {
      window.open(`/posts/${post.id}`, '_blank');
    });
    actions.appendChild(viewBtn);

    const unhideBtn = document.createElement('button');
    unhideBtn.textContent = t('admin_hidden.unhide');
    unhideBtn.style.cssText = `
      background: #334155;
      color: #f1f5f9;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.2s;
    `;
    unhideBtn.addEventListener('click', async () => {
      const confirmed = await createConfirmDialog(t('admin_hidden.restore_confirm'));
      if (!confirmed) return;
      const success = await unhidePost(post.id);
      if (success) {
        posts = posts.filter((p) => p.id !== post.id);
        render();
      }
    });
    actions.appendChild(unhideBtn);

    row.appendChild(actions);

    return row;
  };

  const render = async () => {
    element.innerHTML = '';

    const title = document.createElement('h2');
    title.textContent = t('admin_hidden.title');
    title.style.cssText = `
      color: #f1f5f9;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 0.875rem;
      color: var(--text-muted);
    `;
    element.appendChild(title);

    if (posts.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = t('admin_hidden.empty');
      empty.style.cssText =
        'color: #64748b; font-size: 14px; padding: 24px; text-align: center; font-family: "Noto Sans", monospace, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;';
      empty.style.cssText = 'color: #64748b; font-size: 14px; padding: 24px; text-align: center;';
      element.appendChild(empty);
    } else {
      posts.forEach((post) => {
        element.appendChild(createPostRow(post));
      });
    }
  };

  const init = async () => {
    posts = (await fetchHiddenPosts()) || [];
    await render();
  };

  init();

  return {
    getElement: () => element,
    refresh: async () => {
      posts = (await fetchHiddenPosts()) || [];
      await render();
    },
    destroy: () => {
      if (element && element.parentNode) {
        element.parentNode.removeChild(element);
      }
    },
  };
}
