<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import LeftNav from './LeftNav.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import RightPanel from './RightPanel.svelte';

// Standalone shell slot for F6-F8 pages. The legacy three-column classes and
// role="main" landmark are kept so CSS and accessibility behave identically.
let {
  // biome-ignore lint/correctness/noUnusedVariables: Svelte snippet used in markup
  children,
  // biome-ignore lint/correctness/noUnusedVariables: Svelte prop used in markup
  navProps = {},
  // biome-ignore lint/correctness/noUnusedVariables: Svelte prop used in markup
  showRightPanel = true,
}: {
  children: import('svelte').Snippet;
  navProps?: Record<string, unknown>;
  showRightPanel?: boolean;
} = $props();
</script>

<div class="main-container">
  <LeftNav props={navProps} />
  <div class="main-content" role="main">{@render children()}</div>
  {#if showRightPanel}
    <RightPanel />
  {/if}
</div>
