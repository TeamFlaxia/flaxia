<script lang="ts">
import type { Post } from '../../../shared/types/post.ts';
import { showSignInPrompt } from '../../components/SignInPrompt.ts';
import { navigate } from '../navigation.ts';
import type { PostNode } from '../thread.ts';
import PostCard from './PostCard.svelte';
import ReplyComposer from './ReplyComposer.svelte';
// Importing the component into itself is the Svelte 5 replacement for
// <svelte:self> when rendering nested replies.
import Self from './ReplyNode.svelte';

interface CurrentUser {
  username: string;
  id: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
}

interface Props {
  node: PostNode;
  sandboxOrigin: string;
  onReplyCreated: (newReply: Post) => void;
  currentUser?: CurrentUser | null;
  postIndexMap?: Map<string, number>;
}

let { node, sandboxOrigin, onReplyCreated, currentUser = null, postIndexMap }: Props = $props();

interface CardHandle {
  updatePost: (post: Partial<Post>) => void;
}

let card = $state<CardHandle>();
let children = $state<PostNode[]>([...node.children]);
let composerOpen = $state(false);
let expanded = $state(false);

const isNested = $derived(node.post.depth > 0);
const expandable = $derived(children.length > 0 && isNested);
const childrenVisible = $derived(children.length > 0 && (expanded || !isNested));
const nodeIndex = $derived(postIndexMap?.get(node.post.id));
const prefill = $derived(nodeIndex !== undefined ? `>>${nodeIndex} ` : undefined);

function toggleExpanded(): void {
  expanded = !expanded;
}

function toggleComposer(): void {
  if (composerOpen) {
    composerOpen = false;
    return;
  }
  if (!currentUser) {
    showSignInPrompt(
      'reply',
      () => {
        void navigate('/login');
      },
      () => {
        void navigate('/register');
      },
    );
    return;
  }

  // Other reply nodes close their composer on this bubbling event.
  document.dispatchEvent(new CustomEvent('replyComposerOpen', { detail: { postId: node.post.id } }));
  composerOpen = true;
}

function handleReplyCreated(reply: Post): void {
  composerOpen = false;
  children = [...children, { post: reply, children: [] }];
  if (isNested) expanded = true;
  card?.updatePost({ reply_count: (node.post.reply_count || 0) + 1 });
  onReplyCreated(reply);
}

function bubbleReply(reply: Post): void {
  onReplyCreated(reply);
}

$effect(() => {
  const closeOthers = (event: Event) => {
    const detail = (event as CustomEvent<{ postId?: string }>).detail;
    if (detail?.postId !== node.post.id) composerOpen = false;
  };
  document.addEventListener('replyComposerOpen', closeOthers);
  return () => document.removeEventListener('replyComposerOpen', closeOthers);
});
</script>

<div class="reply-node" class:reply-node--nested={isNested}>
  <div class="reply-node-row">
    {#if expandable}
      <button
        type="button"
        class="reply-expand-button"
        class:is-expanded={expanded}
        aria-expanded={expanded}
        onclick={toggleExpanded}>▶</button
      >
    {/if}

    <PostCard
      bind:this={card}
      post={node.post}
      {sandboxOrigin}
      {currentUser}
      depth={node.post.depth}
      postIndex={nodeIndex}
      enablePostRefs={true}
      stripLeadingPostRef={true}
      disableReplyComposer={true}
      onDelete={() => {}}
      onReplyToggle={toggleComposer}
    />
  </div>

  <div class="reply-composer-host" style="display: {composerOpen ? 'block' : 'none'};">
    <ReplyComposer
      postId={node.post.id}
      {sandboxOrigin}
      {currentUser}
      {prefill}
      onReplyCreated={handleReplyCreated}
      onCancel={() => (composerOpen = false)}
    />
  </div>

  {#if children.length > 0}
    <div class="reply-children" style="display: {childrenVisible ? 'block' : 'none'};">
      {#each children as child (child.post.id)}
        <Self node={child} {sandboxOrigin} {currentUser} {postIndexMap} onReplyCreated={bubbleReply} />
      {/each}
    </div>
  {/if}
</div>
