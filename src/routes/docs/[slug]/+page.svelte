<script lang="ts">
import { page } from '$app/state';
import DocsPage from '../../../lib/svelte/DocsPage.svelte';
</script>

<DocsPage slug={page.params.slug} />
