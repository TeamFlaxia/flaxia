<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import { t } from '../../i18n.ts';
import { iconHtml } from '../../post/icon-html.ts';

interface Props {
  onBack?: () => void;
  onUpload: () => void;
  onTutorial: () => void;
}

let { onBack, onUpload, onTutorial }: Props = $props();
</script>

<header class="arcade-header">
  {#if onBack}
    <button type="button" class="arcade-back-btn" title={t('arcade.back')} onclick={onBack}>
      {t('arcade.back')}
    </button>
  {/if}

  <div class="arcade-header-title-group">
    <h1 class="arcade-header-title">
      {@html iconHtml('arcade', 18)}
      <span class="arcade-header-title-text">{t('arcade.title')}</span>
    </h1>
  </div>

  <div class="arcade-header-spacer"></div>
  <div class="arcade-header-actions">
    <button
      type="button"
      class="arcade-header-action"
      data-action="upload"
      title={t('arcade.upload_title')}
      onclick={onUpload}
    >
      {t('arcade.upload_btn')}
    </button>
    <button type="button" class="arcade-header-action" data-action="tutorial" title="Tutorial" onclick={onTutorial}>
      {t('arcade.tutorial_btn')}
    </button>
  </div>
</header>
