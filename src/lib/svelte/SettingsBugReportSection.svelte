<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onDestroy } from 'svelte';
import { getLocale, t } from '../i18n.ts';

const MAX_SCREENSHOT_SIZE = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const featureOptions = [
  ['', 'settings.bug_report_feature_none'],
  ['timeline', 'settings.bug_report_feature_timeline'],
  ['arcade', 'settings.bug_report_feature_arcade'],
  ['chat', 'settings.bug_report_feature_chat'],
  ['crowd', 'settings.bug_report_feature_crowd'],
  ['account', 'settings.bug_report_feature_account'],
  ['other', 'settings.bug_report_feature_other'],
] as const;

function detectOperatingSystem(userAgent: string): string {
  if (/Windows NT 10/i.test(userAgent)) return 'Windows 10/11';
  if (/Windows/i.test(userAgent)) return 'Windows';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'iOS';
  if (/Android/i.test(userAgent)) return 'Android';
  if (/Mac OS X|Macintosh/i.test(userAgent)) return 'macOS';
  if (/Linux/i.test(userAgent)) return 'Linux';
  return 'Unknown';
}

function detectBrowser(userAgent: string): string {
  const edge = userAgent.match(/Edg\/([\d.]+)/);
  if (edge) return `Edge ${edge[1]}`;
  const firefox = userAgent.match(/Firefox\/([\d.]+)/);
  if (firefox) return `Firefox ${firefox[1]}`;
  const chrome = userAgent.match(/Chrome\/([\d.]+)/);
  if (chrome) return `Chrome ${chrome[1]}`;
  const safari = userAgent.match(/Version\/([\d.]+).*Safari/);
  if (safari) return `Safari ${safari[1]}`;
  return 'Unknown';
}

function collectDiagnostics(): string {
  const userAgent = navigator.userAgent;
  return JSON.stringify(
    {
      appVersion: import.meta.env.VITE_APP_VERSION || 'unknown',
      commit: import.meta.env.VITE_GIT_COMMIT || 'unknown',
      os: detectOperatingSystem(userAgent),
      browser: detectBrowser(userAgent),
      occurredAt: new Date().toISOString(),
    },
    null,
    2,
  );
}

let feature = $state('');
let summary = $state('');
let details = $state('');
let reproduction = $state('');
let screenshotFile = $state<File | null>(null);
let screenshotPreview = $state<string | null>(null);
let screenshotConsent = $state(false);
let diagnosticsConsent = $state(false);
let diagnostics = $state('');
let confirming = $state(false);
let status = $state('');
let resultUrl = $state('');
let resultNumber = $state<number | null>(null);
let submitting = $state(false);
let summaryInput: HTMLTextAreaElement;

function clearPreview(): void {
  if (screenshotPreview) URL.revokeObjectURL(screenshotPreview);
  screenshotPreview = null;
}

function onScreenshot(event: Event): void {
  clearPreview();
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  if (!file) {
    screenshotFile = null;
    screenshotConsent = false;
    input.setCustomValidity('');
    return;
  }
  if (file.size > MAX_SCREENSHOT_SIZE) {
    input.setCustomValidity(t('settings.bug_report_screenshot_too_large'));
    screenshotFile = null;
    return;
  }
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    input.setCustomValidity(t('settings.bug_report_screenshot_invalid'));
    screenshotFile = null;
    return;
  }
  input.setCustomValidity('');
  screenshotFile = file;
  screenshotConsent = true;
  screenshotPreview = URL.createObjectURL(file);
}

function markEdited(): void {
  if (!submitting) confirming = false;
  status = '';
  resultUrl = '';
}

function toggleDiagnostics(checked: boolean): void {
  diagnosticsConsent = checked;
  diagnostics = checked ? collectDiagnostics() : '';
  markEdited();
}

function review(event: SubmitEvent): void {
  event.preventDefault();
  if (submitting) return;
  if (!summary.trim() || !details.trim()) return;
  if (screenshotFile && !screenshotConsent) return;
  status = '';
  resultUrl = '';
  confirming = true;
}

