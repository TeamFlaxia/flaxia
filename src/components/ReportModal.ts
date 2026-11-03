import { t } from '../lib/i18n.js';
import { attachIcons } from '../lib/icons.js';
import { createModalOverlay } from '../lib/modal-overlay.js';
import { showToast } from '../lib/toast.js';
import type { ReportCategory } from '../types/post.js';

/** Leading cosmetic emoji (v3 keeps labels typographic). */
const LEADING_EMOJI = /^(?:\p{Extended_Pictographic}|\uFE0F|\s)+/u;

function plainLabel(value: string): string {
  return value.replace(LEADING_EMOJI, '');
}

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
    <div class="fx-report">
      <div class="fx-report__head">
        <div>
          <h3 class="fx-report__title" id="report-modal-title">${plainLabel(t('post.report_title'))}</h3>
          <p class="fx-report__question">${t('post.report_question')}</p>
        </div>
        <button type="button" class="fx-icon-btn fx-report__close" aria-label="${t('common.close')}">
          <span class="action-icon" data-icon="close"></span>
        </button>
      </div>
      <fieldset class="fx-report__cats">
        <legend class="fx-visually-hidden">${t('post.report_question')}</legend>
        ${categories
          .map(
            (c) => `
          <label class="fx-report__card">
            <input class="fx-report__radio" type="radio" name="report-category" value="${c.value}">
            <span class="fx-report__card-label">${t(c.labelKey)}</span>
            <span class="fx-report__card-check" aria-hidden="true"></span>
          </label>
        `,
          )
          .join('')}
      </fieldset>
      <div class="fx-report__dmca" hidden>
        <h4 class="fx-report__title" style="font-size: 0.875rem;">${t('post.report_dmca_title')}</h4>
        <div class="fx-report__field">
          <label for="report-dmca-work">${t('post.report_dmca_work_label')}</label>
          <textarea id="report-dmca-work" class="fx-report__textarea dmca-work" rows="3" placeholder="${t('post.report_dmca_work_placeholder')}"></textarea>
        </div>
        <div class="fx-report__field">
          <label for="report-dmca-email">${t('post.report_dmca_email_label')}</label>
          <input id="report-dmca-email" class="fx-report__input dmca-email" type="email" placeholder="${t('post.report_dmca_email_placeholder')}">
        </div>
        <label class="fx-report__check">
          <input class="fx-report__checkbox dmca-sworn" type="checkbox">
          <span>${t('post.report_dmca_swear')}</span>
        </label>
      </div>
      <div class="fx-report__actions">
        <button type="button" class="fx-btn fx-btn--primary fx-report__submit submit-btn" disabled>${t('common.submit')}</button>
      </div>
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
  const { overlay, dialog, close } = createModalOverlay('520px');
  dialog.innerHTML = buildDialogHtml();
  attachIcons(dialog);
  document.body.appendChild(overlay);

  const submitBtn = dialog.querySelector('.submit-btn') as HTMLButtonElement;
  const closeBtn = dialog.querySelector('.fx-report__close') as HTMLButtonElement;
  const cards = Array.from(dialog.querySelectorAll<HTMLElement>('.fx-report__card'));
  const radioInputs = dialog.querySelectorAll<HTMLInputElement>('input[name="report-category"]');
  const dmcaSection = dialog.querySelector('.fx-report__dmca') as HTMLElement;
  const dmcaWorkInput = dialog.querySelector('.dmca-work') as HTMLTextAreaElement;
  const dmcaEmailInput = dialog.querySelector('.dmca-email') as HTMLInputElement;
  const dmcaSwornCheckbox = dialog.querySelector('.dmca-sworn') as HTMLInputElement;

  let selectedCategory: ReportCategory | null = null;

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
    submitBtn.disabled = !checkSubmitEnabled();
  };

  radioInputs.forEach((input) => {
    input.addEventListener('change', () => {
      selectedCategory = input.value as ReportCategory;
      const value = selectedCategory;
      for (const card of cards) {
        const radio = card.querySelector<HTMLInputElement>('.fx-report__radio');
        card.classList.toggle('is-selected', radio?.value === value);
      }
      dmcaSection.hidden = value !== 'copyright';
      updateSubmitState();
    });
  });

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
