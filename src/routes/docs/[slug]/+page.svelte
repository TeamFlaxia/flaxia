<script lang="ts">
import { page } from '$app/state';

// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import LegacyPage from '../../../lib/svelte/LegacyPage.svelte';

// biome-ignore lint/correctness/noUnusedVariables: Svelte shorthand prop in markup
const load = async () => {
  const { createDocsPage } = await import('../../../components/DocsPage.ts');
  return createDocsPage({ slug: page.params.slug });
};
</script>

<LegacyPage {load} />
