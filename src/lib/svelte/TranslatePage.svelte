<script lang="ts">
import { onDestroy } from 'svelte';
import {
  isPlamoSupported,
  loadTranslateMode,
  saveTranslateMode,
  TRANSLATE_LANGUAGES,
  type TranslateMode,
  translateModelFor,
} from '../../../shared/translate-languages.ts';
import {
  canRunFlaxiaNode,
  getCrowdConsentState,
  isCrowdNodeRunning,
  isLocalTranslateReady,
  isOndeviceUnavailable,
  preloadLocalAiModel,
  resolveCrowdConsentState,
  runLocalAiInference,
} from '../crowd-node.ts';
import { getLocale, t } from '../i18n.ts';
import { iconHtml } from '../post/icon-html.ts';
import { detectSourceLang, localPayload, normalizeTranslateOutput, pollRemote } from '../translate/helpers.ts';

type Status = 'idle' | 'local' | 'remote' | 'pending' | 'preloading' | 'error';

const isJa = getLocale().startsWith('ja');
const sourceLanguages = TRANSLATE_LANGUAGES.filter((lang) => isPlamoSupported(lang.code, 'en'));

let mode = $state<TranslateMode>(loadTranslateMode());
let sourceLang = $state('en');
let targetLang = $state('ja');
let sourceText = $state('');
let result = $state('');
let status = $state<Status>('idle');
let copied = $state(false);
let debounce: ReturnType<typeof setTimeout> | null = null;
let controller: AbortController | null = null;
let destroyed = false;
let preloading = false;

const statusLabel = $derived(
  {
    idle: t('translate.status_idle'),
    local: t('translate.status_local'),
    remote: t('translate.status_remote'),
    pending: t('translate.status_pending'),
    preloading: t('translate.status_preloading'),
    error: t('translate.status_error'),
  }[status],
);

async function translate(): Promise<void> {
  if (destroyed) return;
  controller?.abort();
  const text = sourceText.trim();
  if (!text) {
    result = '';
    status = 'idle';
    return;
  }
  const detected = sourceLang === 'auto' ? detectSourceLang(text) : sourceLang;
  if (detected === targetLang) {
    result = text;
    status = 'local';
    return;
  }
  if (!isPlamoSupported(detected, targetLang)) {
    status = 'error';
    result = t('translate.unsupported_pair');
    return;
  }

  const model = translateModelFor(detected, targetLang).model;
  if (mode === 'ondevice-only') {
    const payload = localPayload(text, detected, targetLang);
    const canLocal =
      canRunFlaxiaNode() &&
      (await resolveCrowdConsentState().catch(() => 'unset' as const)) === 'granted' &&
      isCrowdNodeRunning();
    if (!canLocal) {
      status = 'preloading';
      return;
    }
    status = isLocalTranslateReady(model) ? 'local' : 'preloading';
    try {
      const output = await runLocalAiInference(payload);
      if (destroyed) return;
      result = normalizeTranslateOutput(output.output);
      status = 'local';
    } catch (error) {
      if (isOndeviceUnavailable(error)) {
        status = 'preloading';
        if (!preloading) {
          preloading = true;
          void preloadLocalAiModel({ model, task: payload.task })
            .catch(() => {})
            .finally(() => {
              preloading = false;
              if (!destroyed) void translate();
            });
        }
      } else {
        status = 'error';
        console.error('Local translate failed:', error);
      }
    }
    return;
  }

  if (
    canRunFlaxiaNode() &&
    isCrowdNodeRunning() &&
    getCrowdConsentState() === 'granted' &&
    isLocalTranslateReady(model)
  ) {
    status = 'local';
    try {
      const output = await runLocalAiInference(localPayload(text, detected, targetLang));
      if (destroyed) return;
      result = normalizeTranslateOutput(output.output);
      return;
    } catch (error) {
      if (!isOndeviceUnavailable(error)) status = 'error';
    }
  }

  controller = new AbortController();
  const signal = controller.signal;
  status = 'remote';
  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sourceLang: detected, targetLang }),
      signal,
    });
    if (!res.ok) throw new Error(`translate ${res.status}`);
    const data = (await res.json()) as { translatedText?: string; jobId?: string };
    if (data.translatedText) {
      result = data.translatedText;
      return;
    }
    if (data.jobId) {
      status = 'pending';
      result = await pollRemote(data.jobId, signal);
      return;
    }
    throw new Error('no job');
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return;
    if (!destroyed) {
      status = 'error';
      console.error('Remote translate failed:', error);
    }
  }
}

