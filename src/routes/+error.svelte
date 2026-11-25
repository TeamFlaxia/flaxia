<script lang="ts">
import { page } from '$app/state';

const status = $derived(page.status || 500);
// biome-ignore lint/correctness/noUnusedVariables: rendered in the markup below
const message = $derived(page.error?.message || (status === 404 ? 'Not Found' : 'Something went wrong'));
</script>

<svelte:head>
  <title>Flaxia - {status}</title>
  <meta name="description" content="Flaxia could not load this page ({status}). {message}" />
  <meta name="robots" content="noindex, nofollow" />
  <link rel="canonical" href="https://flaxia.app/home" />
</svelte:head>

<main class="main-content" aria-labelledby="error-heading">
  <div class="ssr-post">
    <h1 id="error-heading" class="section-title">{status} {status === 404 ? 'Not Found' : 'Error'}</h1>
    <p>{message}</p>
    <a class="nav-item" href="/home">Back to home</a>
  </div>
</main>
