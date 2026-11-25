<script lang="ts">
import DocsPage from '../../lib/svelte/DocsPage.svelte';
import type { PageProps } from './$types';

// The universal load fetches the manifest and hands SSR-ready data to the page.
let { data }: PageProps = $props();
</script>

<DocsPage {data} />
