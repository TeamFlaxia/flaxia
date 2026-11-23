<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import type { Post } from '../../../../shared/types/post.ts';
import type { Game } from '../../../types/game.js';
import ArcadeCommentsPanel from './ArcadeCommentsPanel.svelte';
import ArcadeReportModal from './ArcadeReportModal.svelte';
import ArcadeTutorial from './ArcadeTutorial.svelte';

interface User {
  id: string;
  username: string;
  display_name?: string;
  avatar_key?: string;
}

interface Props {
  game: Game | undefined;
  sandboxOrigin: string;
  currentUser: User | null;
  commentOpen: boolean;
  reportOpen: boolean;
  tutorialOpen: boolean;
  onCloseComments: () => void;
  onCloseReport: () => void;
  onCloseTutorial: () => void;
  onReplyCount: (count: number) => void;
  onReplyCreated: (reply: Post) => void;
}

let {
  game,
  sandboxOrigin,
  currentUser,
  commentOpen,
  reportOpen,
  tutorialOpen,
  onCloseComments,
  onCloseReport,
  onCloseTutorial,
  onReplyCount,
  onReplyCreated,
}: Props = $props();
</script>

{#if commentOpen && game}
  <ArcadeCommentsPanel
    {game}
    {sandboxOrigin}
    {currentUser}
    onClose={onCloseComments}
    {onReplyCount}
    {onReplyCreated}
  />
{/if}

{#if reportOpen && game}
  <ArcadeReportModal postId={game.postId} onClose={onCloseReport} />
{/if}

{#if tutorialOpen}
  <ArcadeTutorial onClose={onCloseTutorial} />
{/if}
