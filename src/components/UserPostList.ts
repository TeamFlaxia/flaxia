import { createInfiniteScroll } from '../lib/infinite-scroll.js';
import { createLoadingSpinner } from '../lib/loading-ui.js';
import { createPostUpdatedHandler } from '../lib/post-update.js';
import { Post } from '../types/post.js';
import { createPostCard } from './PostCard.js';

export interface CurrentUser {
  username: string;
  id: string;
  display_name?: string;
  avatar_key?: string;
}

export function createUserPostList(props: {
  username: string;
  sandboxOrigin: string;
  currentUser: CurrentUser | null;
  source?: 'posts' | 'freshs' | 'bookmarks';
  showPinOption?: boolean;
  pinnedPostId?: string | null;
  onTogglePin?: (postId: string) => void;
}): { getElement: () => HTMLElement; addPost: (post: Post) => void; destroy: () => void } {
  // State
  let posts: Post[] = [];
  let cursor: string | undefined;
  let hasMore = true;
  let loading = false;
  const postCards: Map<string, ReturnType<typeof createPostCard>> = new Map();

  // Create main container
  const container = document.createElement('div');
  container.className = 'user-post-list';

  // Create post list
  const postList = document.createElement('div');
  postList.className = 'post-list';
  container.appendChild(postList);

  // Create load more section
  const loadMoreContainer = document.createElement('div');
  loadMoreContainer.className = 'load-more-container';

  // Loading spinner (hidden by default, appended after sentinel)
  const loadingSpinner = createLoadingSpinner();
  loadingSpinner.style.textAlign = 'center';
  loadingSpinner.style.padding = '1rem';

  container.appendChild(loadMoreContainer);

  // Build a PostCard, threading pin options through
  const buildCard = (post: Post) =>
    createPostCard({
      post,
      sandboxOrigin: props.sandboxOrigin,
      currentUser: props.currentUser,
      depth: post.depth,
      enablePostRefs: true,
      showPinOption: props.showPinOption,
      pinned: props.showPinOption ? post.id === (props.pinnedPostId ?? '') : undefined,
      onTogglePin: props.onTogglePin,
      onDelete: (postId) => {
        posts = posts.filter((p) => p.id !== postId);
        postCards.delete(postId);
        renderPosts();
      },
    });

  // Render posts
  const renderPosts = () => {
    postList.innerHTML = '';

    if (posts.length === 0 && !loading) {
      const emptyState = document.createElement('p');
      emptyState.className = 'font-mono';
      postList.appendChild(emptyState);
      return;
    }

    posts.forEach((post) => {
      const postCard = buildCard(post);

      postCards.set(post.id, postCard);
      postList.appendChild(postCard.getElement());
    });
  };

  // Update loading spinner visibility
  const updateLoadingSpinner = () => {
    loadingSpinner.style.display = loading ? 'block' : 'none';
    infiniteScroll.sentinel.style.display = hasMore ? 'block' : 'none';
  };

  // Load initial posts
  const source = props.source ?? 'posts';
  const limit = 20;

  const fetchPosts = async (activeCursor?: string) => {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (activeCursor) params.set('cursor', activeCursor);

    let url: string;
    if (source === 'posts') {
      params.set('username', props.username);
      url = `/api/posts?${params.toString()}`;
    } else if (source === 'freshs') {
      url = `/api/freshs?${params.toString()}`;
    } else {
      url = `/api/bookmarks?${params.toString()}`;
    }

    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
      throw new Error('Failed to fetch posts');
    }

    const data = (await response.json()) as { posts: Post[]; nextCursor?: string | null };
    const fetched = data.posts ?? [];

    let next: string | undefined;
    let more: boolean;
    if (data.nextCursor !== undefined) {
      next = data.nextCursor || undefined;
      more = !!next;
    } else if (fetched.length > 0) {
      next = fetched[fetched.length - 1].created_at;
      more = fetched.length === limit;
    } else {
      next = undefined;
      more = false;
    }

    return { fetched, next, more };
  };

  // Load initial posts
  const loadInitialPosts = async () => {
    if (loading) return;

    loading = true;
    updateLoadingSpinner();

    try {
      const { fetched, next, more } = await fetchPosts();
      posts = fetched;
      cursor = next;
      hasMore = more;
      renderPosts();
    } catch (error) {
      console.error('Failed to load posts:', error);
    } finally {
      loading = false;
      updateLoadingSpinner();
    }
  };

  // Load more posts
  const loadMorePosts = async () => {
    if (loading || !hasMore || !cursor) return;

    loading = true;
    updateLoadingSpinner();

    try {
      const { fetched, next, more } = await fetchPosts(cursor);
      posts = [...posts, ...fetched];
      cursor = next;
      hasMore = more;
      renderPosts();
    } catch (error) {
      console.error('Failed to load more posts:', error);
    } finally {
      loading = false;
      updateLoadingSpinner();
    }
  };

  const infiniteScroll = createInfiniteScroll({
    onLoadMore: loadMorePosts,
    canLoadMore: () => !loading && hasMore && !!cursor,
  });
  loadMoreContainer.appendChild(loadingSpinner);
  loadMoreContainer.insertBefore(infiniteScroll.sentinel, loadingSpinner);

  // Listen for postUpdated events (fresh, bookmark, reply count changes)
  const postUpdatedHandler = createPostUpdatedHandler(postCards);
  window.addEventListener('postUpdated', postUpdatedHandler);

  // Load initial posts
  loadInitialPosts();

  return {
    getElement: () => container,
    addPost: (post) => {
      posts = [post, ...posts];
      postList.innerHTML = '';
      const card = buildCard(post);
      postCards.set(post.id, card);
      postList.appendChild(card.getElement());
      // Re-append existing cards
      for (let i = 1; i < posts.length; i++) {
        let card = postCards.get(posts[i].id);
        if (!card) {
          card = buildCard(posts[i]);
          postCards.set(posts[i].id, card);
        }
        postList.appendChild(card.getElement());
      }
    },
    destroy: () => {
      window.removeEventListener('postUpdated', postUpdatedHandler);
      infiniteScroll.disconnect();
      postCards.forEach((card) => void card.destroy());
      postCards.clear();
      container.remove();
    },
  };
}
