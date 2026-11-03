import { t } from '../lib/i18n.js';
import { attachIcons } from '../lib/icons.js';
import { closeWithAnimation, getTabbableElements } from '../lib/modal-overlay.js';
import { registerModal } from '../lib/modal-state.js';
import {
  canUseWebShare,
  copyToClipboard,
  createShareData,
  sharePlatforms,
  shareViaWebShare,
  shareViaWebShareWithFile,
} from '../lib/share';

export interface ShareMedia {
  blob: Blob;
  filename: string;
}

export interface ShareModalProps {
  post: {
    id: string;
    text: string;
    username: string;
    display_name?: string;
  };
  url?: string;
  media?: ShareMedia;
  onClose: () => void;
  onQuote?: () => void;
}

let shareModalId = 0;

/**
 * v3 keeps labels free of cosmetic emoji. Brand glyphs like 𝕏 / "in" stay as
 * type; an emoji glyph (the Bluesky butterfly) falls back to the initial.
 */
function displayIcon(icon: string, name: string): string {
  return /\p{Extended_Pictographic}/u.test(icon) ? name.charAt(0).toUpperCase() : icon;
}

export function createShareModal({ post, url: customUrl, media, onClose, onQuote }: ShareModalProps): HTMLElement {
  const unregister = registerModal();
  shareModalId += 1;
  const titleId = 'share-modal-title-' + String(shareModalId);
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let closing = false;
  let objectUrl: string | null = null;

  const overlay = document.createElement('div');
  overlay.className = 'fx-overlay fx-share-overlay';

  const modal = document.createElement('div');
  modal.className = 'fx-dialog fx-share-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', titleId);
  modal.tabIndex = -1;

  const platformNameKey: Record<string, string> = {
    X: 'share.platform_x',
    Facebook: 'share.platform_facebook',
    LinkedIn: 'share.platform_linkedin',
    Reddit: 'share.platform_reddit',
    Bluesky: 'share.platform_bluesky',
    Threads: 'share.platform_threads',
  };
  const getPlatformName = (name: string) => t(platformNameKey[name] || name);

  const shareData = createShareData(post);
  if (customUrl) {
    shareData.url = customUrl;
  }
  const shareUrl = shareData.url;

  if (media) {
    objectUrl = URL.createObjectURL(media.blob);
  }

  modal.innerHTML = `
    <header class="fx-share__head">
      <h3 class="fx-share__title" id="${titleId}">${t('share.title')}</h3>
      <button type="button" class="fx-icon-btn fx-share__close" aria-label="${t('common.close')}">
        <span class="action-icon" data-icon="close"></span>
      </button>
    </header>
    <div class="fx-share__body">
      ${
        media
          ? `
        <div class="fx-share__media">
          <img src="${objectUrl ?? ''}" alt="${t('share.media_preview')}">
        </div>
        <p class="fx-share__hint">${t('share.save_hint')}</p>
      `
          : ''
      }
      ${
        canUseWebShare()
          ? `
        <button type="button" class="fx-share__primary share-button--native">
          <span class="action-icon" data-icon="send"></span>
          <span>${t('share.native')}</span>
        </button>
      `
          : ''
      }
      ${
        onQuote
          ? `
        <button type="button" class="fx-share__secondary share-button--quote">
          <span class="action-icon" data-icon="quote"></span>
          <span>${t('share.quote')}</span>
        </button>
      `
          : ''
      }
      <div class="fx-share__linkrow">
        <input class="fx-share__link" type="text" readonly aria-label="${t('share.copy_link')}">
        <button type="button" class="fx-share__copy share-button--clipboard">
          <span class="action-icon" data-icon="copy"></span>
          <span>${t('share.copy_link')}</span>
        </button>
      </div>
      <div class="fx-share__divider">${t('share.share_to')}</div>
      <div class="fx-share__grid">
        ${sharePlatforms
          .map(
            (platform) => `
          <a class="fx-share__tile share-icon" href="${platform.getUrl(shareData)}" target="_blank" rel="noopener noreferrer">
            <span class="fx-share__icon" aria-hidden="true">${displayIcon(platform.icon, platform.name)}</span>
            <span class="fx-share__name">${getPlatformName(platform.name)}</span>
          </a>
        `,
          )
          .join('')}
      </div>
      <div class="fx-share__feedback" role="status" aria-live="polite"></div>
    </div>
  `;

  attachIcons(modal);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  (getTabbableElements(modal)[0] ?? modal).focus({ preventScroll: true });

  const closeButton = modal.querySelector('.fx-share__close') as HTMLButtonElement;
  const nativeShareButton = modal.querySelector('.share-button--native') as HTMLButtonElement | null;
  const clipboardButton = modal.querySelector('.share-button--clipboard') as HTMLButtonElement;
  const quoteButton = modal.querySelector('.share-button--quote') as HTMLButtonElement | null;
  const linkInput = modal.querySelector('.fx-share__link') as HTMLInputElement;
  const feedback = modal.querySelector('.fx-share__feedback') as HTMLElement;

  linkInput.value = shareUrl;
  linkInput.addEventListener('focus', () => linkInput.select());

  let feedbackTimer = 0;
  const showFeedback = (message: string) => {
    feedback.textContent = message;
    feedback.classList.add('is-visible');
    window.clearTimeout(feedbackTimer);
    feedbackTimer = window.setTimeout(() => {
      feedback.classList.remove('is-visible');
    }, 2200);
  };

  const dismiss = (after?: () => void) => {
    if (closing) return;
    closing = true;
    document.removeEventListener('keydown', onKeyDown);
    unregister();
    closeWithAnimation(overlay, () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
      if (after) {
        after();
      } else {
        if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
        onClose();
      }
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key !== 'Tab') return;

    const tabbables = getTabbableElements(modal);
    if (tabbables.length === 0) {
      event.preventDefault();
      modal.focus({ preventScroll: true });
      return;
    }
    const first = tabbables[0];
    const last = tabbables[tabbables.length - 1];
    const active = document.activeElement;
    const activeIndex = active instanceof HTMLElement ? tabbables.indexOf(active) : -1;
    if (!event.shiftKey && activeIndex === tabbables.length - 1) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && activeIndex <= 0) {
      event.preventDefault();
      last.focus();
    }
  };
  document.addEventListener('keydown', onKeyDown);

  closeButton.addEventListener('click', () => dismiss());

  if (quoteButton && onQuote) {
    quoteButton.addEventListener('click', () => dismiss(onQuote));
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss();
  });

  if (nativeShareButton) {
    nativeShareButton.addEventListener('click', async () => {
      if (media && canUseWebShare()) {
        const file = new File([media.blob], media.filename, { type: media.blob.type });
        const success = await shareViaWebShareWithFile(shareData, file);
        if (success) {
          dismiss();
        } else {
          showFeedback(t('share.native_failed'));
        }
        return;
      }
      const success = await shareViaWebShare(shareData);
      if (success) {
        dismiss();
      } else {
        showFeedback(t('share.native_failed'));
      }
    });
  }

  clipboardButton.addEventListener('click', async () => {
    const success = await copyToClipboard(shareUrl);
    showFeedback(success ? t('share.copy_success') : t('share.copy_failed'));
  });

  const shareLinks = modal.querySelectorAll('.share-icon');
  shareLinks.forEach((link) => {
    link.addEventListener('click', () => {
      dismiss();
    });
  });

  return overlay;
}
