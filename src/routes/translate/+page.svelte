<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import LegacyShellPage from '../../lib/svelte/LegacyShellPage.svelte';

// biome-ignore lint/correctness/noUnusedVariables: Svelte shorthand prop in markup
const load = async () => {
  const { createTranslatePage } = await import('../../components/TranslatePage.ts');
  return createTranslatePage();
};
</script>

<LegacyShellPage {load} activeItem="translate" />
