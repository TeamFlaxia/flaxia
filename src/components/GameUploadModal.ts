import { getMimeType } from '../lib/file-extensions.js';
import { t } from '../lib/i18n.js';
import { registerModal } from '../lib/modal-state.js';
import { showToast } from '../lib/toast.js';

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_THUMBNAIL_SIZE = 1024 * 1024;
const ALLOWED_EXTS = ['zip', 'html', 'htm'];

export interface GameUploadModalProps {
  onUploaded: (postId: string) => void;
}

export class GameUploadModal {
  private overlay: HTMLElement;
  private dialog: HTMLElement;
  private unregister: () => void;
  private props: GameUploadModalProps;
  private fileInput!: HTMLInputElement;
  private thumbnailInput!: HTMLInputElement;
  private titleInput!: HTMLInputElement;
  private submitBtn!: HTMLButtonElement;
  private fileArea!: HTMLElement;
  private fileLabel!: HTMLElement;
  private thumbnailArea!: HTMLElement;
  private selectedFile: File | null = null;
  private selectedThumbnail: File | null = null;
  private isSubmitting = false;

  constructor(props: GameUploadModalProps) {
    this.props = props;
    this.unregister = registerModal();
    this.overlay = this.createOverlay();
    this.dialog = this.createDialog();
    document.body.appendChild(this.overlay);
    this.overlay.appendChild(this.dialog);
    document.addEventListener('keydown', this.boundKeyDown);
  }

