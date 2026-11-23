<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// Native offline game downloads summary. The sync controller lives in
// `src/lib/native-offline-games.ts`; this section only renders its state.
import { onMount } from 'svelte';
import { t } from '../i18n.ts';
import { offlineGames } from '../native-offline-games.ts';
import { isOffline } from '../offline-status.ts';

let status = $state('');
let retryDisabled = $state(false);
let destroyed = false;

async function refresh(): Promise<void> {
  try {
    const saved = (await offlineGames?.list()) ?? [];
    if (destroyed) return;
    const states = [...(offlineGames?.states.values() ?? [])];
    status = t('offline_games.status', {
      saved: saved.length,
      downloading: states.filter((state) => state === 'downloading').length,
      errors: states.filter((state) => state === 'error').length,
    });
    retryDisabled = isOffline() || states.includes('downloading');
  } catch {
    if (!destroyed) status = t('offline_games.storage_error');
  }
}

onMount(() => {
  void refresh();
  window.addEventListener('flaxiaDownloadsChanged', refresh);
  window.addEventListener('online', refresh);
  window.addEventListener('offline', refresh);
  window.addEventListener('flaxiaConnectivityChange', refresh);
  return () => {
    destroyed = true;
    window.removeEventListener('flaxiaDownloadsChanged', refresh);
    window.removeEventListener('online', refresh);
    window.removeEventListener('offline', refresh);
    window.removeEventListener('flaxiaConnectivityChange', refresh);
  };
});
</script>

<section class="offline-downloads" style="padding:16px;border-bottom:1px solid var(--border);">
  <p role="status">{status}</p>
  <p>{t('offline_games.hint')}</p>
  <button type="button" disabled={retryDisabled} onclick={() => void offlineGames?.sync()}>
    {t('offline_games.retry')}
  </button>
</section>
