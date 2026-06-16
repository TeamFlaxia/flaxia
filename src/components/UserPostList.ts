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
      const postCard = createPostCard({
        post,
        sandboxOrigin: props.sandboxOrigin,
        currentUser: props.currentUser,
        depth: post.depth,
        enablePostRefs: true,
        onDelete: (postId) => {
          posts = posts.filter((p) => p.id !== postId);
          postCards.delete(postId);
          renderPosts();
        },
      });

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
  const loadInitialPosts = async () => {
    if (loading) return;

    loading = true;
    updateLoadingSpinner();

    try {
      const params = new URLSearchParams();
      params.set('username', props.username);
      params.set('limit', '20');

      const response = await fetch(`/api/posts?${params.toString()}`, {
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to fetch posts');
      }

      const data = (await response.json()) as { posts: Post[] };
      posts = data.posts;

      if (data.posts.length > 0) {
        cursor = data.posts[data.posts.length - 1].created_at;
      }

      hasMore = data.posts.length === 20;
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
      const params = new URLSearchParams();
      params.set('username', props.username);
      params.set('limit', '20');
      params.set('cursor', cursor);

      const response = await fetch(`/api/posts?${params.toString()}`, {
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to fetch more posts');
      }

      const data = (await response.json()) as { posts: Post[] };
      posts = [...posts, ...data.posts];

      if (data.posts.length > 0) {
        cursor = data.posts[data.posts.length - 1].created_at;
      }

      hasMore = data.posts.length === 20;
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
      const card = createPostCard({
        post,
        sandboxOrigin: props.sandboxOrigin,
        currentUser: props.currentUser,
        depth: post.depth,
        enablePostRefs: true,
        onDelete: (postId) => {
          posts = posts.filter((p) => p.id !== postId);
          postCards.delete(postId);
          renderPosts();
        },
      });
      postCards.set(post.id, card);
      postList.appendChild(card.getElement());
      // Re-append existing cards
      for (let i = 1; i < posts.length; i++) {
        let card = postCards.get(posts[i].id);
        if (!card) {
          card = createPostCard({
            post: posts[i],
            sandboxOrigin: props.sandboxOrigin,
            currentUser: props.currentUser,
            depth: posts[i].depth,
            enablePostRefs: true,
            onDelete: (postId) => {
              posts = posts.filter((p) => p.id !== postId);
              postCards.delete(postId);
              renderPosts();
            },
          });
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
