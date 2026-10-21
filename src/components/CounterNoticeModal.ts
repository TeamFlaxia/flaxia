import { t } from '../lib/i18n.js';
import { createModalOverlay } from '../lib/modal-overlay.js';
import { showToast } from '../lib/toast.js';

function buildDialogHtml(): string {
  return `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <h3 style="margin: 0; font-size: 18px; color: var(--text-primary);">${t('post.counter_notice_title')}</h3>
      <button class="close-btn" style="
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 20px;
        cursor: pointer;
      ">✕</button>
    </div>
    <p style="margin: 0 0 16px 0; color: var(--text-muted); font-size: 14px;">${t('post.counter_notice_explanation')}</p>
    <div style="margin-bottom: 16px;">
      <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_name_label')}</label>
      <input type="text" class="cn-name" style="
        width: 100%; padding: 8px; border: 1px solid var(--border);
        border-radius: 4px; background: var(--bg-primary); color: var(--text-primary);
        font-size: 14px; box-sizing: border-box;
      " placeholder="${t('post.counter_notice_name_placeholder')}">
    </div>
    <div style="margin-bottom: 16px;">
      <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_email_label')}</label>
      <input type="email" class="cn-email" style="
        width: 100%; padding: 8px; border: 1px solid var(--border);
        border-radius: 4px; background: var(--bg-primary); color: var(--text-primary);
        font-size: 14px; box-sizing: border-box;
      " placeholder="${t('post.counter_notice_email_placeholder')}">
    </div>
    <div style="margin-bottom: 16px;">
      <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_address_label')}</label>
      <input type="text" class="cn-address" style="
        width: 100%; padding: 8px; border: 1px solid var(--border);
        border-radius: 4px; background: var(--bg-primary); color: var(--text-primary);
        font-size: 14px; box-sizing: border-box;
      " placeholder="${t('post.counter_notice_address_placeholder')}">
    </div>
    <div style="margin-bottom: 16px;">
      <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_phone_label')}</label>
      <input type="tel" class="cn-phone" style="
        width: 100%; padding: 8px; border: 1px solid var(--border);
        border-radius: 4px; background: var(--bg-primary); color: var(--text-primary);
        font-size: 14px; box-sizing: border-box;
      " placeholder="${t('post.counter_notice_phone_placeholder')}">
    </div>
    <label style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; cursor: pointer;">
      <input type="checkbox" class="cn-statement" style="margin-top: 2px;">
      <span style="font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_statement')}</span>
    </label>
    <label style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 16px; cursor: pointer;">
      <input type="checkbox" class="cn-consent" style="margin-top: 2px;">
      <span style="font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_consent')}</span>
    </label>
    <div style="display: flex; justify-content: flex-end;">
      <button class="submit-btn" disabled style="
        padding: 10px 24px; background: var(--accent); border: none;
        border-radius: 9999px; color: #000;
        font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px; cursor: pointer; opacity: 0.5;
      ">${t('common.submit')}</button>
    </div>
  `;
}

async function submitCounterNotice(
  postId: string,
  data: {
    name: string;
    email: string;
    address: string;
    phone: string;
    statement: boolean;
    consent_jurisdiction: boolean;
  },
): Promise<void> {
  try {
    const response = await fetch(`/api/posts/${postId}/counter-notice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(data),
    });

    if (response.status === 409) {
      showToast(t('post.counter_notice_already'));
      return;
    }

    if (!response.ok) {
      const errorData = (await response.json()) as { error?: string };
      throw new Error(errorData?.error || 'Failed to submit counter-notice');
    }

    showToast(t('post.counter_notice_submitted'));
  } catch (error) {
    console.error('Counter-notice error:', error);
    showToast(t('post.counter_notice_failed'), true);
  }
}

export function openCounterNoticeModal(postId: string): void {
  const { overlay, dialog, close } = createModalOverlay('520px');
  dialog.innerHTML = buildDialogHtml();
  document.body.appendChild(overlay);

  const submitBtn = dialog.querySelector('.submit-btn') as HTMLButtonElement;
  const closeBtn = dialog.querySelector('.close-btn');
  const nameInput = dialog.querySelector('.cn-name') as HTMLInputElement;
  const emailInput = dialog.querySelector('.cn-email') as HTMLInputElement;
  const addressInput = dialog.querySelector('.cn-address') as HTMLInputElement;
  const phoneInput = dialog.querySelector('.cn-phone') as HTMLInputElement;
  const statementCheckbox = dialog.querySelector('.cn-statement') as HTMLInputElement;
  const consentCheckbox = dialog.querySelector('.cn-consent') as HTMLInputElement;

  const checkEnabled = () => {
    const valid =
      nameInput.value.trim().length > 0 &&
      emailInput.value.trim().length > 0 &&
      addressInput.value.trim().length > 0 &&
      phoneInput.value.trim().length > 0 &&
      statementCheckbox.checked &&
      consentCheckbox.checked;
    submitBtn.disabled = !valid;
    submitBtn.style.opacity = valid ? '1' : '0.5';
  };

  [nameInput, emailInput, addressInput, phoneInput].forEach((el) => {
    el.addEventListener('input', checkEnabled);
  });
  statementCheckbox.addEventListener('change', checkEnabled);
  consentCheckbox.addEventListener('change', checkEnabled);

  closeBtn?.addEventListener('click', close);

  submitBtn?.addEventListener('click', async () => {
    close();
    await submitCounterNotice(postId, {
      name: nameInput.value.trim(),
      email: emailInput.value.trim(),
      address: addressInput.value.trim(),
      phone: phoneInput.value.trim(),
      statement: statementCheckbox.checked,
      consent_jurisdiction: consentCheckbox.checked,
    });
  });
}
