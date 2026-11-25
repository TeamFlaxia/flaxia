<script lang="ts">
import LegalPage from '../../lib/svelte/LegalPage.svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<LegalPage type="about" {data} />
