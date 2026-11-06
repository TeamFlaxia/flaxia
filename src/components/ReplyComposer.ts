import { attachPlusBadge } from '../lib/avatar.js';
import { AttachPreviewHandle, checkImageSizeLimit, renderFilePreview } from '../lib/file-preview.js';
import { formatCount } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { attachIcons } from '../lib/icons.js';
import { nativeApiHref } from '../lib/native-api.js';
import { showToast } from '../lib/toast.js';
import { markRecommendationProfileDirty } from '../lib/vault/recommendation-profile.js';
import { Post } from '../types/post.js';
import { showSignInPrompt } from './SignInPrompt.js';

export interface ReplyComposerProps {
  postId: string;
  sandboxOrigin: string;
  onReplyCreated: (newReply: Post) => void;
  onCancel: () => void;
  prefillText?: string;
  currentUser?: {
    username: string;
    id: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
  } | null;
}

export class ReplyComposer {
  private element: HTMLElement;
  private props: ReplyComposerProps;
  private textarea!: HTMLTextAreaElement;
  private fileInput!: HTMLInputElement;
  private submitButton!: HTMLButtonElement;
  private cancelButton!: HTMLButtonElement;
  private charCount!: HTMLSpanElement;
  private charMeter!: HTMLElement;
  private selectedFile: File | null = null;
  private isSubmitting = false;
  private previewHandle: AttachPreviewHandle | null = null;
  private mentionDropdown!: HTMLElement;
  private mentionTimeout: ReturnType<typeof setTimeout> | null = null;
  private mentionQuery: string = '';
  private mentionStartPos: number = -1;
  private mentionType: 'user' | 'tag' = 'user';

  constructor(props: ReplyComposerProps) {
    this.props = props;
    this.element = this.createElement();
    // Apply the prefill after `this.element` exists: updateCharMeter() writes
    // the progress custom property on the composer root, so calling it from
    // createElement() would throw before the property is assigned (and abort
    // the whole thread render when reply cards pass a `>>N` prefill).
    if (this.props.prefillText) {
      this.textarea.value = this.props.prefillText;
      this.updateCharMeter(this.props.prefillText.length);
      this.autosizeTextarea();
    }
    this.setupEventListeners();
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'reply-composer';

    container.innerHTML = `
      <div class="reply-composer-body">
        <div class="reply-composer-header">
          <div class="reply-composer-avatar"></div>
          <textarea 
            class="reply-composer-textarea" 
            placeholder="${t('reply_composer.placeholder')}"
            maxlength="200"
          ></textarea>
        </div>
        <div class="composer-progress" aria-hidden="true"><span class="composer-progress-fill"></span></div>
        <div class="reply-composer-file-dropzone" style="display: none;">
          <div class="dropzone-content">
            <span class="dropzone-icon" data-icon="attach"></span>
            <span class="dropzone-text">${t('reply_composer.file_hint')}</span>
          </div>
        </div>
        <div class="reply-composer-divider"></div>
        <div class="reply-composer-footer">
          <div class="reply-composer-actions">
            <input type="file" class="reply-composer-file-input" accept=".gif,.png,.jpg,.jpeg,.mp3,.wav,.ogg,.m4a,.webm" />
            <div class="reply-composer-attach-group">
              <button class="reply-composer-file-button reply-composer-file-button--image" type="button" title="${t('composer.attach_image_video')}" aria-label="${t('composer.attach_image_video')}">
                <span class="action-icon" data-icon="image-video"></span>
              </button>
              <button class="reply-composer-file-button reply-composer-file-button--audio" type="button" title="${t('composer.attach_audio')}" aria-label="${t('composer.attach_audio')}">
                <span class="action-icon" data-icon="audio"></span>
              </button>
            </div>
            <span class="composer-meter" data-state="idle" data-empty="true">
              <span class="composer-char-count reply-composer-char-count">0/200</span>
            </span>
          </div>
          <div class="reply-composer-buttons">
            <button class="reply-composer-cancel" type="button">${t('reply_composer.cancel')}</button>
            <button class="reply-composer-submit" type="button" disabled>${t('reply_composer.reply')}</button>
          </div>
        </div>
        <div class="reply-composer-file-preview" style="display: none;">
          <div class="file-info">
            <span class="file-name"></span>
            <button class="file-remove" type="button"><span class="action-icon" data-icon="close"></span></button>
          </div>
        </div>
      </div>
    `;

    attachIcons(container);

    // Cache element references
    this.textarea = container.querySelector('.reply-composer-textarea')!;
    this.fileInput = container.querySelector('.reply-composer-file-input')!;
    this.submitButton = container.querySelector('.reply-composer-submit')!;
    this.cancelButton = container.querySelector('.reply-composer-cancel')!;
    this.charCount = container.querySelector('.reply-composer-char-count')!;
    this.charMeter = container.querySelector('.composer-meter')!;

    // Mention dropdown surface styling lives in composer.css; only position is dynamic.
    this.mentionDropdown = document.createElement('div');
    this.mentionDropdown.className = 'mention-dropdown';
    const composerHeader = container.querySelector('.reply-composer-header') as HTMLElement | null;
    if (composerHeader) {
      composerHeader.style.position = 'relative';
      composerHeader.appendChild(this.mentionDropdown);
    }

    return container;
  }

