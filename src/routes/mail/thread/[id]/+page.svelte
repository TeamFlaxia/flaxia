<script lang="ts">
import { page } from '$app/state';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import MailView from '../../../../lib/svelte/MailView.svelte';
</script>

<MailView view="thread" threadId={page.params.id} />