  private boundKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !this.isSubmitting) {
      this.close();
    }
  };

  private close(): void {
    if (this.isSubmitting) return;
    document.removeEventListener('keydown', this.boundKeyDown);
    this.unregister();
    this.overlay.remove();
  }

  private createOverlay(): HTMLElement {
    const overlay = document.createElement('div');
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
    `;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        this.close();
      }
    });
    return overlay;
  }

  private createDialog(): HTMLElement {
    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 12px;
      max-width: 480px;
      width: 92%;
      max-height: 88vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    `;
    const titleWrap = document.createElement('div');
    titleWrap.style.cssText = 'display: flex; flex-direction: column;';
    const title = document.createElement('span');
    title.style.cssText = 'font-weight: 600; font-size: 1rem; color: var(--text-primary);';
    title.textContent = t('arcade.upload_title');
    const subtitle = document.createElement('span');
    subtitle.style.cssText = 'font-size: 0.75rem; color: var(--text-muted);';
    subtitle.textContent = t('arcade.upload_subtitle');
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText =
      'background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 1.1rem; padding: 0.25rem;';
    closeBtn.addEventListener('click', () => this.close());
    closeBtn.title = t('common.close');
    header.appendChild(titleWrap);
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.style.cssText =
      'padding: 1rem; display: flex; flex-direction: column; gap: 0.9rem; overflow-y: auto; flex: 1;';

    // Title input
    const titleLabel = document.createElement('label');
    titleLabel.style.cssText =
      'font-size: 0.8rem; font-weight: 600; color: var(--text-muted); display: block; margin-bottom: 0.3rem;';
    titleLabel.textContent = t('arcade.upload_title_label');
    this.titleInput = document.createElement('input');
    this.titleInput.type = 'text';
    this.titleInput.maxLength = 200;
    this.titleInput.placeholder = t('arcade.upload_title_placeholder');
    this.titleInput.style.cssText = `
      width: 100%;
      padding: 0.55rem 0.7rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 0.9rem;
      box-sizing: border-box;
    `;
    this.titleInput.addEventListener('input', () => this.updateSubmitButton());
    body.appendChild(titleLabel);
    body.appendChild(this.titleInput);

    // File area
    this.fileArea = document.createElement('div');
    this.fileArea.tabIndex = 0;
    this.fileArea.style.cssText = `
      border: 1.5px dashed var(--border);
      border-radius: 10px;
      padding: 1.2rem;
      text-align: center;
      cursor: pointer;
      color: var(--text-muted);
      transition: border-color 0.2s, background 0.2s;
    `;
    this.fileArea.addEventListener('click', () => this.fileInput.click());
    this.fileArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.fileInput.click();
      }
    });
    this.fileLabel = document.createElement('div');
    this.fileLabel.style.cssText =
      'display: flex; flex-direction: column; align-items: center; gap: 0.4rem; font-size: 0.85rem;';
    this.fileLabel.innerHTML = `<span style="font-size: 2rem; line-height: 1;">📦</span>`;
    const fileHint = document.createElement('div');
    fileHint.textContent = t('arcade.upload_file_hint');
    this.fileLabel.appendChild(fileHint);
    this.fileArea.appendChild(this.fileLabel);
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.zip,.html,.htm';
    this.fileInput.style.display = 'none';
    this.fileInput.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.handleFileSelection(file);
    });
    this.fileArea.appendChild(this.fileInput);
    body.appendChild(this.fileArea);

    // Thumbnail area
    this.thumbnailArea = document.createElement('div');
    this.thumbnailArea.style.cssText = 'display: flex; align-items: center; gap: 0.6rem;';
    this.thumbnailInput = document.createElement('input');
    this.thumbnailInput.type = 'file';
    this.thumbnailInput.accept = '.jpg,.jpeg,.png,.gif,.webp';
    this.thumbnailInput.style.display = 'none';
    this.thumbnailInput.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.handleThumbnailSelection(file);
    });
    const thumbnailBtn = document.createElement('button');
    thumbnailBtn.type = 'button';
    thumbnailBtn.textContent = t('arcade.upload_thumbnail_button');
    thumbnailBtn.style.cssText = `
      flex-shrink: 0;
      padding: 0.45rem 0.9rem;
      background: none;
      border: 1px solid var(--border);
      border-radius: 9999px;
      color: var(--text-primary);
      font-size: 0.8rem;
      cursor: pointer;
      font-family: inherit;
    `;
    thumbnailBtn.addEventListener('click', () => this.thumbnailInput.click());
    const thumbnailHint = document.createElement('span');
    thumbnailHint.style.cssText = 'font-size: 0.75rem; color: var(--text-muted); flex: 1; word-break: break-all;';
    thumbnailHint.textContent = this.selectedThumbnail
      ? this.selectedThumbnail.name
      : t('arcade.upload_thumbnail_hint');
    this.thumbnailArea.appendChild(thumbnailBtn);
    this.thumbnailArea.appendChild(thumbnailHint);
    this.thumbnailArea.appendChild(this.thumbnailInput);
    body.appendChild(this.thumbnailArea);

    dialog.appendChild(body);

    // Footer
    const footer = document.createElement('div');
    footer.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 0.6rem;
      padding: 0.75rem 1rem;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    `;
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = t('common.cancel');
    cancelBtn.style.cssText = `
      padding: 0.5rem 1rem;
      background: none;
      border: 1px solid var(--border);
      border-radius: 9999px;
      color: var(--text-primary);
      cursor: pointer;
      font-size: 0.85rem;
      font-family: inherit;
    `;
    cancelBtn.addEventListener('click', () => this.close());
    this.submitBtn = document.createElement('button');
    this.submitBtn.type = 'button';
    this.submitBtn.disabled = true;
    this.submitBtn.textContent = t('arcade.upload_submit');
    this.submitBtn.style.cssText = `
      padding: 0.5rem 1.4rem;
      background: var(--accent);
      border: none;
      border-radius: 9999px;
      color: #000;
      cursor: pointer;
      font-size: 0.85rem;
      font-weight: 600;
      font-family: inherit;
      opacity: 0.5;
    `;
    this.submitBtn.addEventListener('click', () => void this.handleSubmit());
    footer.appendChild(cancelBtn);
    footer.appendChild(this.submitBtn);
    dialog.appendChild(footer);

    return dialog;
  }

  private handleFileSelection(file: File): void {
    if (file.size > MAX_FILE_SIZE) {
      showToast(t('arcade.upload_file_too_large'), true);
      return;
    }

    const ext = file.name.toLowerCase().split('.').pop() || '';
    if (!ALLOWED_EXTS.includes(ext)) {
      showToast(t('arcade.upload_file_type_error'), true);
      return;
    }

    this.selectedFile = file;
    this.renderFileLabel();
    this.updateSubmitButton();
  }

  private renderFileLabel(): void {
    if (!this.selectedFile) return;
    const typeLabel = this.selectedFile.name.toLowerCase().endsWith('.zip') ? ' (HTML5)' : '';
    this.fileLabel.innerHTML = `<span style="font-size: 2rem; line-height: 1;">📦</span>`;
    const name = document.createElement('div');
    name.style.cssText = 'font-weight: 600; color: var(--text-primary); font-size: 0.9rem; word-break: break-all;';
    name.textContent = `${this.selectedFile.name}${typeLabel}`;
    const size = document.createElement('div');
    size.style.cssText = 'font-size: 0.75rem; color: var(--text-muted);';
    size.textContent = this.formatFileSize(this.selectedFile.size);
    this.fileLabel.appendChild(name);
    this.fileLabel.appendChild(size);
  }

  private handleThumbnailSelection(file: File): void {
    if (file.size > MAX_THUMBNAIL_SIZE) {
      showToast(t('arcade.upload_thumbnail_too_large'), true);
      return;
    }
    const ext = file.name.toLowerCase().split('.').pop() || '';
    if (!['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
      showToast(t('arcade.upload_thumbnail_type_error'), true);
      return;
    }
    this.selectedThumbnail = file;
    this.thumbnailInput.value = '';
    const hint = this.thumbnailArea.querySelector('span:not(:first-child)') as HTMLElement | null;
    if (hint) hint.textContent = file.name;
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return t('file_size.bytes', { size: bytes });
    if (bytes < 1024 * 1024) return t('file_size.kb', { size: (bytes / 1024).toFixed(1) });
    return t('file_size.mb', { size: (bytes / (1024 * 1024)).toFixed(1) });
  }

  private updateSubmitButton(): void {
    const hasFile = !!this.selectedFile;
    const hasTitle = this.titleInput.value.trim().length > 0 && this.titleInput.value.trim().length <= 200;
    this.submitBtn.disabled = !hasFile || !hasTitle || this.isSubmitting;
    this.submitBtn.style.opacity = this.submitBtn.disabled ? '0.5' : '1';
    this.submitBtn.textContent = this.isSubmitting ? t('arcade.upload_uploading') : t('arcade.upload_submit');
  }

  private async handleSubmit(): Promise<void> {
    const file = this.selectedFile;
    const title = this.titleInput.value.trim();
    if (!file) {
      showToast(t('arcade.upload_file_required'), true);
      return;
    }
    if (!title || title.length > 200) {
      showToast(t('arcade.upload_title_required'), true);
      return;
    }
    if (this.isSubmitting) return;
    this.isSubmitting = true;
    this.updateSubmitButton();

    try {
      // Step 1: Prepare pending post
      const prepareResult = await this.preparePost(file);
      if (!prepareResult?.zipUploadUrl || !prepareResult?.zipKey) throw new Error('Failed to prepare post');

      // Step 2: Upload the game file directly
      const uploadSuccess = await this.uploadFileDirect(file, prepareResult.zipUploadUrl);
      if (!uploadSuccess) throw new Error('Failed to upload game file');

      // Step 3: Commit the post (multipart when a thumbnail is attached)
      const postId = prepareResult.postId;
      const commitSuccess = await this.commitPost(postId, prepareResult.zipKey, title);
      if (!commitSuccess) throw new Error('Failed to publish game');

      showToast(t('arcade.upload_success'));
      this.isSubmitting = false;
      this.close();
      this.props.onUploaded(postId);
    } catch (error) {
      console.error('Game upload failed:', error);
      showToast(t('arcade.upload_failed'), true);
      this.isSubmitting = false;
      this.updateSubmitButton();
    }
  }

  private async preparePost(file: File): Promise<{ postId: string; zipKey?: string; zipUploadUrl?: string } | null> {
    try {
      const response = await fetch('/api/posts/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || getMimeType(file.name),
        }),
      });
      if (!response.ok) {
        let errMsg = 'Failed to prepare post';
        try {
          const errBody = (await response.json()) as { error?: string };
          if (errBody?.error) errMsg += `: ${errBody.error}`;
        } catch {}
        throw new Error(errMsg);
      }
      const result = (await response.json()) as {
        postId: string;
        zipUploadUrl?: string;
        zipKey?: string;
        swfUploadUrl?: string;
        swfKey?: string;
        gifUploadUrl?: string;
        gifKey?: string;
      };
      if (result.zipUploadUrl && result.zipKey) {
        return { postId: result.postId, zipKey: result.zipKey, zipUploadUrl: result.zipUploadUrl };
      }
      if (result.swfUploadUrl && result.swfKey) {
        return { postId: result.postId, zipKey: result.swfKey, zipUploadUrl: result.swfUploadUrl };
      }
      if (result.gifUploadUrl && result.gifKey) {
        return { postId: result.postId, zipKey: result.gifKey, zipUploadUrl: result.gifUploadUrl };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async uploadFileDirect(file: File, uploadUrl: string): Promise<boolean> {
    try {
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
        credentials: 'include',
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async commitPost(postId: string, zipKey: string, title: string): Promise<boolean> {
    try {
      if (this.selectedThumbnail) {
        const formData = new FormData();
        formData.append('text', title);
        formData.append('postId', postId);
        formData.append('payloadKey', zipKey);
        formData.append('thumbnail', this.selectedThumbnail);
        const response = await fetch('/api/posts/commit', {
          method: 'POST',
          credentials: 'include',
          body: formData,
        });
        return response.ok;
      }

      const hashtagRegex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu;
      const hashtagSet = new Set<string>();
      let match: RegExpExecArray | null;
      while ((match = hashtagRegex.exec(title)) !== null) {
        hashtagSet.add(match[1]);
      }

      const response = await fetch('/api/posts/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          postId,
          zipKey,
          text: title,
          hashtags: Array.from(hashtagSet),
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
