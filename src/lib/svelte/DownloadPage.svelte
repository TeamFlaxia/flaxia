<script lang="ts">
import { onMount } from 'svelte';
import {
  APP_ANDROID_APK_URL,
  APP_PLAY_STORE_URL,
  APP_RELEASES_URL,
  type AppPlatform,
  orderAppPlatforms,
  recommendedAppPlatform,
  resolveWindowsMsiUrl,
} from '../../lib/app-download.ts';
import { type DevicePlatform, detectDevicePlatform } from '../../lib/device-platform.ts';
import { t } from '../../lib/i18n.ts';
import { type IconName, iconMarkup } from '../../lib/icons.ts';

const PLATFORM_ICONS: Record<AppPlatform, IconName> = {
  android: 'smartphone',
  windows: 'monitor',
  linux: 'terminal',
};
const PLATFORM_LABEL_KEYS: Record<AppPlatform, string> = {
  android: 'app_download.platform_android',
  windows: 'app_download.platform_windows',
  linux: 'app_download.platform_linux',
};

function iconHtml(name: IconName, size = 16): string {
  return iconMarkup(name, { width: String(size), height: String(size) });
}

// navigator is unavailable during SSR. Start neutral so the server HTML and
// the first client render agree, then adopt the real device in onMount.
let device = $state<DevicePlatform>('other');
const recommended = $derived(recommendedAppPlatform(device));
const recommendedLabel = $derived(recommended ? t(PLATFORM_LABEL_KEYS[recommended]) : null);
const platforms = $derived(orderAppPlatforms(device));
const heroTitle = $derived(
  recommendedLabel
    ? t('app_download.recommended_for_device', { platform: recommendedLabel })
    : t('app_download.available_for_devices'),
);
// Must match the canonical URL emitted by the root layout on every origin.
const canonicalUrl = 'https://flaxia.app/download';

let windowsUrl = $state(APP_RELEASES_URL);

onMount(() => {
  device = detectDevicePlatform();
  void resolveWindowsMsiUrl().then((url) => {
    if (url) windowsUrl = url;
  });
});
</script>

<svelte:head>
  <meta name="description" content={t('app_download.subtitle')} />
  <meta property="og:url" content={canonicalUrl} />
</svelte:head>

<div class="download-page">
  <div class="page-header">
    <button type="button" class="page-header-back" aria-label="Back" onclick={() => window.history.back()}>←</button>
    <div class="page-header-titles">
      <h1 class="page-header-title fx-display">{t('app_download.title')}</h1>
      <span class="page-header-subtitle">{t('app_download.subtitle')}</span>
    </div>
  </div>

  <div class="download-content">
    <section class="download-hero" class:download-hero--recommended={recommended}>
      <h2 class="download-hero-title">{heroTitle}</h2>
      <p class="download-hero-body">{t('app_download.hero_body')}</p>
    </section>

    {#each platforms as platform (platform)}
      {@const isRecommended = platform === recommended}
      <article class="download-card" class:download-card--recommended={isRecommended} data-platform={platform}>
        <div class="download-card-header">
          <span class="download-card-icon">{@html iconHtml(PLATFORM_ICONS[platform], 24)}</span>
          <div class="download-card-title-wrap">
            <h2 class="download-card-title">{t(PLATFORM_LABEL_KEYS[platform])}</h2>
            <p class="download-card-description">{t(`app_download.${platform}_description`)}</p>
          </div>
          {#if isRecommended}
            <span class="download-card-badge">{t('app_download.recommended_badge')}</span>
          {/if}
        </div>
        <div class="download-actions">
          {#if platform === 'android'}
            <a class="download-chip download-chip--primary" href={APP_PLAY_STORE_URL} target="_blank" rel="noopener noreferrer">
              <span class="download-chip-label">{@html iconHtml('smartphone')}<span>{t('app_download.play_store')}</span></span>
              <span class="download-chip-note">{t('app_download.play_store_note')}</span>
            </a>
            <a class="download-chip" href={APP_ANDROID_APK_URL} target="_blank" rel="noopener noreferrer">
              <span class="download-chip-label">{@html iconHtml('download')}<span>{t('app_download.apk')}</span></span>
              <span class="download-chip-note">{t('app_download.apk_note')}</span>
            </a>
          {:else if platform === 'windows'}
            <a class="download-chip" class:download-chip--primary={isRecommended} href={windowsUrl} target="_blank" rel="noopener noreferrer">
              <span class="download-chip-label">{@html iconHtml('download')}<span>{t('app_download.download_for', { platform: t(PLATFORM_LABEL_KEYS[platform]) })}</span></span>
              <span class="download-chip-note">{t('app_download.github_note')}</span>
            </a>
          {:else}
            <a class="download-chip" class:download-chip--primary={isRecommended} href={APP_RELEASES_URL} target="_blank" rel="noopener noreferrer">
              <span class="download-chip-label">{@html iconHtml('download')}<span>{t('app_download.download_for', { platform: t(PLATFORM_LABEL_KEYS[platform]) })}</span></span>
              <span class="download-chip-note">{t('app_download.github_note')}</span>
            </a>
          {/if}
        </div>
      </article>
    {/each}

    <p class="download-footnote">{t('app_download.release_hint')}</p>
    <a class="download-all-releases" href={APP_RELEASES_URL} target="_blank" rel="noopener noreferrer">
      {t('app_download.all_releases')} →
    </a>
  </div>
</div>
