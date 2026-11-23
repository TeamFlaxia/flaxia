<script lang="ts">
import { t } from '../i18n.ts';

let { onclick }: { onclick: () => void } = $props();
</script>

<button
  type="button"
  class="post-menu-button"
  aria-label={t('post_actions.more_actions')}
  onclick={(event) => {
    event.stopPropagation();
    onclick();
  }}>⋯</button
>