  private setupEventListeners(): void {
    // Textarea input handling
    this.textarea.addEventListener('input', () => {
      this.updateCharMeter(this.textarea.value.length);
      this.autosizeTextarea();
      this.updateSubmitButton();
      this.handleMentionInput();
    });

    // Keyboard shortcuts
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.mentionDropdown.style.display !== 'none') {
          this.hideMentionDropdown();
          return;
        }
        this.clearFileSelection();
        this.textarea.value = '';
        this.updateCharMeter(0);
        this.autosizeTextarea();
        this.updateSubmitButton();
        this.props.onCancel();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !this.submitButton.disabled) {
        e.preventDefault();
        this.handleSubmit();
        return;
      }
      if (this.mentionDropdown.style.display !== 'none') {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          this.navigateMention(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const selected = this.mentionDropdown.querySelector('.mention-item--active') as HTMLElement;
          if (selected) selected.click();
        }
      }
    });

    // File button clicks - image/video and audio
    const fileButtons = this.element.querySelectorAll('.reply-composer-file-button')!;
    fileButtons.forEach((btn) => {
      const btnEl = btn as HTMLElement;
      btnEl.addEventListener('click', () => {
        this.fileInput.accept = btnEl.classList.contains('reply-composer-file-button--audio')
          ? '.mp3,.wav,.ogg,.m4a'
          : '.gif,.png,.jpg,.jpeg,.webm';
        this.fileInput.click();
      });
    });

    // File selection
    this.fileInput.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        this.handleFileSelection(file);
      }
    });

    // File removal
    const fileRemove = this.element.querySelector('.file-remove')!;
    fileRemove.addEventListener('click', () => {
      this.clearFileSelection();
    });

    // Submit button
    this.submitButton.addEventListener('click', () => {
      this.handleSubmit();
    });

    // Cancel button
    this.cancelButton.addEventListener('click', () => {
      this.clearFileSelection();
      this.textarea.value = '';
      this.updateCharMeter(0);
      this.autosizeTextarea();
      this.updateSubmitButton();
      this.props.onCancel();
    });

    // Add missing event listeners
    this.textarea.addEventListener('paste', (e) => {
      this.handlePaste(e);
    });

    // Set user avatar
    this.initAvatar();
  }

  private handleMentionInput(): void {
    const text = this.textarea.value;
    const pos = this.textarea.selectionStart;
    const textBeforeCursor = text.slice(0, pos);
    const atMatch = textBeforeCursor.match(/@([a-zA-Z0-9_]*)$/);
    const tagMatch = textBeforeCursor.match(/#([^\s]*)$/);

    if (atMatch) {
      this.mentionType = 'user';
      this.mentionQuery = atMatch[1];
      this.mentionStartPos = pos - atMatch[0].length;
      if (this.mentionTimeout) clearTimeout(this.mentionTimeout);
      this.mentionTimeout = setTimeout(() => {
        this.fetchMentionSuggestions(this.mentionQuery || '');
      }, 200);
    } else if (tagMatch) {
      this.mentionType = 'tag';
      this.mentionQuery = tagMatch[1];
      this.mentionStartPos = pos - tagMatch[0].length;
      if (this.mentionTimeout) clearTimeout(this.mentionTimeout);
      this.mentionTimeout = setTimeout(() => {
        this.fetchTagSuggestions(this.mentionQuery || '');
      }, 200);
    } else {
      this.hideMentionDropdown();
    }
  }

  private async fetchMentionSuggestions(query: string): Promise<void> {
    try {
      const url = query
        ? `/api/search?type=users&q=${encodeURIComponent(query)}&limit=5`
        : '/api/search?type=users&q=a&limit=5';
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) return;
      const data = (await response.json()) as {
        results: Array<{ username: string; display_name: string; avatar_key: string | null }>;
      };
      this.showMentionSuggestions(data.results || []);
    } catch {
      this.hideMentionDropdown();
    }
  }

  private async fetchTagSuggestions(query: string): Promise<void> {
    try {
      const response = await fetch(`/api/tags/suggest?q=${encodeURIComponent(query)}&limit=5`);
      if (!response.ok) return;
      const data = (await response.json()) as { tags: Array<{ tag: string; count: number }> };
      this.showTagSuggestions(data.tags || []);
    } catch {
      this.hideMentionDropdown();
    }
  }

  private showMentionSuggestions(
    users: Array<{ username: string; display_name: string; avatar_key: string | null }>,
  ): void {
    if (users.length === 0) {
      this.hideMentionDropdown();
      return;
    }

    this.mentionDropdown.innerHTML = '';
    users.forEach((user, index) => {
      const item = document.createElement('div');
      item.className = `mention-item ${index === 0 ? 'mention-item--active' : ''}`;
      item.setAttribute('data-value', user.username);
      item.style.cssText = `padding: 8px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px;`;
      const avatarSpan = document.createElement('span');
      avatarSpan.style.cssText = `width: 24px; height: 24px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; color: var(--on-accent); font-size: 0.7rem; font-weight: bold; flex-shrink: 0;`;
      avatarSpan.textContent = user.username.charAt(0).toUpperCase();
      if (user.avatar_key) {
        avatarSpan.style.backgroundImage = `url(${nativeApiHref(`/api/images/${user.avatar_key}`)})`;
        avatarSpan.style.backgroundSize = 'cover';
        avatarSpan.style.backgroundPosition = 'center';
        avatarSpan.textContent = '';
      }
      const textSpan = document.createElement('span');
      textSpan.style.cssText = 'display: flex; flex-direction: column;';
      const nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'color: var(--text-primary); font-size: 0.875rem; font-weight: 500;';
      nameSpan.textContent = user.display_name || user.username;
      const handleSpan = document.createElement('span');
      handleSpan.style.cssText = 'color: var(--text-muted); font-size: 0.75rem;';
      handleSpan.textContent = `@${user.username}`;
      textSpan.appendChild(nameSpan);
      textSpan.appendChild(handleSpan);
      item.appendChild(avatarSpan);
      item.appendChild(textSpan);
      item.addEventListener('click', () => this.selectSuggestion(user.username));
      item.addEventListener('mouseenter', () => {
        this.mentionDropdown
          .querySelectorAll('.mention-item--active')
          .forEach((el) => void el.classList.remove('mention-item--active'));
        item.classList.add('mention-item--active');
      });
      this.mentionDropdown.appendChild(item);
    });
    this.mentionDropdown.style.display = 'block';
    this.positionDropdownAboveCursor();
  }

  private showTagSuggestions(tags: Array<{ tag: string; count: number }>): void {
    if (tags.length === 0) {
      this.hideMentionDropdown();
      return;
    }

    this.mentionDropdown.innerHTML = '';
    tags.forEach((tag, index) => {
      const item = document.createElement('div');
      item.className = `mention-item ${index === 0 ? 'mention-item--active' : ''}`;
      item.setAttribute('data-value', tag.tag);
      item.style.cssText = `padding: 8px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px;`;
      const hash = document.createElement('span');
      hash.textContent = '#';
      hash.style.cssText = `width: 24px; height: 24px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; color: var(--on-accent); font-size: 0.8rem; font-weight: bold; flex-shrink: 0;`;
      const textSpan = document.createElement('span');
      textSpan.style.cssText = 'display: flex; flex-direction: column;';
      const nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'color: var(--text-primary); font-size: 0.875rem; font-weight: 500;';
      nameSpan.textContent = `#${tag.tag}`;
      const countSpan = document.createElement('span');
      countSpan.style.cssText = 'color: var(--text-muted); font-size: 0.75rem;';
      countSpan.textContent = `${formatCount(tag.count)} posts`;
      textSpan.appendChild(nameSpan);
      textSpan.appendChild(countSpan);
      item.appendChild(hash);
      item.appendChild(textSpan);
      item.addEventListener('click', () => this.selectSuggestion(tag.tag));
      item.addEventListener('mouseenter', () => {
        this.mentionDropdown
          .querySelectorAll('.mention-item--active')
          .forEach((el) => void el.classList.remove('mention-item--active'));
        item.classList.add('mention-item--active');
      });
      this.mentionDropdown.appendChild(item);
    });
    this.mentionDropdown.style.display = 'block';
    this.positionDropdownAboveCursor();
  }

  private positionDropdownAboveCursor(): void {
    const ta = this.textarea;
    if (!ta || !ta.parentElement) {
      this.mentionDropdown.style.left = '0px';
      this.mentionDropdown.style.top = '40px';
      return;
    }

    const taRect = ta.getBoundingClientRect();
    const header = this.mentionDropdown.parentElement;
    if (!header) {
      this.mentionDropdown.style.left = '0px';
      this.mentionDropdown.style.top = '40px';
      return;
    }
    const headerRect = header.getBoundingClientRect();

    this.mentionDropdown.style.left = `${taRect.left - headerRect.left + 8}px`;
    this.mentionDropdown.style.top = `${taRect.bottom - headerRect.top + 4}px`;
  }

  private hideMentionDropdown(): void {
    this.mentionDropdown.style.display = 'none';
    if (this.mentionTimeout) {
      clearTimeout(this.mentionTimeout);
      this.mentionTimeout = null;
    }
  }

  private navigateMention(direction: number): void {
    const items = this.mentionDropdown.querySelectorAll('.mention-item');
    if (items.length === 0) return;
    const active = this.mentionDropdown.querySelector('.mention-item--active');
    let nextIndex = 0;
    if (active) {
      const currentIndex = Array.from(items).indexOf(active);
      active.classList.remove('mention-item--active');
      nextIndex = (currentIndex + direction + items.length) % items.length;
    }
    items[nextIndex].classList.add('mention-item--active');
  }

  private selectSuggestion(value: string): void {
    if (this.mentionStartPos < 0) return;
    const prefix = this.mentionType === 'tag' ? '#' : '@';
    const text = this.textarea.value;
    const before = text.slice(0, this.mentionStartPos);
    const after = text.slice(this.textarea.selectionStart);
    this.textarea.value = `${before}${prefix}${value} ${after}`;
    const newPos = this.mentionStartPos + value.length + 2;
    this.textarea.setSelectionRange(newPos, newPos);
    this.textarea.focus();
    this.hideMentionDropdown();
    this.updateCharMeter(this.textarea.value.length);
    this.autosizeTextarea();
    this.updateSubmitButton();
  }

  private handlePaste(e: ClipboardEvent): void {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.indexOf('image') !== -1) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          this.handleFileSelection(file);
        }
        break;
      }
    }
  }

  private async handleFileSelection(file: File): Promise<void> {
    // Check file size (25MB limit)
    if (file.size > 25 * 1024 * 1024) {
      showToast(t('reply_composer.error_file_size'), true);
      this.clearFileSelection();
      return;
    }

    // Check if file is an accepted format
    const allowedTypes = [
      'image/gif',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
      'audio/mp4',
      'audio/webm',
      'video/mp4',
      'video/webm',
      'video/quicktime',
    ];
    const isVideoByExtension =
      file.name.toLowerCase().endsWith('.mp4') ||
      file.name.toLowerCase().endsWith('.webm') ||
      file.name.toLowerCase().endsWith('.mov');
    if (!allowedTypes.includes(file.type) && !isVideoByExtension) {
      showToast(t('reply_composer.error_file_type'), true);
      this.clearFileSelection();
      return;
    }

    // Reject oversized images before the browser decodes/previews them.
    const dimError = await checkImageSizeLimit(file);
    if (dimError) {
      showToast(dimError, true);
      this.clearFileSelection();
      return;
    }

    this.selectedFile = file;
    this.showFilePreview(file);
    this.updateSubmitButton();
  }

  private clearFileSelection(): void {
    this.selectedFile = null;
    this.fileInput.value = '';
    this.hideFilePreview();
    this.updateSubmitButton();
  }

  private showFilePreview(file: File): void {
    const preview = this.element.querySelector('.reply-composer-file-preview')! as HTMLElement;
    const fileName = preview.querySelector('.file-name')!;

    this.previewHandle?.destroy();
    fileName.textContent = `${file.name} (${this.formatFileSize(file.size)})`;
    preview.style.display = 'block';
    this.previewHandle = renderFilePreview(file, preview);
  }

  private hideFilePreview(): void {
    const preview = this.element.querySelector('.reply-composer-file-preview')! as HTMLElement;
    this.previewHandle?.destroy();
    this.previewHandle = null;
    preview.style.display = 'none';
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return t('file_size.bytes', { size: bytes });
    if (bytes < 1024 * 1024) return t('file_size.kb', { size: (bytes / 1024).toFixed(1) });
    return t('file_size.mb', { size: (bytes / (1024 * 1024)).toFixed(1) });
  }

  private updateSubmitButton(): void {
    const hasContent = this.textarea.value.trim().length > 0;
    this.submitButton.disabled = !hasContent || this.isSubmitting;
    this.submitButton.textContent = this.isSubmitting ? t('reply_composer.replying') : t('reply_composer.reply');
    this.submitButton.dataset.state = this.isSubmitting ? 'sending' : 'idle';
  }

  /** Keep the text + conic-gradient progress ring in sync (ratio drives --fx-progress). */
  private updateCharMeter(length: number): void {
    this.charCount.textContent = `${length}/200`;
    const ratio = Math.max(0, Math.min(1, length / 200));
    const state = length >= 200 ? 'max' : length > 180 ? 'warn' : 'idle';
    this.element.style.setProperty('--fx-progress', ratio.toFixed(3));
    this.element.dataset.meterState = state;
    this.charMeter.dataset.state = state;
    this.charMeter.dataset.empty = String(length === 0);
  }

  /** Auto-grow the field; the height transition itself lives in composer.css. */
  private autosizeTextarea(): void {
    const textarea = this.textarea;
    // Detached textareas report scrollHeight 0; leave the CSS min-height in charge.
    if (!textarea || textarea.scrollHeight <= 0) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
  }

  private initAvatar(): void {
    const avatarEl = this.element.querySelector('.reply-composer-avatar') as HTMLElement;
    if (!avatarEl) return;
    const user = this.props.currentUser;
    if (!user) return;

    avatarEl.querySelector(':scope > .avatar-initial')?.remove();
    const initial = document.createElement('span');
    initial.className = 'avatar-initial';
    initial.textContent = user.username.charAt(0).toUpperCase();
    avatarEl.appendChild(initial);

    if (user.avatar_key) {
      const loadAvatar = () => {
        const img = new Image();
        img.onload = () => {
          avatarEl.style.backgroundImage = `url(${nativeApiHref(`/api/images/${user.avatar_key}`)})`;
          avatarEl.style.backgroundSize = 'cover';
          avatarEl.style.backgroundPosition = 'center';
          avatarEl.querySelector(':scope > .avatar-initial')?.remove();
        };
        img.onerror = () => {
          console.warn(`Failed to load avatar: ${user.avatar_key}`);
        };
        img.src = nativeApiHref(`/api/images/${user.avatar_key}`);
      };
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback?.(loadAvatar, { timeout: 1000 });
      } else {
        setTimeout(loadAvatar, 100);
      }
    }

    avatarEl.addEventListener('click', (e) => {
      e.stopPropagation();
      window.history.pushState({}, '', `/profile/${user.username}`);
      window.dispatchEvent(
        new CustomEvent('spaNavigate', {
          detail: { view: 'profile', username: user.username },
        }),
      );
    });
    avatarEl.style.cursor = 'pointer';
    attachPlusBadge(avatarEl, user.badge_type);
  }

  private async handleSubmit(): Promise<void> {
    if (this.isSubmitting) return;

    const text = this.textarea.value.trim();
    if (!text) return;

    this.isSubmitting = true;
    this.updateSubmitButton();

    try {
      let gifKey: string | undefined;
      let replyId: string | undefined;

      // Step 1: Prepare reply if file is selected
      if (this.selectedFile) {
        const prepareResult = await this.prepareReply(this.selectedFile);
        if (!prepareResult) {
          throw new Error('Failed to prepare reply');
        }

        replyId = prepareResult.replyId;
        gifKey = prepareResult.gifKey;

        // Step 2: Upload file directly to R2
        const uploadSuccess = await this.uploadFileDirect(this.selectedFile, prepareResult.gifUploadUrl);
        if (!uploadSuccess) {
          throw new Error('Failed to upload file');
        }
      }

      // Step 3: Commit reply
      const commitResult = await this.commitReply(replyId, gifKey, text);

      if (!commitResult) {
        throw new Error('Failed to commit reply');
      }
      markRecommendationProfileDirty();

      // Clear form
      this.textarea.value = '';
      this.updateCharMeter(0);
      this.autosizeTextarea();
      this.clearFileSelection();

      // Notify parent
      if (this.props.onReplyCreated && commitResult.reply) {
        this.props.onReplyCreated(commitResult.reply);
      }
    } catch (error: unknown) {
      const err = error as { message?: string };
      console.error('Failed to create reply:', err);
      const isAuthError = err?.message === t('reply_composer.error_auth_required');
      const errorMessage = isAuthError
        ? t('reply_composer.error_auth_required')
        : err?.message || t('composer.error_create_failed');
      showToast(errorMessage, true);
      if (isAuthError) {
        showSignInPrompt(
          'reply',
          () => {
            window.history.pushState({}, '', '/login');
            window.dispatchEvent(new PopStateEvent('popstate'));
          },
          () => {
            window.history.pushState({}, '', '/register');
            window.dispatchEvent(new PopStateEvent('popstate'));
          },
        );
      }
    } finally {
      this.isSubmitting = false;
      this.updateSubmitButton();
    }
  }

  private async prepareReply(file: File): Promise<{ replyId: string; gifUploadUrl: string; gifKey: string } | null> {
    const response = await fetch(`/api/posts/${this.props.postId}/replies/prepare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type,
      }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error(t('reply_composer.error_auth_required'));
      }
      console.error('Prepare reply failed:', response.status, response.statusText);
      return null;
    }

    return (await response.json()) as { replyId: string; gifUploadUrl: string; gifKey: string };
  }

  private async uploadFileDirect(file: File, uploadUrl: string): Promise<boolean> {
    try {
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type,
        },
        credentials: 'include',
      });

      if (!response.ok) {
        console.error('Upload failed:', response.status);
        return false;
      }

      return true;
    } catch {
      console.error('File upload failed');
      return false;
    }
  }

  private async commitReply(
    replyId: string | undefined,
    gifKey: string | undefined,
    text: string,
  ): Promise<{ reply: Post } | null> {
    // Extract hashtags from text
    const hashtagRegex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu;
    const hashtagSet = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = hashtagRegex.exec(text)) !== null) {
      hashtagSet.add(match[1]);
    }
    const hashtags = Array.from(hashtagSet);

    const response = await fetch(`/api/posts/${this.props.postId}/replies/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        replyId: replyId || crypto.randomUUID(),
        gifKey: gifKey,
        text,
        hashtags,
      }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error(t('reply_composer.error_auth_required'));
      }
      const error = (await response.json()) as { error?: string };
      console.error('Commit reply failed:', error);
      return null;
    }

    return (await response.json()) as { reply: Post };
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public focus(): void {
    this.textarea.focus();
  }

  public insertText(text: string): void {
    const start = this.textarea.selectionStart;
    const end = this.textarea.selectionEnd;
    const before = this.textarea.value.slice(0, start);
    const after = this.textarea.value.slice(end);
    this.textarea.value = before + text + after;
    const newPos = start + text.length;
    this.textarea.selectionStart = newPos;
    this.textarea.selectionEnd = newPos;
    this.updateCharMeter(this.textarea.value.length);
    this.autosizeTextarea();
    this.updateSubmitButton();
    this.textarea.focus();
  }

  public destroy(): void {
    this.element.remove();
  }
}

// Factory function for easier usage
export function createReplyComposer(props: ReplyComposerProps): ReplyComposer {
  return new ReplyComposer(props);
}
