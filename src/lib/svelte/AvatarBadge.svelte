<script lang="ts">
// Small SSR-safe badge. Mirrors `renderAvatarBadge` in functions/lib/render-html.ts
// without pulling the server renderer into the client bundle.
let { badgeType }: { badgeType?: string | null } = $props();
</script>

{#if badgeType === 'flaxia_plus'}
  <span class="ssr-avatar-badge" title="Flaxia+" aria-label="Flaxia+">
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="3"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    ><path d="M20 6 9 17l-5-5"></path></svg>
  </span>
{/if}
