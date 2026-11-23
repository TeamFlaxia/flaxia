<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
interface Props {
  message: string;
}

let { message }: Props = $props();
</script>

<div class="image-preview">
  <div
    class="image-preview-error"
    style="padding:2rem;text-align:center;color:var(--text-muted);font-size:0.875rem;border-radius:var(--radius-md);"
  >
    {message}
  </div>
</div>
