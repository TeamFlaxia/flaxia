<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
interface Props {
  variant: 'zip' | 'flash';
  label: string;
  icon: string;
  onActivate: () => void;
}

let { variant, label, icon, onActivate }: Props = $props();

let effectiveLabel = $derived(label.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, ''));
let className = $derived(variant === 'zip' ? 'zip-execution-button' : 'execution-button');

function activate(event: Event): void {
  event.stopPropagation();
  onActivate();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  onActivate();
}
</script>

<div class={className} role="button" tabindex="0" aria-label={label} onclick={activate} onkeydown={onKeydown}>
  <span class="stage-launch-icon" aria-hidden="true">{icon}</span>
  <span class="stage-launch-label">{effectiveLabel}</span>
</div>
