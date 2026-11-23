<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import { onMount, tick } from 'svelte';
import type { Post } from '../../../../shared/types/post.ts';
import type { Game } from '../../../types/game.js';
import { formatCount } from '../../format.ts';
import { t } from '../../i18n.ts';
import { registerModal } from '../../modal-state.ts';
import { iconHtml } from '../../post/icon-html.ts';
import { getReplyStyle } from '../../settings.ts';
import { buildTree } from '../../thread.ts';
import PostCard from '../PostCard.svelte';
import ReplyComposer from '../ReplyComposer.svelte';
import ArcadeReplyNode from './ArcadeReplyNode.svelte';

interface Props {
  game: Game;
  sandboxOrigin: string;
  currentUser: { username: string; id: string; display_name?: string; avatar_key?: string } | null;
  onClose: () => void;
  onReplyCount: (count: number) => void;
  onReplyCreated: (reply: Post) => void;
}

let { game, sandboxOrigin, currentUser, onClose, onReplyCount, onReplyCreated }: Props = $props();

type Entry =
  | { key: string; kind: 'flat'; post: Post; index?: number }
  | { key: string; kind: 'tree'; node: ReturnType<typeof buildTree>[number] };

let listEl: HTMLDivElement;
let loading = $state(true);
let error = $state(false);
let replies = $state<Post[]>([]);
let indexMap = $state(new Map<string, number>());
let replyStyle = $state<'2ch' | 'twitter'>('2ch');
let replyCount = $state(game.replyCount ?? 0);
let generation = 0;

const entries = $derived.by((): Entry[] => {
  if (replyStyle === 'twitter') {
    return buildTree(replies).map((node) => ({ key: node.post.id, kind: 'tree', node }));
  }
  return replies.map((post) => ({
    key: post.id,
    kind: 'flat',
    post,
    index: indexMap.get(post.id),
  }));
});

const headerTitle = $derived(`${t('thread_view.title')} (${formatCount(replyCount)})`);

onMount(() => {
  const unregister = registerModal();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onClose();
  };
  document.addEventListener('keydown', onKeyDown);
  void loadThread();

  return () => {
    generation += 1;
    document.removeEventListener('keydown', onKeyDown);
    unregister();
  };
});

async function loadThread(scrollToPostId?: string): Promise<void> {
  const mine = ++generation;
  loading = true;
  error = false;
  try {
    const response = await fetch(`/api/posts/${game.postId}/thread`);
    if (!response.ok) throw new Error('Failed to load comments');
    const data = (await response.json()) as { root: Post; replies: Post[] };
    if (mine !== generation) return;

    const map = new Map<string, number>();
    data.replies.forEach((post, index) => {
      map.set(post.id, index + 1);
    });
    replyStyle = getReplyStyle();
    indexMap = map;
    replies = data.replies;
    replyCount = data.replies.length;
    loading = false;
    onReplyCount(replyCount);

    if (scrollToPostId) {
      const index = map.get(scrollToPostId);
      if (index !== undefined) {
        await tick();
        listEl?.querySelector(`[data-post-index="${index}"]`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }
    }
  } catch {
    if (mine !== generation) return;
    replies = [];
    loading = false;
    error = true;
  }
}

function handleReplyCreated(reply: Post): void {
  onReplyCreated(reply);
  void loadThread(reply.id);
}

function handleListClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const refLink = target?.closest('.post-ref-link') as HTMLElement | null;
  if (!refLink) return;
  event.preventDefault();
  const index = refLink.dataset.postIndex;
  if (!index) return;
  listEl?.querySelector(`[data-post-index="${index}"]`)?.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  });
}
</script>

<div
  class="arcade-comments-overlay"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}
>
  <div class="arcade-comments-dialog" role="dialog" aria-modal="true" aria-labelledby="arcade-comments-title">
    <div class="arcade-comments-header">
      <span id="arcade-comments-title">{headerTitle}</span>
      <button type="button" class="arcade-comments-close" aria-label={t('common.close')} onclick={onClose}>
        {@html iconHtml('close', 18)}
      </button>
    </div>

    <div class="arcade-comments-composer">
      <ReplyComposer
        postId={game.postId}
        {sandboxOrigin}
        {currentUser}
        onReplyCreated={handleReplyCreated}
        onCancel={() => {}}
      />
    </div>

    <div class="arcade-comments-list" bind:this={listEl} onclick={handleListClick}>
      {#if loading}
        <div class="arcade-comments-status">{t('common.loading')}</div>
      {:else if error}
        <div class="arcade-comments-status arcade-comments-error">{t('common.error')}</div>
      {:else}
        <div class="replies-header">
          {t('thread.replies_header', { count: formatCount(replyCount) })}
        </div>
        {#if entries.length === 0}
          <div class="arcade-comments-status">No comments yet</div>
        {/if}
        {#each entries as entry (entry.key)}
          {#if entry.kind === 'flat'}
            <PostCard
              post={entry.post}
              {sandboxOrigin}
              {currentUser}
              depth={entry.post.depth}
              postIndex={entry.index}
              enablePostRefs
              disableNavigation
              onReplyCreated={handleReplyCreated}
            />
          {:else}
            <ArcadeReplyNode
              node={entry.node}
              {sandboxOrigin}
              {currentUser}
              {indexMap}
              onThreadChanged={() => void loadThread()}
            />
          {/if}
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .arcade-comments-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
  }

  .arcade-comments-dialog {
    display: flex;
    flex-direction: column;
    width: 90%;
    max-width: 500px;
    max-height: 80vh;
    border-radius: 12px;
    background: var(--bg-primary);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  }

  .arcade-comments-header {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.95rem;
    font-weight: 600;
  }

  .arcade-comments-close {
    display: inline-flex;
    align-items: center;
    padding: 0.25rem;
    border: 0;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
  }

  .arcade-comments-composer {
    flex-shrink: 0;
  }

  .arcade-comments-list {
    flex: 1;
    padding: 0.5rem 0;
    overflow-y: auto;
  }

  .arcade-comments-status {
    padding: 2rem;
    color: var(--text-muted);
    font-size: 0.85rem;
    text-align: center;
  }

  .arcade-comments-error {
    color: var(--danger-text);
  }

  .replies-header {
    margin: 0 1rem 0.5rem;
    color: var(--text-muted);
    font-size: 0.9rem;
    font-weight: normal;
  }
</style>
