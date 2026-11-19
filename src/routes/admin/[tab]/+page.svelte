<script lang="ts">
import { page } from '$app/state';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import AdminView from '../../../lib/svelte/AdminView.svelte';

const tabs = ['analytics', 'alerts', 'hidden', 'users', 'ads', 'counter'];
// biome-ignore lint/correctness/noUnusedVariables: Svelte prop used in markup
const selected = tabs.includes(page.params.tab) ? (page.params.tab as 'alerts') : 'alerts';
</script>

<AdminView tab={selected} />
