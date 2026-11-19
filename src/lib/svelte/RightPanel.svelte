<script lang="ts">
import { createRightPanel } from '../../components/RightPanel.ts';

let host: HTMLDivElement;
let panel: ReturnType<typeof createRightPanel> | null = null;

$effect(() => {
  if (!host) return;
  panel = createRightPanel();
  host.replaceChildren(panel.getElement());
  return () => panel?.destroy();
});
</script>

<div bind:this={host} style="display: contents"></div>
