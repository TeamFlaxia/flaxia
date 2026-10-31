import {
  APP_ANDROID_APK_URL,
  APP_PLAY_STORE_URL,
  APP_RELEASES_URL,
  type AppPlatform,
  orderAppPlatforms,
  recommendedAppPlatform,
} from '../lib/app-download.js';
import { type DevicePlatform, detectDevicePlatform } from '../lib/device-platform.js';
import { t } from '../lib/i18n.js';
import { type IconName, icon } from '../lib/icons.js';
import { createPageHeader } from '../lib/page-header.js';
import { updateMetaTags } from '../lib/seo-meta.js';

interface DownloadPageProps {
  device?: DevicePlatform;
}

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

function externalLink(href: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function createChip(options: {
  href: string;
  label: string;
  note: string;
  iconName: IconName;
  primary?: boolean;
}): HTMLAnchorElement {
  const chip = externalLink(options.href);
  chip.className = `download-chip${options.primary ? ' download-chip--primary' : ''}`;

  const labelRow = document.createElement('span');
  labelRow.className = 'download-chip-label';
  labelRow.appendChild(icon(options.iconName, { width: '16', height: '16' }));
  const label = document.createElement('span');
  label.textContent = options.label;
  labelRow.appendChild(label);

  const note = document.createElement('span');
  note.className = 'download-chip-note';
  note.textContent = options.note;

  chip.appendChild(labelRow);
  chip.appendChild(note);
  return chip;
}

function createPlatformCard(platform: AppPlatform, recommended: boolean): HTMLElement {
  const card = document.createElement('article');
  card.className = `download-card${recommended ? ' download-card--recommended' : ''}`;
  card.setAttribute('data-platform', platform);

  const header = document.createElement('div');
  header.className = 'download-card-header';

  const iconWrap = document.createElement('span');
  iconWrap.className = 'download-card-icon';
  iconWrap.appendChild(icon(PLATFORM_ICONS[platform], { width: '24', height: '24' }));

  const titleWrap = document.createElement('div');
  titleWrap.className = 'download-card-title-wrap';

  const title = document.createElement('h2');
  title.className = 'download-card-title';
  title.textContent = t(PLATFORM_LABEL_KEYS[platform]);

  const description = document.createElement('p');
  description.className = 'download-card-description';
  description.textContent = t(`app_download.${platform}_description`);

  titleWrap.appendChild(title);
  titleWrap.appendChild(description);
  header.appendChild(iconWrap);
  header.appendChild(titleWrap);

  if (recommended) {
    const badge = document.createElement('span');
    badge.className = 'download-card-badge';
    badge.textContent = t('app_download.recommended_badge');
    header.appendChild(badge);
  }

  const actions = document.createElement('div');
  actions.className = 'download-actions';

  if (platform === 'android') {
    actions.appendChild(
      createChip({
        href: APP_PLAY_STORE_URL,
        label: t('app_download.play_store'),
        note: t('app_download.play_store_note'),
        iconName: 'smartphone',
        primary: true,
      }),
    );
    actions.appendChild(
      createChip({
        href: APP_ANDROID_APK_URL,
        label: t('app_download.apk'),
        note: t('app_download.apk_note'),
        iconName: 'download',
      }),
    );
  } else {
    actions.appendChild(
      createChip({
        href: APP_RELEASES_URL,
        label: t('app_download.download_for', { platform: t(PLATFORM_LABEL_KEYS[platform]) }),
        note: t('app_download.github_note'),
        iconName: 'download',
        primary: recommended,
      }),
    );
  }

  card.appendChild(header);
  card.appendChild(actions);
  return card;
}

export function createDownloadPage({ device }: DownloadPageProps = {}) {
  const currentDevice = device ?? detectDevicePlatform();
  const recommended = recommendedAppPlatform(currentDevice);
  const recommendedLabel = recommended ? t(PLATFORM_LABEL_KEYS[recommended]) : null;

  const container = document.createElement('div');
  container.className = 'download-page';

  container.appendChild(
    createPageHeader({
      title: t('app_download.title'),
      subtitle: t('app_download.subtitle'),
      onBack: () => window.history.back(),
    }),
  );

  const content = document.createElement('div');
  content.className = 'download-content';

  const hero = document.createElement('section');
  hero.className = `download-hero${recommended ? ' download-hero--recommended' : ''}`;

  const heroTitle = document.createElement('h2');
  heroTitle.className = 'download-hero-title';
  heroTitle.textContent = recommendedLabel
    ? t('app_download.recommended_for_device', { platform: recommendedLabel })
    : t('app_download.available_for_devices');

  const heroBody = document.createElement('p');
  heroBody.className = 'download-hero-body';
  heroBody.textContent = t('app_download.hero_body');

  hero.appendChild(heroTitle);
  hero.appendChild(heroBody);
  content.appendChild(hero);

  for (const platform of orderAppPlatforms(currentDevice)) {
    content.appendChild(createPlatformCard(platform, platform === recommended));
  }

  const footnote = document.createElement('p');
  footnote.className = 'download-footnote';
  footnote.textContent = t('app_download.release_hint');

  const allReleases = externalLink(APP_RELEASES_URL);
  allReleases.className = 'download-all-releases';
  allReleases.textContent = `${t('app_download.all_releases')} →`;

  content.appendChild(footnote);
  content.appendChild(allReleases);
  container.appendChild(content);

  updateMetaTags({
    title: `Flaxia - ${t('app_download.title')}`,
    description: t('app_download.subtitle'),
    url: `${window.location.origin}/download`,
  });

  return {
    getElement: () => container,
    destroy: () => {},
  };
}
