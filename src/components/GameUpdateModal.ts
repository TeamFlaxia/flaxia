import { t } from '../lib/i18n.js';
import { registerModal } from '../lib/modal-state.js';

export interface GameUpdateModalProps {
  postId: string;
  sandboxOrigin: string;
  onUpdated: () => void;
}

export function openGameUpdateModal(props: GameUpdateModalProps): void {
  const unregister = registerModal();
  const overlay = document.createElement('div');
  overlay.className = 'game-update-modal-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
  `;

  const modal = document.createElement('div');
  modal.className = 'game-update-modal';
  modal.style.cssText = `
    background: var(--bg-primary);
    border-radius: 0.75rem;
    max-width: 460px;
    width: 100%;
    max-height: 85vh;
    overflow-y: auto;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
    padding: 1.25rem;
  `;

  const title = document.createElement('h2');
  title.textContent = t('game.update_title');
  title.style.cssText = `
    margin: 0 0 0.25rem 0;
    font-size: 1.125rem;
    color: var(--text-primary);
  `;
  modal.appendChild(title);

  const subtitle = document.createElement('p');
  subtitle.textContent = t('game.update_subtitle');
  subtitle.style.cssText = `
    margin: 0 0 1rem 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
  `;
  modal.appendChild(subtitle);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.zip,application/zip';
  fileInput.style.cssText = `
    display: block;
    width: 100%;
    margin-bottom: 0.75rem;
    color: var(--text-primary);
  `;
  modal.appendChild(fileInput);

  const changelogLabel = document.createElement('label');
  changelogLabel.textContent = t('game.changelog_label');
  changelogLabel.style.cssText = `
    display: block;
    font-size: 0.8125rem;
    color: var(--text-primary);
    margin-bottom: 0.25rem;
  `;
  modal.appendChild(changelogLabel);

  const changelog = document.createElement('textarea');
  changelog.placeholder = t('game.changelog_placeholder');
  changelog.style.cssText = `
    display: block;
    width: 100%;
    min-height: 80px;
    resize: vertical;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-input);
    color: var(--text-primary);
    font-family: inherit;
    font-size: 0.875rem;
    margin-bottom: 1rem;
  `;
  modal.appendChild(changelog);

  const status = document.createElement('div');
  status.style.cssText = `
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin-bottom: 0.75rem;
    min-height: 1.125rem;
  `;
  modal.appendChild(status);

  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = `
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  `;

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = t('common.cancel');
  cancelBtn.style.cssText = `
    padding: 0.5rem 1rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-primary);
    color: var(--text-primary);
    cursor: pointer;
    font-size: 0.875rem;
  `;

  const submitBtn = document.createElement('button');
  submitBtn.textContent = t('game.update_submit');
  submitBtn.style.cssText = `
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 0.5rem;
    background: var(--accent, #22c55e);
    color: #fff;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 600;
  `;

  const close = () => {
    unregister();
    overlay.remove();
  };
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  submitBtn.addEventListener('click', async () => {
    const file = fileInput.files?.[0];
    if (!file) {
      status.textContent = t('game.update_error_no_file');
      status.style.color = 'var(--danger, #e74c3c)';
      return;
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      status.textContent = t('game.update_error_not_zip');
      status.style.color = 'var(--danger, #e74c3c)';
      return;
    }

    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    status.style.color = 'var(--text-muted)';
    status.textContent = t('game.update_status_preparing');

    try {
      const prepareResp = await fetch(`/api/posts/${props.postId}/versions/prepare`, { method: 'POST' });
      if (!prepareResp.ok) {
        const err = (await prepareResp.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || 'prepare failed');
      }
      const prepare = (await prepareResp.json()) as { versionId: string; zipUploadUrl: string };

      status.textContent = t('game.update_status_uploading');
      const uploadResp = await fetch(prepare.zipUploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/zip' },
        body: file,
      });
      if (!uploadResp.ok) {
        const err = (await uploadResp.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || 'upload failed');
      }

      status.textContent = t('game.update_status_committing');
      const commitResp = await fetch(`/api/posts/${props.postId}/versions/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: prepare.versionId, changelog: changelog.value }),
      });
      if (!commitResp.ok) {
        const err = (await commitResp.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || 'commit failed');
      }

      status.textContent = t('game.update_status_done');
      props.onUpdated();
      close();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      status.style.color = 'var(--danger, #e74c3c)';
      status.textContent = `${t('game.update_error')}: ${message}`;
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  });

  buttonRow.appendChild(cancelBtn);
  buttonRow.appendChild(submitBtn);
  modal.appendChild(buttonRow);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}