async function submitReport(): Promise<void> {
  if (submitting) return;
  if (screenshotFile && !screenshotConsent) {
    status = t('settings.bug_report_screenshot_consent_required');
    return;
  }
  submitting = true;
  status = t('settings.bug_report_sending');

  const payload = new FormData();
  payload.append('feature', feature);
  payload.append('summary', summary);
  payload.append('details', details);
  payload.append('reproduction', reproduction);
  payload.append('language', getLocale() === 'en' ? 'en' : 'ja');
  payload.append('publicConfirmation', 'true');
  payload.append('screenshotConsent', screenshotConsent ? 'true' : 'false');
  payload.append('diagnosticsConsent', diagnosticsConsent ? 'true' : 'false');
  if (diagnosticsConsent) payload.append('diagnostics', diagnostics);
  if (screenshotFile) payload.append('screenshot', screenshotFile, screenshotFile.name);

  try {
    const response = await fetch('/api/bug-reports', { method: 'POST', body: payload });
    const data = (await response.json().catch(() => ({}))) as {
      issueNumber?: number;
      issueUrl?: string;
      error?: string;
    };
    if (!response.ok || !data.issueNumber || !data.issueUrl) {
      const messageKey: Record<string, string> = {
        unauthorized: 'settings.bug_report_unauthorized',
        invalid_request: 'settings.bug_report_invalid',
        invalid_feature: 'settings.bug_report_invalid',
        invalid_summary: 'settings.bug_report_invalid',
        invalid_details: 'settings.bug_report_invalid',
        invalid_reproduction: 'settings.bug_report_invalid',
        public_confirmation_required: 'settings.bug_report_confirmation_required',
        screenshot_consent_required: 'settings.bug_report_screenshot_consent_required',
        invalid_screenshot: 'settings.bug_report_screenshot_invalid',
        screenshot_too_large: 'settings.bug_report_screenshot_too_large',
        diagnostics_required: 'settings.bug_report_invalid',
        invalid_diagnostics: 'settings.bug_report_invalid',
        request_too_large: 'settings.bug_report_screenshot_too_large',
        rate_limited: 'settings.bug_report_rate_limited',
        submission_in_progress: 'settings.bug_report_in_progress',
        github_not_configured: 'settings.bug_report_not_configured',
        github_unavailable: 'settings.bug_report_failed',
        upload_failed: 'settings.bug_report_failed',
        storage_unavailable: 'settings.bug_report_failed',
      };
      status = t(messageKey[data.error || ''] || 'settings.bug_report_failed');
      return;
    }
    confirming = false;
    status = t('settings.bug_report_success', { number: data.issueNumber });
    resultNumber = data.issueNumber;
    resultUrl = data.issueUrl;
  } catch {
    status = t('settings.bug_report_failed');
  } finally {
    submitting = false;
  }
}

onDestroy(clearPreview);
</script>

