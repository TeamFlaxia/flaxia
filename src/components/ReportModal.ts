import { t } from '../lib/i18n.js';
import { createModalOverlay } from '../lib/modal-overlay.js';
import { showToast } from '../lib/toast.js';
import type { ReportCategory } from '../types/post.js';

const categories: { value: ReportCategory; labelKey: string }[] = [
  { value: 'spam', labelKey: 'post.report_category_spam' },
  { value: 'harassment', labelKey: 'post.report_category_harassment' },
  { value: 'hate_speech', labelKey: 'post.report_category_hate_speech' },
  { value: 'inappropriate', labelKey: 'post.report_category_inappropriate' },
  { value: 'misinformation', labelKey: 'post.report_category_misinformation' },
  { value: 'privacy', labelKey: 'post.report_category_privacy' },
  { value: 'copyright', labelKey: 'post.report_category_copyright' },
  { value: 'malware', labelKey: 'post.report_category_malware' },
  { value: 'csam', labelKey: 'post.report_category_csam' },
  { value: 'nsfw_untagged', labelKey: 'post.report_category_nsfw_untagged' },
  { value: 'other', labelKey: 'post.report_category_other' },
];

function buildDialogHtml(): string {
  return `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <h3 style="margin: 0; font-size: 18px; color: var(--text-primary);">${t('post.report_title')}</h3>
      <button class="close-btn" style="
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 20px;
        cursor: pointer;
      ">✕</button>
    </div>
    <p style="margin: 0 0 16px 0; color: var(--text-muted); font-size: 14px;">${t('post.report_question')}</p>
    <div class="categories" style="margin-bottom: 24px;">
      ${categories
        .map(
          (c) => `
          <label style="
            display: flex;
            align-items: center;
            padding: 10px 0;
            cursor: pointer;
            color: var(--text-primary);
          ">
            <input type="radio" name="report-category" value="${c.value}" style="margin-right: 12px;">
            <span>${t(c.labelKey)}</span>
          </label>
        `,
        )
        .join('')}
    </div>
    <div class="dmca-section" style="display: none; margin-bottom: 24px; padding: 16px; background: var(--bg-secondary); border-radius: 8px;">
      <h4 style="margin: 0 0 12px 0; font-size: 14px; color: var(--text-primary);">${t('post.report_dmca_title')}</h4>
      <div style="margin-bottom: 12px;">
        <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.report_dmca_work_label')}</label>
        <input type="text" class="dmca-work" style="
          width: 100%;
          padding: 8px;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--bg-primary);
          color: var(--text-primary);
          font-size: 14px;
          box-sizing: border-box;
        " placeholder="${t('post.report_dmca_work_placeholder')}">
      </div>
      <div style="margin-bottom: 12px;">
        <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.report_dmca_email_label')}</label>
        <input type="email" class="dmca-email" style="
          width: 100%;
          padding: 8px;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--bg-primary);
          color: var(--text-primary);
          font-size: 14px;
          box-sizing: border-box;
        " placeholder="${t('post.report_dmca_email_placeholder')}">
      </div>
      <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer;">
        <input type="checkbox" class="dmca-sworn" style="margin-top: 2px;">
        <span style="font-size: 12px; color: var(--text-muted);">${t('post.report_dmca_swear')}</span>
      </label>
    </div>
    <div style="display: flex; justify-content: flex-end;">
      <button class="submit-btn" disabled style="
        padding: 10px 24px;
        background: var(--accent);
        border: none;
        border-radius: 9999px;
        color: #000;
        font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        cursor: pointer;
        opacity: 0.5;
      ">${t('common.submit')}</button>
    </div>
  `;
}

async function submitReport(
  postId: string,
  category: ReportCategory,
  dmcaData?: { work_description: string; reporter_email: string; sworn: boolean },
): Promise<void> {
  try {
    const body: {
      post_id: string;
      category: string;
      dmca?: { work_description: string; reporter_email: string; sworn: boolean };
    } = { post_id: postId, category };
    if (dmcaData) {
      body.dmca = dmcaData;
    }

    const response = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });

    if (response.status === 409) {
      showToast(t('post.report_already'));
      return;
    }

    if (!response.ok) {
      const errorData = (await response.json()) as { error?: string };
      throw new Error(errorData?.error || 'Failed to submit report');
    }

    showToast(t('post.report_submitted'));
  } catch (error) {
    console.error('Report error:', error);
    console.error('Error details:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : 'No stack trace',
      post_id: postId,
      category: category || 'unknown',
    });
    showToast(t('post.report_failed'), true);
  }
}

export function openReportModal(postId: string): void {
  const { overlay, dialog, close } = createModalOverlay('420px');
  dialog.innerHTML = buildDialogHtml();
  document.body.appendChild(overlay);

  const submitBtn = dialog.querySelector('.submit-btn') as HTMLButtonElement;
  const closeBtn = dialog.querySelector('.close-btn');
  const radioInputs = dialog.querySelectorAll('input[name="report-category"]');
  const dmcaSection = dialog.querySelector('.dmca-section') as HTMLElement;
  const dmcaWorkInput = dialog.querySelector('.dmca-work') as HTMLInputElement;
  const dmcaEmailInput = dialog.querySelector('.dmca-email') as HTMLInputElement;
  const dmcaSwornCheckbox = dialog.querySelector('.dmca-sworn') as HTMLInputElement;

  let selectedCategory: ReportCategory | null = null;

  radioInputs.forEach((input) => {
    input.addEventListener('change', (e) => {
      selectedCategory = (e.target as HTMLInputElement).value as ReportCategory;
      submitBtn.disabled = false;
      submitBtn.style.opacity = '1';
      dmcaSection.style.display = selectedCategory === 'copyright' ? 'block' : 'none';
    });
  });

  const checkSubmitEnabled = (): boolean => {
    if (!selectedCategory) return false;
    if (selectedCategory === 'copyright') {
      return (
        dmcaWorkInput.value.trim().length > 0 && dmcaEmailInput.value.trim().length > 0 && dmcaSwornCheckbox.checked
      );
    }
    return true;
  };

  const updateSubmitState = () => {
    const enabled = checkSubmitEnabled();
    submitBtn.disabled = !enabled;
    submitBtn.style.opacity = enabled ? '1' : '0.5';
  };

  dmcaWorkInput?.addEventListener('input', updateSubmitState);
  dmcaEmailInput?.addEventListener('input', updateSubmitState);
  dmcaSwornCheckbox?.addEventListener('change', updateSubmitState);

  closeBtn?.addEventListener('click', close);

  submitBtn?.addEventListener('click', async () => {
    if (!selectedCategory) return;

    let dmcaData: { work_description: string; reporter_email: string; sworn: boolean } | undefined;
    if (selectedCategory === 'copyright') {
      dmcaData = {
        work_description: dmcaWorkInput.value.trim(),
        reporter_email: dmcaEmailInput.value.trim(),
        sworn: dmcaSwornCheckbox.checked,
      };
    }

    close();
    await submitReport(postId, selectedCategory, dmcaData);
  });
}
