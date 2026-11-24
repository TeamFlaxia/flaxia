<script lang="ts">
import { onMount } from 'svelte';
import { page } from '$app/state';
import { navigate } from '../../../lib/navigation.ts';
import SsrPostList from '../../../lib/svelte/SsrPostList.svelte';
import { getSessionUser } from '../../../lib/svelte/session.ts';
import ThreadPage from '../../../lib/svelte/ThreadPage.svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const ssrPosts = $derived(data.root ? [data.root, ...data.replies] : []);
let currentUser = $state<unknown>(null);
onMount(() => {
  currentUser = getSessionUser() ?? null;
});
</script>

{#key page.params.id}
  <ThreadPage
    postId={page.params.id ?? ''}
    sandboxOrigin={import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app'}
    currentUser={currentUser as never}
    onBack={() => void navigate('/home')}
  />
  <SsrPostList posts={ssrPosts} label="Thread" />
{/key}
