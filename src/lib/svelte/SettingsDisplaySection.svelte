<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { t } from '../i18n.ts';
import {
  getDataSaverMode,
  getReplyStyle,
  getShowNsfw,
  isBrowserSaveDataEnabled,
  isForYouExternalHidden,
  type ReplyStyle,
  setDataSaverMode,
  setForYouExternalMode,
  setReplyStyle,
  setShowNsfw,
} from '../settings.js';
import { getTheme, setTheme, type Theme } from '../theme.js';

const styles: Array<{ value: ReplyStyle; labelKey: string; descKey: string }> = [
  { value: 'twitter', labelKey: 'settings.reply_style_twitter', descKey: 'settings.reply_style_twitter_desc' },
  { value: '2ch', labelKey: 'settings.reply_style_2ch', descKey: 'settings.reply_style_2ch_desc' },
];

const themes: Array<{ value: Theme; labelKey: string; descKey: string }> = [
  { value: 'light', labelKey: 'settings.theme_light', descKey: 'settings.theme_light_desc' },
  { value: 'dark', labelKey: 'settings.theme_dark', descKey: 'settings.theme_dark_desc' },
  { value: 'system', labelKey: 'settings.theme_system', descKey: 'settings.theme_system_desc' },
];

let replyStyle = $state<ReplyStyle>(getReplyStyle());
let nsfw = $state(getShowNsfw());
let dataSaver = $state(getDataSaverMode() || isBrowserSaveDataEnabled());
let showForYouExternal = $state(!isForYouExternalHidden());
let theme = $state<Theme>(getTheme());
let message = $state('');

function saved(): void {
  message = t('settings.display_saved');
}

function chooseReplyStyle(value: ReplyStyle): void {
  replyStyle = value;
  setReplyStyle(value);
  saved();
}

function toggleNsfw(value: boolean): void {
  nsfw = value;
  setShowNsfw(value);
  saved();
}

function toggleDataSaver(value: boolean): void {
  dataSaver = value;
  setDataSaverMode(value);
  saved();
}

function toggleForYouExternal(value: boolean): void {
  showForYouExternal = value;
  setForYouExternalMode(value ? 'show' : 'hide');
  saved();
}

function chooseTheme(value: Theme): void {
  theme = value;
  setTheme(value);
  saved();
}
</script>

<h2>{t('settings.display')}</h2>

<div class="settings-choice-list">
  {#each styles as option (option.value)}
    <label class="settings-radio-card">
      <input
        type="radio"
        name="reply-style"
        class="settings-radio"
        value={option.value}
        checked={replyStyle === option.value}
        onchange={() => chooseReplyStyle(option.value)}
      />
      <div class="settings-radio-text">
        <span class="settings-radio-name">{t(option.labelKey)}</span>
        <span class="settings-radio-desc">{t(option.descKey)}</span>
      </div>
    </label>
  {/each}
</div>

<label class="settings-switch-row">
  <div class="settings-switch-text">
    <span class="settings-switch-name">{t('settings.nsfw')}</span>
    <span class="settings-switch-desc">{t('settings.nsfw_desc')}</span>
  </div>
  <input type="checkbox" class="settings-switch" checked={nsfw} onchange={(event) => toggleNsfw(event.currentTarget.checked)} />
</label>

<label class="settings-switch-row">
  <div class="settings-switch-text">
    <span class="settings-switch-name">{t('settings.data_saver')}</span>
    <span class="settings-switch-desc">{t('settings.data_saver_desc')}</span>
  </div>
  <input
    type="checkbox"
    class="settings-switch"
    checked={dataSaver}
    onchange={(event) => toggleDataSaver(event.currentTarget.checked)}
  />
</label>

<label class="settings-switch-row">
  <div class="settings-switch-text">
    <span class="settings-switch-name">{t('settings.foryou_external')}</span>
    <span class="settings-switch-desc">{t('settings.foryou_external_desc')}</span>
  </div>
  <input
    type="checkbox"
    class="settings-switch"
    checked={showForYouExternal}
    onchange={(event) => toggleForYouExternal(event.currentTarget.checked)}
  />
</label>

<div class="fx-label settings-subheading">{t('settings.theme')}</div>
<div class="settings-choice-list">
  {#each themes as option (option.value)}
    <label class="settings-radio-card">
      <input
        type="radio"
        name="theme"
        class="settings-radio"
        value={option.value}
        checked={theme === option.value}
        onchange={() => chooseTheme(option.value)}
      />
      <div class="settings-radio-text">
        <span class="settings-radio-name">{t(option.labelKey)}</span>
        <span class="settings-radio-desc">{t(option.descKey)}</span>
      </div>
    </label>
  {/each}
</div>

<div class="settings-status" role="status" style:color={message ? 'var(--accent-text)' : undefined}>{message}</div>
