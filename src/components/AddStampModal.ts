import { t } from '../lib/i18n.js';
import { registerModal } from '../lib/modal-state.js';

interface AddStampModalProps {
  onUploaded: () => void;
}

export function createAddStampModal({ onUploaded }: AddStampModalProps): void {
  const unregister = registerModal();

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  `;

  const modal = document.createElement('div');
  modal.style.cssText = `
    background: var(--bg-primary);
    width: 400px;
    max-width: 90vw;
    max-height: 90vh;
    overflow-y: auto;
    border-radius: 16px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  `;

  // Header
  const header = document.createElement('div');
  header.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--border);
  `;

  const title = document.createElement('h2');
  title.textContent = t('settings.add_stamp_modal_title') || 'Add Custom Emoji';
  title.style.cssText = 'margin: 0; font-size: 1.125rem; font-weight: 600; color: var(--text-primary);';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = `
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    color: var(--text-muted);
    padding: 0.25rem 0.5rem;
    line-height: 1;
  `;

  header.appendChild(title);
  header.appendChild(closeBtn);

  // Body
  const body = document.createElement('div');
  body.style.cssText = 'padding: 1.5rem;';

  // Image preview area
  let selectedFile: File | null = null;
  let previewDataUrl: string | null = null;

  const previewArea = document.createElement('div');
  previewArea.style.cssText = `
    width: 120px;
    height: 120px;
    margin: 0 auto 1rem;
    border: 2px dashed var(--border);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
    overflow: hidden;
    background: var(--bg-secondary);
  `;

  const previewPlaceholder = document.createElement('div');
  previewPlaceholder.style.cssText = 'text-align: center; color: var(--text-muted); font-size: 0.8125rem;';

  const plusIcon = document.createElement('div');
  plusIcon.textContent = '+';
  plusIcon.style.cssText = 'font-size: 2rem; line-height: 1; margin-bottom: 0.25rem;';

  const placeholderText = document.createElement('div');
  placeholderText.textContent = t('settings.add_stamp_preview') || 'Click to select image';

  previewPlaceholder.appendChild(plusIcon);
  previewPlaceholder.appendChild(placeholderText);

  const previewImg = document.createElement('img');
  previewImg.style.cssText = 'width: 100%; height: 100%; object-fit: contain; display: none;';

  previewArea.appendChild(previewPlaceholder);
  previewArea.appendChild(previewImg);

  // Hidden file input
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp';
  fileInput.style.display = 'none';

  previewArea.addEventListener('click', () => fileInput.click());

  previewArea.addEventListener('mouseenter', () => {
    previewArea.style.borderColor = 'var(--accent)';
    previewArea.style.background = 'var(--bg-hover, rgba(0,0,0,0.02))';
  });
  previewArea.addEventListener('mouseleave', () => {
    previewArea.style.borderColor = 'var(--border)';
    previewArea.style.background = 'var(--bg-secondary)';
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      msg.textContent = t('settings.custom_emoji_too_large') || 'File too large (max 5MB)';
      msg.style.color = 'var(--danger)';
      return;
    }
    selectedFile = file;
    const reader = new FileReader();
    reader.onload = () => {
      previewDataUrl = reader.result as string;
      previewImg.src = previewDataUrl;
      previewImg.style.display = '';
      previewPlaceholder.style.display = 'none';
      msg.textContent = '';
    };
    reader.readAsDataURL(file);
  });

  // Name input
  const nameLabel = document.createElement('label');
  nameLabel.style.cssText =
    'display: block; margin-bottom: 0.5rem; font-size: 0.875rem; font-weight: 500; color: var(--text-primary);';
  nameLabel.textContent = 'Name';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = ':name:';
  nameInput.style.cssText = `
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 0.875rem;
    font-family: monospace;
    box-sizing: border-box;
  `;

  // Message
  const msg = document.createElement('div');
  msg.style.cssText = 'font-size: 0.8125rem; min-height: 1.25rem; margin-top: 0.5rem;';

  // Upload button
  const uploadBtn = document.createElement('button');
  uploadBtn.textContent = t('settings.custom_emoji_upload') || 'Upload';
  uploadBtn.style.cssText = `
    width: 100%;
    margin-top: 1rem;
    padding: 0.625rem;
    border: none;
    border-radius: 6px;
    background: var(--accent);
    color: white;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s;
  `;
  uploadBtn.addEventListener('mouseenter', () => {
    if (!uploadBtn.disabled) uploadBtn.style.opacity = '0.85';
  });
  uploadBtn.addEventListener('mouseleave', () => {
    if (!uploadBtn.disabled) uploadBtn.style.opacity = '1';
  });

  uploadBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!selectedFile || !name) {
      msg.textContent = t('settings.custom_emoji_fill_all') || 'Please select a file and enter a name';
      msg.style.color = 'var(--danger)';
      return;
    }
    if (!/^:[a-zA-Z0-9_]+:$/.test(name)) {
      msg.textContent = t('settings.custom_emoji_name_format') || 'Name must be in :colon_format:';
      msg.style.color = 'var(--danger)';
      return;
    }

    uploadBtn.disabled = true;
    uploadBtn.textContent = t('settings.add_stamp_uploading') || 'Uploading...';
    msg.textContent = '';

    const formData = new FormData();
    formData.append('file', selectedFile);
    formData.append('name', name);

    try {
      const res = await fetch('/api/stamps', { method: 'POST', credentials: 'include', body: formData });
      if (res.ok) {
        onUploaded();
        close();
      } else {
        const err = (await res.json()) as { error?: string };
        msg.textContent = err.error || t('settings.custom_emoji_upload_failed') || 'Upload failed';
        msg.style.color = 'var(--danger)';
      }
    } catch {
      msg.textContent = t('settings.custom_emoji_network_error') || 'Network error';
      msg.style.color = 'var(--danger)';
    }

    uploadBtn.disabled = false;
    uploadBtn.textContent = t('settings.custom_emoji_upload') || 'Upload';
  });

  body.appendChild(previewArea);
  body.appendChild(fileInput);
  body.appendChild(nameLabel);
  body.appendChild(nameInput);
  body.appendChild(msg);
  body.appendChild(uploadBtn);

  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Close handlers
  function close() {
    overlay.remove();
    unregister();
  }

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  });

  nameInput.focus();
}
