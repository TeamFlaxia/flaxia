<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import LeftNav from './LeftNav.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import RightPanel from './RightPanel.svelte';

// Standalone shell slot for F6/F7 pages. The legacy three-column classes and
// role="main" landmark are kept so CSS and accessibility behave identically.
// biome-ignore lint/correctness/noUnusedVariables: Svelte 5 props used in markup
let { children, navProps = {} }: { children: import('svelte').Snippet; navProps?: Record<string, unknown> } = $props();
</script>

<div class="main-container">
  <LeftNav props={navProps} />
  <div class="main-content" role="main">{@render children()}</div>
  <RightPanel />
</div>
