<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// Profile tab feed: paged post list with an infinite-scroll sentinel. The
// legacy adapter keeps the `createUserPostList` factory API.
import { onDestroy, onMount } from 'svelte';
import type { Post } from '../../../shared/types/post.ts';
import { t } from '../i18n.ts';
import { appendUniqueBy, uniqueBy } from '../unique.ts';
import UserPostCard from './UserPostCard.svelte';
import type { UserPostCardOptions } from './user-post-card.ts';
import { buildUserPostUrl, resolveUserPostPage, type UserPostSource } from './user-post-list-model.ts';

interface Props {
  username: string;
  sandboxOrigin: string;
  currentUser: UserPostCardOptions['currentUser'];
  source?: UserPostSource;
  showPinOption?: boolean;
  pinnedPostId?: string | null;
  onTogglePin?: (postId: string) => void;
}

let {
  username,
  sandboxOrigin,
  currentUser = null,
  source = 'posts',
  showPinOption = false,
  pinnedPostId = null,
  onTogglePin,
}: Props = $props();

const limit = 20;

let posts = $state<Post[]>([]);
let cursor: string | undefined;
let hasMore = $state(true);
let loading = $state(false);
let sentinel: HTMLDivElement;
let observer: IntersectionObserver | null = null;
let destroyed = false;

const cardOptions = $derived<UserPostCardOptions>({
  sandboxOrigin,
  currentUser,
  showPinOption,
  pinnedPostId,
  onTogglePin,
  onDelete: (postId) => {
    posts = posts.filter((post) => post.id !== postId);
  },
});

async function fetchPosts(activeCursor?: string) {
  const response = await fetch(buildUserPostUrl(source, username, activeCursor, limit), {
    credentials: 'include',
  });
  if (!response.ok) throw new Error('Failed to fetch posts');
  const data = (await response.json()) as { posts?: Post[]; nextCursor?: string | null };
  return resolveUserPostPage(data, limit);
}

async function loadInitialPosts(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    const page = await fetchPosts();
    if (destroyed) return;
    posts = uniqueBy(page.posts, (post) => post.id);
    cursor = page.next;
    hasMore = page.more;
  } catch (error) {
    console.error('Failed to load posts:', error);
  } finally {
    loading = false;
  }
}

async function loadMorePosts(): Promise<void> {
  if (loading || !hasMore || !cursor) return;
  loading = true;
  try {
    const page = await fetchPosts(cursor);
    if (destroyed) return;
    posts = appendUniqueBy(posts, page.posts, (post) => post.id);
    cursor = page.next;
    hasMore = page.more;
  } catch (error) {
    console.error('Failed to load more posts:', error);
  } finally {
    loading = false;
  }
}

/** Prepend a newly created post (profile composer). */
export function addPost(post: Post): void {
  if (posts.some((existing) => existing.id === post.id)) return;
  posts = [post, ...posts];
}

onMount(() => {
  void loadInitialPosts();
  if (typeof IntersectionObserver === 'undefined' || !sentinel) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) void loadMorePosts();
    },
    { root: null, rootMargin: '300px', threshold: 0.1 },
  );
  observer.observe(sentinel);
});

onDestroy(() => {
  destroyed = true;
  observer?.disconnect();
  observer = null;
});
</script>

<div class="post-list">
  {#each posts as post (post.id)}
    <UserPostCard {post} options={cardOptions} />
  {/each}
</div>
<div class="load-more-container">
  <div
    bind:this={sentinel}
    class="load-sentinel"
    style="height:100px;width:100%;display:{hasMore ? 'block' : 'none'};align-items:center;justify-content:center;"
  ></div>
  <div
    class="loading-spinner"
    style="text-align:center;padding:1rem;display:{loading ? 'block' : 'none'};"
  >
    <div class="spinner"></div>
    <span>{t('common.loading')}</span>
  </div>
</div>
<p class="font-mono" hidden={posts.length > 0 || loading}></p>
