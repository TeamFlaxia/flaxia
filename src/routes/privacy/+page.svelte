<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import LegacyPage from '../../lib/svelte/LegacyPage.svelte';

// biome-ignore lint/correctness/noUnusedVariables: Svelte shorthand prop in markup
const load = async () => {
  const { createLegalPage } = await import('../../components/LegalPage.ts');
  return createLegalPage({ type: 'privacy' });
};
</script>

<LegacyPage {load} />
