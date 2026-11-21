<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { createSettingsPage } from '../../components/SettingsPage.ts';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from './ShellLayout.svelte';

interface Props {
  currentUser?: Record<string, unknown> | null;
  initialCategory?: string | null;
}
let { currentUser, initialCategory = null }: Props = $props();

let host: HTMLDivElement;
let handle: { destroy: () => void } | null = null;

onMount(() => {
  const page = createSettingsPage({ currentUser, initialCategory } as never);
  handle = page;
  host.appendChild(page.getElement());
});

onDestroy(() => handle?.destroy());
</script>

<div bind:this={host}></div>
