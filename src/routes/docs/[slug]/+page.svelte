<script lang="ts">
import DocsPage from '../../../lib/svelte/DocsPage.svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<DocsPage {data} />