function scheduleTranslate(): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => void translate(), 500);
}

function setMode(next: TranslateMode): void {
  if (mode === next) return;
  mode = next;
  saveTranslateMode(next);
  void translate();
}

function swap(): void {
  const oldSource = sourceLang;
  const oldTarget = targetLang;
  if (!isPlamoSupported(oldTarget, 'en')) {
    status = 'error';
    result = t('translate.unsupported_pair');
    return;
  }
  if (oldSource === 'auto') {
    sourceLang = oldTarget;
    targetLang = 'en';
  } else {
    sourceLang = oldTarget;
    targetLang = oldSource;
  }
  void translate();
}

function clear(): void {
  sourceText = '';
  result = '';
  status = 'idle';
}

async function copyResult(): Promise<void> {
  try {
    await navigator.clipboard.writeText(result);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  } catch {
    // clipboard unavailable
  }
}

onDestroy(() => {
  destroyed = true;
  if (debounce) clearTimeout(debounce);
  controller?.abort();
});
</script>

<div class="translate-page">
  <div class="translate-header">
    <h2 class="translate-title">{t('translate.title')}</h2>
    <p class="translate-subtitle">{t('translate.subtitle')}</p>
  </div>

  <div class="translate-mode-row" role="group" aria-label={t('translate.mode_label')}>
    <button type="button" class="translate-mode-button" class:translate-mode-button--active={mode === 'ondevice-only'} aria-pressed={mode === 'ondevice-only'} onclick={() => setMode('ondevice-only')}>{t('translate.ondevice_only')}</button>
    <button type="button" class="translate-mode-button" class:translate-mode-button--active={mode === 'off-device-allowed'} aria-pressed={mode === 'off-device-allowed'} onclick={() => setMode('off-device-allowed')}>{t('translate.off_device_allowed')}</button>
  </div>
  <p class="translate-mode-note">{mode === 'ondevice-only' ? t('translate.ondevice_note') : t('translate.off_device_note')}</p>

  <div class="translate-bar">
    <select class="translate-select" aria-label={t('translate.source_lang')} bind:value={sourceLang} onchange={() => void translate()}>
      <option value="auto">{t('translate.auto')}</option>
      {#each sourceLanguages as lang (lang.code)}
        <option value={lang.code}>{isJa ? lang.jaName : lang.enName}</option>
      {/each}
    </select>
    <button type="button" class="translate-swap" aria-label={t('translate.swap')} onclick={swap}>{@html iconHtml('translate', 18)}</button>
    <select class="translate-select" aria-label={t('translate.target_lang')} bind:value={targetLang} onchange={() => void translate()}>
      {#each TRANSLATE_LANGUAGES as lang (lang.code)}
        <option value={lang.code}>{isJa ? lang.jaName : lang.enName}</option>
      {/each}
    </select>
  </div>

  <div class="translate-panes">
    <div class="translate-pane">
      <textarea class="translate-input" placeholder={t('translate.input_placeholder')} rows="8" aria-label={t('translate.input_placeholder')} bind:value={sourceText} oninput={scheduleTranslate}></textarea>
      <div class="translate-pane-footer">
        <span class="translate-count">{sourceText.length} / 5000</span>
        <button type="button" class="translate-mini-button" onclick={clear}>{t('common.close')}</button>
      </div>
    </div>
    <div class="translate-pane">
      <textarea class="translate-input translate-result" placeholder={t('translate.output_placeholder')} rows="8" readonly aria-label={t('translate.output_placeholder')} value={result}></textarea>
      <div class="translate-pane-footer">
        <span class="translate-status" data-status={status}>{statusLabel}</span>
        <button type="button" class="translate-mini-button" onclick={() => void copyResult()}>{copied ? t('translate.copied') : t('translate.copy')}</button>
      </div>
    </div>
  </div>

  <p class="translate-hint">{t('translate.hint')}</p>
  <p class="translate-credit">{t('translate.credit')}</p>
</div>
