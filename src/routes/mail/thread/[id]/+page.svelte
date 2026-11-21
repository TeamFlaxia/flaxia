<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: Svelte prop used in markup
import { page } from '$app/state';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import MailView from '../../../../lib/svelte/MailView.svelte';
</script>

{#key page.params.id}
  <MailView view="thread" threadId={page.params.id} />
{/key}