<section class="settings-section settings-bug-report">
  <h2>{t('settings.bug_report')}</h2>
  <p class="settings-bug-report-public-notice" role="note">{t('settings.bug_report_public_notice')}</p>

  <form onsubmit={review}>
    <fieldset class="settings-bug-report-fields" disabled={submitting}>
      <label class="settings-bug-report-field">
        <span>{t('settings.bug_report_feature')}</span>
        <select class="settings-input" name="feature" bind:value={feature} onchange={markEdited}>
          {#each featureOptions as [value, labelKey] (value)}
            <option {value}>{t(labelKey)}</option>
          {/each}
        </select>
      </label>

      <label class="settings-bug-report-field">
        <span>{t('settings.bug_report_summary')}</span>
        <textarea
          class="settings-input"
          name="summary"
          rows="3"
          maxlength="100"
          required
          aria-label={t('settings.bug_report_summary')}
          bind:this={summaryInput}
          bind:value={summary}
          oninput={markEdited}
        ></textarea>
        <small class="settings-bug-report-hint">{t('settings.bug_report_summary_hint')}</small>
      </label>

      <label class="settings-bug-report-field">
        <span>{t('settings.bug_report_details')}</span>
        <textarea
          class="settings-input"
          name="details"
          rows="7"
          maxlength="5000"
          required
          aria-label={t('settings.bug_report_details')}
          bind:value={details}
          oninput={markEdited}
        ></textarea>
        <small class="settings-bug-report-hint">{t('settings.bug_report_details_hint')}</small>
      </label>

      <label class="settings-bug-report-field">
        <span>{t('settings.bug_report_reproduction')}</span>
        <textarea
          class="settings-input"
          name="reproduction"
          rows="5"
          maxlength="2000"
          aria-label={t('settings.bug_report_reproduction')}
          bind:value={reproduction}
          oninput={markEdited}
        ></textarea>
        <small class="settings-bug-report-hint">{t('settings.bug_report_reproduction_hint')}</small>
      </label>

      <label class="settings-bug-report-field">
        <span>{t('settings.bug_report_screenshot')}</span>
        <input
          class="settings-input"
          type="file"
          name="screenshot"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onchange={onScreenshot}
        />
        <small class="settings-bug-report-hint">{t('settings.bug_report_screenshot_hint')}</small>
      </label>

      <label class="settings-bug-report-consent">
        <input type="checkbox" name="screenshotConsent" bind:checked={screenshotConsent} onchange={markEdited} />
        <span>{t('settings.bug_report_screenshot_consent')}</span>
      </label>

      {#if screenshotPreview && screenshotFile}
        <div class="settings-bug-report-image-preview">
          <img src={screenshotPreview} alt={t('settings.bug_report_screenshot_preview')} />
          <small>{screenshotFile.name} ({Math.ceil(screenshotFile.size / 1024)} KB)</small>
        </div>
      {/if}

      <label class="settings-bug-report-consent">
        <input
          type="checkbox"
          name="diagnosticsConsent"
          checked={diagnosticsConsent}
          onchange={(event) => toggleDiagnostics(event.currentTarget.checked)}
        />
        <span>{t('settings.bug_report_diagnostics')}</span>
      </label>

      {#if diagnosticsConsent}
        <div class="settings-bug-report-diagnostics">
          <p class="settings-bug-report-hint">{t('settings.bug_report_diagnostics_hint')}</p>
          <textarea
            class="settings-input"
            rows="6"
            readonly
            aria-label={t('settings.bug_report_diagnostics_preview')}
            value={diagnostics}
          ></textarea>
        </div>
      {/if}

      <button type="submit" class="settings-save">{t('settings.bug_report_review')}</button>
    </fieldset>

    {#if confirming}
      <div class="settings-bug-report-confirmation" aria-labelledby="settings-bug-report-confirmation-title">
        <h3 id="settings-bug-report-confirmation-title">{t('settings.bug_report_confirm_title')}</h3>
        <p>{t('settings.bug_report_confirm_text')}</p>
        <p class="settings-bug-report-confirmation-summary">
          {t('settings.bug_report_summary')}: {summary.trim()}
        </p>
        <p class="settings-bug-report-confirmation-summary">
          {screenshotFile
            ? `${t('settings.bug_report_screenshot')}: ${screenshotFile.name} (${Math.ceil(screenshotFile.size / 1024)} KB)`
            : t('settings.bug_report_no_screenshot')}
        </p>
        <p class="settings-bug-report-confirmation-summary">
          {diagnosticsConsent
            ? t('settings.bug_report_diagnostics_included')
            : t('settings.bug_report_diagnostics_not_included')}
        </p>
        <div class="settings-bug-report-actions">
          <button type="button" class="settings-save" disabled={submitting} onclick={() => void submitReport()}>
            {t('settings.bug_report_confirm_send')}
          </button>
          <button
            type="button"
            class="settings-bug-report-secondary"
            disabled={submitting}
            onclick={() => {
              confirming = false;
              summaryInput?.focus();
            }}
          >
            {t('settings.bug_report_edit')}
          </button>
        </div>
      </div>
    {/if}

    <p class="settings-bug-report-status" role="status" aria-live="polite">{status}</p>

    {#if resultUrl}
      <div class="settings-bug-report-result">
        <span>{t('settings.bug_report_success', { number: resultNumber ?? 0 })}</span>
        <a href={resultUrl} target="_blank" rel="noopener noreferrer">{t('settings.bug_report_open_issue')}</a>
      </div>
    {/if}
  </form>
</section>
