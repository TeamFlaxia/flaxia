import { getLocale, t } from '../lib/i18n.js';

const MAX_SCREENSHOT_SIZE = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

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

function collectDiagnostics(): Record<string, string> {
  const userAgent = navigator.userAgent;
  return {
    appVersion: import.meta.env.VITE_APP_VERSION || 'unknown',
    commit: import.meta.env.VITE_GIT_COMMIT || 'unknown',
    os: detectOperatingSystem(userAgent),
    browser: detectBrowser(userAgent),
    occurredAt: new Date().toISOString(),
  };
}

export function createBugReportForm() {
  const section = document.createElement('section');
  section.className = 'settings-section settings-bug-report';

  const title = document.createElement('h2');
  title.textContent = t('settings.bug_report');

  const publicNotice = document.createElement('p');
  publicNotice.className = 'settings-bug-report-public-notice';
  publicNotice.setAttribute('role', 'note');
  publicNotice.textContent = t('settings.bug_report_public_notice');

  const form = document.createElement('form');
  form.noValidate = false;
  const fields = document.createElement('fieldset');
  fields.className = 'settings-bug-report-fields';

  const featureLabel = document.createElement('label');
  featureLabel.className = 'settings-bug-report-field';
  const featureLabelText = document.createElement('span');
  featureLabelText.textContent = t('settings.bug_report_feature');
  const featureSelect = document.createElement('select');
  featureSelect.className = 'settings-input';
  featureSelect.name = 'feature';
  const featureOptions = [
    ['', 'settings.bug_report_feature_none'],
    ['timeline', 'settings.bug_report_feature_timeline'],
    ['arcade', 'settings.bug_report_feature_arcade'],
    ['chat', 'settings.bug_report_feature_chat'],
    ['crowd', 'settings.bug_report_feature_crowd'],
    ['account', 'settings.bug_report_feature_account'],
    ['other', 'settings.bug_report_feature_other'],
  ] as const;
  for (const [value, labelKey] of featureOptions) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = t(labelKey);
    featureSelect.appendChild(option);
  }
  featureLabel.appendChild(featureLabelText);
  featureLabel.appendChild(featureSelect);

  const summaryLabel = document.createElement('label');
  summaryLabel.className = 'settings-bug-report-field';
  const summaryLabelText = document.createElement('span');
  summaryLabelText.textContent = t('settings.bug_report_summary');
  const summary = document.createElement('textarea');
  summary.className = 'settings-input';
  summary.name = 'summary';
  summary.rows = 3;
  summary.maxLength = 100;
  summary.required = true;
  summary.setAttribute('aria-label', t('settings.bug_report_summary'));
  const summaryHint = document.createElement('small');
  summaryHint.className = 'settings-bug-report-hint';
  summaryHint.textContent = t('settings.bug_report_summary_hint');
  summaryLabel.appendChild(summaryLabelText);
  summaryLabel.appendChild(summary);
  summaryLabel.appendChild(summaryHint);

  const detailsLabel = document.createElement('label');
  detailsLabel.className = 'settings-bug-report-field';
  const detailsLabelText = document.createElement('span');
  detailsLabelText.textContent = t('settings.bug_report_details');
  const details = document.createElement('textarea');
  details.className = 'settings-input';
  details.name = 'details';
  details.rows = 7;
  details.maxLength = 5000;
  details.required = true;
  details.setAttribute('aria-label', t('settings.bug_report_details'));
  const detailsHint = document.createElement('small');
  detailsHint.className = 'settings-bug-report-hint';
  detailsHint.textContent = t('settings.bug_report_details_hint');
  detailsLabel.appendChild(detailsLabelText);
  detailsLabel.appendChild(details);
  detailsLabel.appendChild(detailsHint);

  const reproductionLabel = document.createElement('label');
  reproductionLabel.className = 'settings-bug-report-field';
  const reproductionLabelText = document.createElement('span');
  reproductionLabelText.textContent = t('settings.bug_report_reproduction');
  const reproduction = document.createElement('textarea');
  reproduction.className = 'settings-input';
  reproduction.name = 'reproduction';
  reproduction.rows = 5;
  reproduction.maxLength = 2000;
  reproduction.setAttribute('aria-label', t('settings.bug_report_reproduction'));
  const reproductionHint = document.createElement('small');
  reproductionHint.className = 'settings-bug-report-hint';
  reproductionHint.textContent = t('settings.bug_report_reproduction_hint');
  reproductionLabel.appendChild(reproductionLabelText);
  reproductionLabel.appendChild(reproduction);
  reproductionLabel.appendChild(reproductionHint);

  const screenshotLabel = document.createElement('label');
  screenshotLabel.className = 'settings-bug-report-field';
  const screenshotLabelText = document.createElement('span');
  screenshotLabelText.textContent = t('settings.bug_report_screenshot');
  const screenshot = document.createElement('input');
  screenshot.className = 'settings-input';
  screenshot.type = 'file';
  screenshot.name = 'screenshot';
  screenshot.accept = 'image/png,image/jpeg,image/webp,image/gif';
  const screenshotHint = document.createElement('small');
  screenshotHint.className = 'settings-bug-report-hint';
  screenshotHint.textContent = t('settings.bug_report_screenshot_hint');
  screenshotLabel.appendChild(screenshotLabelText);
  screenshotLabel.appendChild(screenshot);
  screenshotLabel.appendChild(screenshotHint);

  const screenshotConsentLabel = document.createElement('label');
  screenshotConsentLabel.className = 'settings-bug-report-consent';
  const screenshotConsent = document.createElement('input');
  screenshotConsent.type = 'checkbox';
  screenshotConsent.name = 'screenshotConsent';
  const screenshotConsentText = document.createElement('span');
  screenshotConsentText.textContent = t('settings.bug_report_screenshot_consent');
  screenshotConsentLabel.appendChild(screenshotConsent);
  screenshotConsentLabel.appendChild(screenshotConsentText);

  const screenshotPreview = document.createElement('div');
  screenshotPreview.className = 'settings-bug-report-image-preview';
  screenshotPreview.hidden = true;
  const screenshotPreviewImage = document.createElement('img');
  screenshotPreviewImage.alt = t('settings.bug_report_screenshot_preview');
  screenshotPreviewImage.style.cssText =
    'display: block; max-width: 100%; max-height: 360px; margin-bottom: 0.4rem; border: 1px solid var(--border); border-radius: 10px; object-fit: contain;';
  const screenshotPreviewCaption = document.createElement('small');
  screenshotPreview.appendChild(screenshotPreviewImage);
  screenshotPreview.appendChild(screenshotPreviewCaption);

  const diagnosticsLabel = document.createElement('label');
  diagnosticsLabel.className = 'settings-bug-report-consent';
  const diagnosticsConsent = document.createElement('input');
  diagnosticsConsent.type = 'checkbox';
  diagnosticsConsent.name = 'diagnosticsConsent';
  const diagnosticsLabelText = document.createElement('span');
  diagnosticsLabelText.textContent = t('settings.bug_report_diagnostics');
  diagnosticsLabel.appendChild(diagnosticsConsent);
  diagnosticsLabel.appendChild(diagnosticsLabelText);

  const diagnosticsPanel = document.createElement('div');
  diagnosticsPanel.className = 'settings-bug-report-diagnostics';
  diagnosticsPanel.hidden = true;
  const diagnosticsHint = document.createElement('p');
  diagnosticsHint.className = 'settings-bug-report-hint';
  diagnosticsHint.textContent = t('settings.bug_report_diagnostics_hint');
  const diagnosticsPreview = document.createElement('textarea');
  diagnosticsPreview.className = 'settings-input';
  diagnosticsPreview.rows = 6;
  diagnosticsPreview.readOnly = true;
  diagnosticsPreview.setAttribute('aria-label', t('settings.bug_report_diagnostics_preview'));
  diagnosticsPanel.appendChild(diagnosticsHint);
  diagnosticsPanel.appendChild(diagnosticsPreview);

  const reviewButton = document.createElement('button');
  reviewButton.type = 'submit';
  reviewButton.className = 'settings-save';
  reviewButton.textContent = t('settings.bug_report_review');

  for (const field of [
    featureLabel,
    summaryLabel,
    detailsLabel,
    reproductionLabel,
    screenshotLabel,
    screenshotConsentLabel,
    screenshotPreview,
    diagnosticsLabel,
    diagnosticsPanel,
    reviewButton,
  ]) {
    fields.appendChild(field);
  }

  const confirmation = document.createElement('div');
  confirmation.className = 'settings-bug-report-confirmation';
  confirmation.hidden = true;
  confirmation.setAttribute('aria-labelledby', 'settings-bug-report-confirmation-title');
  const confirmationTitle = document.createElement('h3');
  confirmationTitle.id = 'settings-bug-report-confirmation-title';
  confirmationTitle.textContent = t('settings.bug_report_confirm_title');
  const confirmationText = document.createElement('p');
  confirmationText.textContent = t('settings.bug_report_confirm_text');
  const confirmationSummary = document.createElement('p');
  confirmationSummary.className = 'settings-bug-report-confirmation-summary';
  const confirmationAttachment = document.createElement('p');
  confirmationAttachment.className = 'settings-bug-report-confirmation-summary';
  const confirmationDiagnostics = document.createElement('p');
  confirmationDiagnostics.className = 'settings-bug-report-confirmation-summary';
  const confirmationActions = document.createElement('div');
  confirmationActions.className = 'settings-bug-report-actions';
  const confirmButton = document.createElement('button');
  confirmButton.type = 'button';
  confirmButton.className = 'settings-save';
  confirmButton.textContent = t('settings.bug_report_confirm_send');
  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.className = 'settings-bug-report-secondary';
  editButton.textContent = t('settings.bug_report_edit');
  confirmationActions.appendChild(confirmButton);
  confirmationActions.appendChild(editButton);
  for (const item of [
    confirmationTitle,
    confirmationText,
    confirmationSummary,
    confirmationAttachment,
    confirmationDiagnostics,
    confirmationActions,
  ]) {
    confirmation.appendChild(item);
  }

  const status = document.createElement('p');
  status.className = 'settings-bug-report-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const result = document.createElement('div');
  result.className = 'settings-bug-report-result';
  result.hidden = true;
  const resultText = document.createElement('span');
  const resultLink = document.createElement('a');
  resultLink.target = '_blank';
  resultLink.rel = 'noopener noreferrer';
  resultLink.textContent = t('settings.bug_report_open_issue');
  result.appendChild(resultText);
  result.appendChild(resultLink);

  form.appendChild(fields);
  form.appendChild(confirmation);
  form.appendChild(status);
  form.appendChild(result);
  section.appendChild(title);
  section.appendChild(publicNotice);
  section.appendChild(form);

  let screenshotObjectUrl: string | null = null;
  let isSubmitting = false;

  function hideConfirmation(): void {
    confirmation.hidden = true;
  }

  function updateConfirmationSummary(): void {
    confirmationSummary.textContent = `${t('settings.bug_report_summary')}: ${summary.value.trim()}`;
    const file = screenshot.files?.[0];
    confirmationAttachment.textContent = file
      ? `${t('settings.bug_report_screenshot')}: ${file.name} (${Math.ceil(file.size / 1024)} KB)`
      : t('settings.bug_report_no_screenshot');
    confirmationDiagnostics.textContent = diagnosticsConsent.checked
      ? t('settings.bug_report_diagnostics_included')
      : t('settings.bug_report_diagnostics_not_included');
  }

  function showDiagnostics(): void {
    diagnosticsPanel.hidden = !diagnosticsConsent.checked;
    diagnosticsPreview.value = diagnosticsConsent.checked ? JSON.stringify(collectDiagnostics(), null, 2) : '';
  }

  function markEdited(): void {
    if (!isSubmitting) hideConfirmation();
    result.hidden = true;
    status.textContent = '';
  }

  screenshot.addEventListener('change', () => {
    if (screenshotObjectUrl) URL.revokeObjectURL(screenshotObjectUrl);
    screenshotObjectUrl = null;
    const file = screenshot.files?.[0];
    if (file && file.size > MAX_SCREENSHOT_SIZE) {
      screenshot.setCustomValidity(t('settings.bug_report_screenshot_too_large'));
    } else if (file && !ALLOWED_IMAGE_TYPES.has(file.type)) {
      screenshot.setCustomValidity(t('settings.bug_report_screenshot_invalid'));
    } else {
      screenshot.setCustomValidity('');
    }
    screenshotConsent.required = Boolean(file);
    screenshotPreview.hidden = !file || !ALLOWED_IMAGE_TYPES.has(file.type) || file.size > MAX_SCREENSHOT_SIZE;
    if (file && !screenshotPreview.hidden) {
      screenshotObjectUrl = URL.createObjectURL(file);
      screenshotPreviewImage.src = screenshotObjectUrl;
      screenshotPreviewCaption.textContent = `${file.name} (${Math.ceil(file.size / 1024)} KB)`;
    }
    markEdited();
  });

  diagnosticsConsent.addEventListener('change', () => {
    showDiagnostics();
    markEdited();
  });

  for (const input of [featureSelect, summary, details, reproduction, screenshotConsent]) {
    input.addEventListener('input', markEdited);
    input.addEventListener('change', markEdited);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (isSubmitting) return;
    if (!form.reportValidity()) return;
    status.textContent = '';
    result.hidden = true;
    updateConfirmationSummary();
    confirmation.hidden = false;
    confirmButton.focus();
  });

  editButton.addEventListener('click', () => {
    hideConfirmation();
    summary.focus();
  });

  confirmButton.addEventListener('click', () => {
    void submitReport();
  });

  async function submitReport(): Promise<void> {
    if (isSubmitting) return;
    if (screenshot.files?.[0] && !screenshotConsent.checked) {
      status.textContent = t('settings.bug_report_screenshot_consent_required');
      screenshotConsent.focus();
      return;
    }

    isSubmitting = true;
    fields.disabled = true;
    confirmButton.disabled = true;
    editButton.disabled = true;
    status.textContent = t('settings.bug_report_sending');

    const payload = new FormData();
    payload.append('feature', featureSelect.value);
    payload.append('summary', summary.value);
    payload.append('details', details.value);
    payload.append('reproduction', reproduction.value);
    payload.append('language', getLocale() === 'en' ? 'en' : 'ja');
    payload.append('publicConfirmation', 'true');
    payload.append('screenshotConsent', screenshotConsent.checked ? 'true' : 'false');
    payload.append('diagnosticsConsent', diagnosticsConsent.checked ? 'true' : 'false');
    if (diagnosticsConsent.checked) payload.append('diagnostics', diagnosticsPreview.value);
    const file = screenshot.files?.[0];
    if (file) payload.append('screenshot', file, file.name);

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
        status.textContent = t(messageKey[data.error || ''] || 'settings.bug_report_failed');
        return;
      }

      hideConfirmation();
      status.textContent = t('settings.bug_report_success', { number: data.issueNumber });
      resultLink.href = data.issueUrl;
      resultLink.textContent = t('settings.bug_report_open_issue');
      result.hidden = false;
    } catch {
      status.textContent = t('settings.bug_report_failed');
    } finally {
      isSubmitting = false;
      fields.disabled = false;
      confirmButton.disabled = false;
      editButton.disabled = false;
    }
  }

  return {
    getElement: () => section,
    destroy: () => {
      if (screenshotObjectUrl) URL.revokeObjectURL(screenshotObjectUrl);
      section.remove();
    },
  };
}
