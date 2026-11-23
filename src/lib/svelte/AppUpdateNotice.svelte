<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// Dismissible card recommending an app update; desktop Windows/Linux only.
import { type AppUpdateInfo, detectAppUpdatePlatform } from '../app-update.ts';
import { t } from '../i18n.ts';
import { iconHtml } from '../post/icon-html.ts';
import { appUpdateNoticeHref } from './app-update-notice-model.ts';

let { update, onDismiss }: { update: AppUpdateInfo; onDismiss: () => void } = $props();

const href = $derived(appUpdateNoticeHref(update, detectAppUpdatePlatform()));
</script>

<aside id="app-update-notice" class="app-update-notice" role="status" aria-live="polite">
  <span class="app-update-notice-icon">{@html iconHtml('reload', 20)}</span>
  <div class="app-update-notice-body">
    <strong class="app-update-notice-title">{t('app_update.title')}</strong>
    <span class="app-update-notice-message">
      {t('app_update.message', { version: update.latestVersion, current: update.currentVersion })}
    </span>
  </div>
  <div class="app-update-notice-actions">
    <a class="app-update-notice-action" href={href} target="_blank" rel="noopener noreferrer">
      {t('app_update.action')}
    </a>
    <button type="button" class="app-update-notice-dismiss" onclick={onDismiss}>
      {t('app_update.dismiss')}
    </button>
  </div>
</aside>
