import {
  canRunFlaxiaNode,
  getCrowdConsentState,
  isCrowdNodeRunning,
  isLocalTranslateReady,
  isOndeviceUnavailable,
  type LocalAiInferencePayload,
  resolveCrowdConsentState,
  runLocalAiInference,
} from '../lib/crowd-node.js';
import { getLocale, t } from '../lib/i18n.js';
import { icon } from '../lib/icons.js';
import { pushSpaHistory } from '../lib/spa-history.js';
import {
  loadTranslateMode,
  saveTranslateMode,
  TRANSLATE_LANGUAGES,
  TRANSLATE_MODEL_ID,
  TRANSLATE_TASK,
  type TranslateMode,
} from '../lib/translate-languages.js';

export interface TranslatePageProps {
  getElement: () => HTMLElement;
  destroy: () => void;
}

type TranslateStatus = 'idle' | 'local' | 'remote' | 'pending' | 'preloading' | 'error';

function normalizeTranslateOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && output.length > 0) {
    const first = output[0] as unknown;
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object' && 'translation_text' in (first as Record<string, unknown>)) {
      return String((first as Record<string, unknown>).translation_text ?? '');
    }
  }
  if (output && typeof output === 'object') {
    const rec = output as Record<string, unknown>;
    const value = rec.translation_text ?? rec.translated_text ?? rec.text ?? rec.output;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return String(value[0]);
  }
  return String(output ?? '');
}

function pollRemote(jobId: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tick = async () => {
      if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      try {
        const res = await fetch(`/api/translate/status?jobId=${encodeURIComponent(jobId)}`, {
          signal,
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { status?: string; translatedText?: string | null };
        if (data.status === 'done' && data.translatedText) return resolve(data.translatedText);
        if (data.status === 'failed') return reject(new Error('translation failed'));
        if (++attempts > 40) return reject(new Error('translation timed out'));
        setTimeout(tick, 1200);
      } catch (error) {
        reject(error);
      }
    };
    tick();
  });
}

