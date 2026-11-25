<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import type { Post } from '../../../shared/types/post.ts';
import { formatCount } from '../format.ts';
import { t } from '../i18n.ts';
import { navigate } from '../navigation.ts';
import { getReplyStyle } from '../settings.ts';
import { signalSsrHandover } from '../ssr-handover.ts';
import {
  buildTree,
  mountReplyComposer,
  mountReplyNode,
  mountThreadPostCard,
  type PostNode,
  updateThreadMeta,
} from '../thread/adapters.ts';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from './ShellLayout.svelte';

interface Props {
  postId: string;
  sandboxOrigin: string;
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null;
  onBack?: () => void;
}
let { postId, sandboxOrigin, currentUser = null, onBack }: Props = $props();

type Entry = { key: string; kind: 'tree'; node: PostNode } | { key: string; kind: 'flat'; post: Post; index?: number };

let rootHost: HTMLDivElement;
let composerHost: HTMLDivElement;
let repliesHost: HTMLDivElement;
let rootCard: { update: (p: Partial<Post>) => void; destroy: () => void } | null = null;
let rootComposer: { focus: () => void; destroy: () => void } | null = null;
let nodeHandles: Array<{ destroy: () => void }> = [];
let cardHandles: Array<{ destroy: () => void }> = [];
let replies = $state<Post[]>([]);
let entries = $state<Entry[]>([]);
let loading = $state(true);
let errorMessage = $state('');
let composerOpen = $state(false);
let indexMap = new Map<string, number>();
let replyToggleHandler: ((event: Event) => void) | null = null;

function renderEntries(): void {
  const style = getReplyStyle();
  const next: Entry[] = [];
  if (style === 'twitter') {
    for (const node of buildTree(replies)) next.push({ key: node.post.id, kind: 'tree', node });
  } else {
    replies.forEach((post) => {
      next.push({ key: post.id, kind: 'flat', post, index: indexMap.get(post.id) });
    });
  }
  entries = next;
  queueMicrotask(mountEntries);
}

function mountEntries(): void {
  if (!repliesHost) return;
  nodeHandles.forEach((h) => {
    h.destroy();
  });
  cardHandles.forEach((h) => {
    h.destroy();
  });
  nodeHandles = [];
  cardHandles = [];
  repliesHost.replaceChildren();
  for (const entry of entries) {
    const host = document['createElement']('div');
    repliesHost.appendChild(host);
    if (entry.kind === 'tree') {
      nodeHandles.push(
        mountReplyNode(host, {
          node: entry.node,
          sandboxOrigin,
          currentUser,
          postIndexMap: indexMap,
          onReplyCreated: (reply) => addReply(reply),
        }),
      );
    } else {
      cardHandles.push(
        mountThreadPostCard(host, {
          post: entry.post,
          sandboxOrigin,
          currentUser,
          index: entry.index,
          disableNavigation: true,
          onReplyCreated: (reply) => addReply(reply),
        }),
      );
    }
  }
}

function addReply(reply: Post): void {
  if (replies.some((r) => r.id === reply.id)) return;
  replies = [...replies, reply];
  indexMap = new Map(replies.map((p, i) => [p.id, i + 1]));
  renderEntries();
}

function toggleComposer(): void {
  composerOpen = !composerOpen;
  if (composerOpen) queueMicrotask(() => rootComposer?.focus());
}

function handleRootReply(reply: Post): void {
  composerOpen = false;
  addReply(reply);
  rootCard?.update({ reply_count: replies.length });
}

async function loadThread(): Promise<void> {
  loading = true;
  errorMessage = '';
  try {
    const response = await fetch(`/api/posts/${postId}/thread`);
    if (!response.ok) throw new Error('Failed to load thread');
    const data = (await response.json()) as { root?: Post; replies?: Post[] };
    const root = data.root;
    if (!root) {
      errorMessage = t('thread.load_failed');
      return;
    }
    const threadReplies = Array.isArray(data.replies) ? data.replies : [];
    indexMap = new Map(threadReplies.map((p, i) => [p.id, i + 1]));

    if (rootHost) {
      rootCard = mountThreadPostCard(rootHost, {
        post: root,
        sandboxOrigin,
        currentUser,
        disableReplyComposer: true,
      });
      rootCard.update({ reply_count: threadReplies.length });
    }
    updateThreadMeta(root);
    if (composerHost) {
      rootComposer = mountReplyComposer(composerHost, {
        postId: root.id,
        sandboxOrigin,
        currentUser,
        onReplyCreated: handleRootReply,
        onCancel: () => (composerOpen = false),
      });
      replyToggleHandler = (event: Event) => {
        if ((event as CustomEvent).detail?.postId === root.id) toggleComposer();
      };
      rootHost.addEventListener('replyToggle', replyToggleHandler);
    }
    replies = threadReplies;
    renderEntries();
    signalSsrHandover();
  } catch {
    errorMessage = t('thread.load_failed');
  } finally {
    loading = false;
  }
}

onMount(() => void loadThread());
onDestroy(() => {
  if (replyToggleHandler) rootHost.removeEventListener('replyToggle', replyToggleHandler);
  rootCard?.destroy();
  rootComposer?.destroy();
  nodeHandles.forEach((h) => {
    h.destroy();
  });
  cardHandles.forEach((h) => {
    h.destroy();
  });
});
</script>

<ShellLayout navProps={{ activeItem: 'home', currentUser }}>
  <div class="thread-page">
    <div class="thread-top-section">
      <div class="thread-header thread-header--page">
        <button class="thread-back-button" type="button" onclick={() => (onBack ? onBack() : void navigate('/home'))}>{t('common.back')}</button>
        <h1>{t('thread.title') || 'Thread'}</h1>
      </div>
    </div>

    {#if errorMessage}
      <div class="thread-loading">{errorMessage}</div>
    {:else if loading}
      <div class="thread-loading">{t('common.loading')}</div>
    {/if}

    <div class="thread-root-post-container" bind:this={rootHost}></div>
    <div bind:this={composerHost} style="display:{composerOpen ? 'block' : 'none'};"></div>

    <div class="thread-replies">
      <div class="thread-replies-header">{t('thread.replies_header', { count: formatCount(replies.length) })}</div>
      <div bind:this={repliesHost}></div>
      {#if !loading && entries.length === 0}
        <div class="thread-replies-empty">{t('thread.no_replies') || ''}</div>
      {/if}
    </div>
  </div>
</ShellLayout>
