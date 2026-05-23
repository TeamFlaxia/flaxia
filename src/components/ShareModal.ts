import { t } from '../lib/i18n.js'
import { sharePlatforms, createShareData, copyToClipboard, canUseWebShare, shareViaWebShare } from '../lib/share'
import { registerModal } from '../lib/modal-state.js'

export interface ShareModalProps {
  post: {
    id: string
    text: string
    username: string
    display_name?: string
  }
  onClose: () => void
}

export function createShareModal({ post, onClose }: ShareModalProps): HTMLElement {
  const unregister = registerModal()
  const overlay = document.createElement('div')
  overlay.className = 'share-modal-overlay'
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
  `

  const modal = document.createElement('div')
  modal.className = 'share-modal'
  modal.style.cssText = `
    background: var(--bg-primary);
    border-radius: 0.75rem;
    max-width: 420px;
    width: 100%;
    max-height: 85vh;
    overflow-y: auto;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
  `

  const platformNameKey: Record<string, string> = {
    X: 'share.platform_x',
    Facebook: 'share.platform_facebook',
    LinkedIn: 'share.platform_linkedin',
    Reddit: 'share.platform_reddit',
    Bluesky: 'share.platform_bluesky',
    Threads: 'share.platform_threads',
  }
  const getPlatformName = (name: string) => t(platformNameKey[name] || name)

  const shareData = createShareData(post)
  const shareUrl = shareData.url
  const shareText = shareData.text

  modal.innerHTML = `
    <div class="share-modal-header" style="
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border);
    ">
      <h3 style="
        margin: 0;
        font-size: 1.125rem;
        font-weight: 600;
        color: var(--text-primary);
      ">${t('share.title')}</h3>
      <button class="share-modal-close" style="
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 1.5rem;
        cursor: pointer;
        padding: 0.25rem;
        line-height: 1;
        border-radius: 4px;
        transition: background 0.2s;
      ">✕</button>
    </div>
    <div class="share-modal-content" style="
      padding: 1.25rem;
    ">
      ${canUseWebShare() ? `
        <button class="share-button share-button--native" style="
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.75rem;
          padding: 0.875rem 1rem;
          background: var(--accent);
          border: none;
          border-radius: 0.5rem;
          color: #000;
          font-size: 0.9375rem;
          font-weight: 500;
          cursor: pointer;
          margin-bottom: 1rem;
          transition: opacity 0.2s;
        ">
          <span style="font-size: 1.25rem;">📤</span>
          <span>${t('share.native')}</span>
        </button>
      ` : ''}
      <button class="share-button share-button--clipboard" style="
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        padding: 0.875rem 1rem;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        color: var(--text-primary);
        font-size: 0.9375rem;
        font-weight: 500;
        cursor: pointer;
        margin-bottom: 1rem;
        transition: background 0.2s;
      ">
        <span style="font-size: 1.25rem;">📋</span>
        <span>${t('share.copy_link')}</span>
      </button>
      <div class="share-toast" style="
        display: none;
        text-align: center;
        padding: 0.5rem;
        margin-bottom: 1rem;
        background: var(--accent);
        color: #000;
        border-radius: 0.375rem;
        font-size: 0.875rem;
      "></div>
      <div class="share-divider" style="
        display: flex;
        align-items: center;
        gap: 1rem;
        margin: 1rem 0;
        color: var(--text-muted);
        font-size: 0.8125rem;
      ">
        <span style="flex: 1; height: 1px; background: var(--border);"></span>
        <span>${t('share.share_to')}</span>
        <span style="flex: 1; height: 1px; background: var(--border);"></span>
      </div>
      <div class="share-grid" style="
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.75rem;
      ">
        ${sharePlatforms.map(platform => `
          <a class="share-icon" href="${platform.getUrl(shareData)}" target="_blank" rel="noopener noreferrer" style="
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 0.875rem 0.5rem;
            background: var(--bg-secondary);
            border-radius: 0.5rem;
            text-decoration: none;
            color: var(--text-primary);
            transition: background 0.2s, transform 0.2s;
          ">
            <span style="
              width: 2.5rem;
              height: 2.5rem;
              display: flex;
              align-items: center;
              justify-content: center;
              background: ${platform.color};
              color: #fff;
              border-radius: 50%;
              font-size: 1.125rem;
              font-weight: 600;
              margin-bottom: 0.375rem;
            ">${platform.icon}</span>
            <span style="font-size: 0.75rem; font-weight: 500;">${getPlatformName(platform.name)}</span>
          </a>
        `).join('')}
      </div>
    </div>
  `

  overlay.appendChild(modal)
  document.body.appendChild(overlay)

  const closeButton = modal.querySelector('.share-modal-close') as HTMLButtonElement
  const nativeShareButton = modal.querySelector('.share-button--native') as HTMLButtonElement
  const clipboardButton = modal.querySelector('.share-button--clipboard') as HTMLButtonElement
  const toast = modal.querySelector('.share-toast') as HTMLElement

  const showToast = (message: string) => {
    toast.textContent = message
    toast.style.display = 'block'
    setTimeout(() => {
      toast.style.display = 'none'
    }, 2000)
  }

  const close = () => {
    unregister()
    overlay.remove()
    onClose()
  }

  closeButton.addEventListener('click', close)

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      close()
    }
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close()
    }
  })

  if (nativeShareButton) {
    nativeShareButton.addEventListener('click', async () => {
      const success = await shareViaWebShare(shareData)
      if (success) {
        close()
      } else {
        showToast(t('share.native_failed'))
      }
    })
  }

  clipboardButton.addEventListener('click', async () => {
    const success = await copyToClipboard(shareUrl)
    if (success) {
      showToast(t('share.copy_success'))
    } else {
      showToast(t('share.copy_failed'))
    }
  })

  const shareLinks = modal.querySelectorAll('.share-icon')
  shareLinks.forEach(link => {
    link.addEventListener('click', () => {
      close()
    })
  })

  return overlay
}
