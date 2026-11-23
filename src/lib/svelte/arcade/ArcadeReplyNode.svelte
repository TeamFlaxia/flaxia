<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import type { Post } from '../../../../shared/types/post.ts';
import type { PostNode } from '../../thread.ts';
import PostCard from '../PostCard.svelte';
import ArcadeReplyNode from './ArcadeReplyNode.svelte';

interface Props {
  node: PostNode;
  sandboxOrigin: string;
  currentUser: { username: string; id: string; display_name?: string; avatar_key?: string } | null;
  indexMap: Map<string, number>;
  onThreadChanged: () => void;
}

let { node, sandboxOrigin, currentUser, indexMap, onThreadChanged }: Props = $props();

function handleReplyCreated(_reply: Post): void {
  onThreadChanged();
}
</script>

<div class="arcade-reply-node">
  <PostCard
    post={node.post}
    {sandboxOrigin}
    {currentUser}
    depth={node.post.depth}
    postIndex={indexMap.get(node.post.id)}
    enablePostRefs
    disableNavigation
    onReplyCreated={handleReplyCreated}
  />
  {#each node.children as child (child.post.id)}
    <div class="arcade-reply-child">
      <ArcadeReplyNode
        node={child}
        {sandboxOrigin}
        {currentUser}
        {indexMap}
        {onThreadChanged}
      />
    </div>
  {/each}
</div>

<style>
  .arcade-reply-node {
    position: relative;
  }

  .arcade-reply-child {
    margin-left: 1rem;
    padding-left: 0.5rem;
    border-left: 1px solid var(--border);
  }
</style>