export function createTranslatePage(): { getElement: () => HTMLElement; destroy: () => void } {
  const isJa = getLocale().startsWith('ja');
  const element = document.createElement('div');
  element.className = 'translate-page';

  const header = document.createElement('div');
  header.className = 'translate-header';
  const title = document.createElement('h2');
  title.className = 'translate-title';
  title.textContent = t('translate.title');
  const subtitle = document.createElement('p');
  subtitle.className = 'translate-subtitle';
  subtitle.textContent = t('translate.subtitle');
  header.appendChild(title);
  header.appendChild(subtitle);
  element.appendChild(header);

  // Mode segmented control: On-device only vs off-device allowed
  let mode: TranslateMode = loadTranslateMode();
  const modeRow = document.createElement('div');
  modeRow.className = 'translate-mode-row';
  modeRow.setAttribute('role', 'group');
  modeRow.setAttribute('aria-label', t('translate.mode_label'));

  const renderModeButtons = () => {
    modeRow.innerHTML = '';
    const options: Array<{ value: TranslateMode; label: string }> = [
      { value: 'ondevice-only', label: t('translate.ondevice_only') },
      { value: 'off-device-allowed', label: t('translate.off_device_allowed') },
    ];
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `translate-mode-button${mode === option.value ? ' translate-mode-button--active' : ''}`;
      button.textContent = option.label;
      button.setAttribute('aria-pressed', String(mode === option.value));
      button.addEventListener('click', () => {
        mode = option.value;
        saveTranslateMode(mode);
        renderModeButtons();
        updateStatus();
        void translate();
      });
      modeRow.appendChild(button);
    }
  };
  renderModeButtons();
  element.appendChild(modeRow);

  const note = document.createElement('p');
  note.className = 'translate-mode-note';
  element.appendChild(note);

  // Language bar
  const bar = document.createElement('div');
  bar.className = 'translate-bar';

  const sourceSelect = document.createElement('select');
  sourceSelect.className = 'translate-select';
  sourceSelect.setAttribute('aria-label', t('translate.source_lang'));
  const targetSelect = document.createElement('select');
  targetSelect.className = 'translate-select';
  targetSelect.setAttribute('aria-label', t('translate.target_lang'));

  for (const lang of TRANSLATE_LANGUAGES) {
    const sourceOption = document.createElement('option');
    sourceOption.value = lang.code;
    sourceOption.textContent = isJa ? lang.jaName : lang.enName;
    sourceSelect.appendChild(sourceOption);
    const targetOption = document.createElement('option');
    targetOption.value = lang.code;
    targetOption.textContent = isJa ? lang.jaName : lang.enName;
    targetSelect.appendChild(targetOption);
  }
  autoOption(sourceSelect, t('translate.auto'));
  sourceSelect.value = 'en';
  targetSelect.value = 'ja';

  const swapButton = document.createElement('button');
  swapButton.type = 'button';
  swapButton.className = 'translate-swap';
  swapButton.setAttribute('aria-label', t('translate.swap'));
  swapButton.appendChild(icon('translate', { width: '18', height: '18' }));
  swapButton.addEventListener('click', () => {
    const oldSource = sourceSelect.value;
    const oldTarget = targetSelect.value;
    if (oldSource === 'auto') {
      sourceSelect.value = oldTarget;
      targetSelect.value = 'en';
    } else {
      sourceSelect.value = oldTarget;
      targetSelect.value = oldSource;
    }
    void translate();
  });

  bar.appendChild(sourceSelect);
  bar.appendChild(swapButton);
  bar.appendChild(targetSelect);
  element.appendChild(bar);

  // Text panes
  const panes = document.createElement('div');
  panes.className = 'translate-panes';

  const sourcePane = document.createElement('div');
  sourcePane.className = 'translate-pane';
  const sourceInput = document.createElement('textarea');
  sourceInput.className = 'translate-input';
  sourceInput.placeholder = t('translate.input_placeholder');
  sourceInput.rows = 8;
  sourceInput.setAttribute('aria-label', t('translate.input_placeholder'));
  const sourceFooter = document.createElement('div');
  sourceFooter.className = 'translate-pane-footer';
  const sourceCount = document.createElement('span');
  sourceCount.className = 'translate-count';
  const sourceClear = document.createElement('button');
  sourceClear.type = 'button';
  sourceClear.className = 'translate-mini-button';
  sourceClear.textContent = t('common.close');
  sourceClear.addEventListener('click', () => {
    sourceInput.value = '';
    resultInput.value = '';
    updateCounts();
    updateStatus();
  });
  sourceFooter.appendChild(sourceCount);
  sourceFooter.appendChild(sourceClear);
  sourcePane.appendChild(sourceInput);
  sourcePane.appendChild(sourceFooter);

  const resultPane = document.createElement('div');
  resultPane.className = 'translate-pane';
  const resultInput = document.createElement('textarea');
  resultInput.className = 'translate-input translate-result';
  resultInput.placeholder = t('translate.output_placeholder');
  resultInput.rows = 8;
  resultInput.readOnly = true;
  resultInput.setAttribute('aria-label', t('translate.output_placeholder'));
  const resultFooter = document.createElement('div');
  resultFooter.className = 'translate-pane-footer';
  const statusChip = document.createElement('span');
  statusChip.className = 'translate-status';
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'translate-mini-button';
  copyButton.textContent = t('translate.copy');
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(resultInput.value);
      copyButton.textContent = t('translate.copied');
      setTimeout(() => {
        copyButton.textContent = t('translate.copy');
      }, 1500);
    } catch {
      /* clipboard unavailable */
    }
  });
  resultFooter.appendChild(statusChip);
  resultFooter.appendChild(copyButton);
  resultPane.appendChild(resultInput);
  resultPane.appendChild(resultFooter);

  panes.appendChild(sourcePane);
  panes.appendChild(resultPane);
  element.appendChild(panes);

  const hint = document.createElement('p');
  hint.className = 'translate-hint';
  hint.textContent = t('translate.hint');
  element.appendChild(hint);

  let debounce: ReturnType<typeof setTimeout> | null = null;
  let activeController: AbortController | null = null;
  let status: TranslateStatus = 'idle';
  let destroyed = false;

  const updateCounts = () => {
    sourceCount.textContent = `${sourceInput.value.length} / 5000`;
  };

  const updateStatus = () => {
    const labels: Record<TranslateStatus, string> = {
      idle: t('translate.status_idle'),
      local: t('translate.status_local'),
      remote: t('translate.status_remote'),
      pending: t('translate.status_pending'),
      preloading: t('translate.status_preloading'),
      error: t('translate.status_error'),
    };
    statusChip.textContent = labels[status];
    statusChip.dataset.status = status;
    if (mode === 'ondevice-only') {
      note.textContent = t('translate.ondevice_note');
      note.hidden = false;
    } else {
      note.textContent = t('translate.off_device_note');
      note.hidden = false;
    }
  };

  const detectSourceLang = (text: string): string => {
    // Very small heuristic for auto: hiragana/katakana/kanji → ja, korean syllables → ko,
    // cyrillic → ru, otherwise en. M2M100 itself accepts 'en' but auto keeps UX simple.
    if (/[\u3040-\u30ff\u4e00-\u9faf]/.test(text)) return 'ja';
    if (/[\uac00-\ud7a3]/.test(text)) return 'ko';
    if (/[\u0400-\u04ff]/.test(text)) return 'ru';
    return 'en';
  };

  const translate = async (): Promise<void> => {
    if (destroyed) return;
    activeController?.abort();
    const text = sourceInput.value.trim();
    if (!text) {
      resultInput.value = '';
      status = 'idle';
      updateStatus();
      return;
    }
    const detected = sourceSelect.value === 'auto' ? detectSourceLang(text) : sourceSelect.value;
    const target = targetSelect.value;
    if (detected === target) {
      resultInput.value = text;
      status = 'local';
      updateStatus();
      return;
    }

    if (mode === 'ondevice-only') {
      const payload: LocalAiInferencePayload = {
        task: TRANSLATE_TASK,
        model: TRANSLATE_MODEL_ID,
        input: text,
        options: { src_lang: detected, tgt_lang: target, ondeviceOnly: true },
      };
      const canLocal =
        canRunFlaxiaNode() &&
        (await resolveCrowdConsentState().catch(() => 'unset' as const)) === 'granted' &&
        isCrowdNodeRunning();
      if (!canLocal) {
        status = 'preloading';
        updateStatus();
        return;
      }
      status = isLocalTranslateReady(TRANSLATE_MODEL_ID) ? 'local' : 'preloading';
      updateStatus();
      try {
        const result = await runLocalAiInference(payload);
        if (destroyed) return;
        resultInput.value = normalizeTranslateOutput(result.output);
        status = 'local';
      } catch (error) {
        if (isOndeviceUnavailable(error)) {
          status = 'preloading';
        } else {
          status = 'error';
          console.error('Local translate failed:', error);
        }
      }
      updateStatus();
      return;
    }

    // Off-device allowed: try local first, else fall back to Pages /api/translate
    if (canRunFlaxiaNode() && isCrowdNodeRunning() && getCrowdConsentState() === 'granted') {
      if (isLocalTranslateReady(TRANSLATE_MODEL_ID)) {
        status = 'local';
        updateStatus();
        try {
          const result = await runLocalAiInference({
            task: TRANSLATE_TASK,
            model: TRANSLATE_MODEL_ID,
            input: text,
            options: { src_lang: detected, tgt_lang: target, ondeviceOnly: true },
          });
          if (destroyed) return;
          resultInput.value = normalizeTranslateOutput(result.output);
          status = 'local';
          updateStatus();
          return;
        } catch (error) {
          if (!isOndeviceUnavailable(error)) {
            status = 'error';
            updateStatus();
          }
          // Fall through to remote below.
        }
      }
    }

    activeController = new AbortController();
    const signal = activeController.signal;
    status = 'remote';
    updateStatus();
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, sourceLang: detected, targetLang: target }),
        signal,
      });
      if (!res.ok) throw new Error(`translate ${res.status}`);
      const data = (await res.json()) as { translatedText?: string; jobId?: string; status?: string };
      if (data.translatedText) {
        resultInput.value = data.translatedText;
        status = 'remote';
        updateStatus();
        return;
      }
      if (data.jobId) {
        status = 'pending';
        updateStatus();
        resultInput.value = await pollRemote(data.jobId, signal);
        status = 'remote';
        updateStatus();
        return;
      }
      throw new Error('no job');
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return;
      if (!destroyed) {
        status = 'error';
        updateStatus();
        console.error('Remote translate failed:', error);
      }
    }
  };

  sourceInput.addEventListener('input', () => {
    updateCounts();
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void translate(), 500);
  });
  sourceSelect.addEventListener('change', () => void translate());
  targetSelect.addEventListener('change', () => void translate());

  updateCounts();
  updateStatus();

  return {
    getElement: () => element,
    destroy: () => {
      destroyed = true;
      if (debounce) clearTimeout(debounce);
      activeController?.abort();
    },
  };
}

function autoOption(select: HTMLSelectElement, label: string): void {
  const option = document.createElement('option');
  option.value = 'auto';
  option.textContent = label;
  select.appendChild(option);
}

// Keep the history helper referenced so tree-shaken builds still resolve it.
export { pushSpaHistory };
