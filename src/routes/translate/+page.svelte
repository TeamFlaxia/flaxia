<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../lib/svelte/ShellLayout.svelte';
import TranslatePage from '../../lib/svelte/TranslatePage.svelte';
</script>

<ShellLayout navProps={{ activeItem: 'translate' }}>
  <TranslatePage />
</ShellLayout>
