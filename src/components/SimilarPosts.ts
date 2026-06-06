import { t } from '../lib/i18n.js';
import { Post } from '../types/post.js';
import { createPostCard } from './PostCard.js';

export interface SimilarPostsProps {
  postId: string;
  sandboxOrigin: string;
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null;
}

export class SimilarPosts {
  private container: HTMLElement;
  private props: SimilarPostsProps;
  private loading = false;

  constructor(props: SimilarPostsProps) {
    this.props = props;
    this.container = this.createElement();
    this.load();
  }

  private createElement(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'similar-posts';
    el.innerHTML = `
      <h3 style="padding: 1rem; font-size: 1rem; font-weight: 600; border-bottom: 1px solid var(--border); color: var(--text-primary);">
        ${t('post.recommended')}
      </h3>
      <div class="similar-posts-list"></div>
    `;
    return el;
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;

    const list = this.container.querySelector('.similar-posts-list') as HTMLElement;
    if (!list) return;

    try {
      const res = await fetch(`/api/posts/${this.props.postId}/similar?limit=5`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { posts: Post[] };
      const posts = data.posts || [];

      if (posts.length === 0) {
        list.innerHTML = `<p style="padding: 1rem; color: var(--text-muted); font-size: 0.875rem; text-align: center;">${t('post.no_recommended')}</p>`;
        return;
      }

      for (const post of posts) {
        const card = createPostCard({
          post,
          sandboxOrigin: this.props.sandboxOrigin,
          currentUser: this.props.currentUser,
        });
        list.appendChild(card.getElement());
      }
    } catch (err) {
      console.error('Failed to load similar posts:', err);
      list.innerHTML = `<p style="padding: 1rem; color: var(--text-muted); font-size: 0.875rem; text-align: center;">${t('common.error')}</p>`;
    } finally {
      this.loading = false;
    }
  }

  getElement(): HTMLElement {
    return this.container;
  }
}

export function createSimilarPosts(props: SimilarPostsProps): SimilarPosts {
  return new SimilarPosts(props);
}
