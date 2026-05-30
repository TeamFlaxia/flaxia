import { t } from '../lib/i18n.js'

export interface DosPlayerHandle {
  destroy: () => void
}

let activeHandle: DosPlayerHandle | null = null

function isTauri(): boolean {
  try {
    return typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window)
  } catch {
    return false
  }
}

function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === 'lvh.me'
  } catch {
    return false
  }
}

const FLAXIA_ORIGIN = 'https://flaxia.app'

export async function executeDos(
  postId: string,
  containerEl: HTMLElement,
  url?: string,
  hideFullscreen: boolean = false
): Promise<DosPlayerHandle> {
  if (activeHandle) {
    activeHandle.destroy()
    activeHandle = null
  }

  try {
    const iframeContainer = document.createElement('div')
    iframeContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      flex-direction: column;
      background: #000;
    `

    const currentOrigin = window.location.origin
    const isLocalDev = isLocalOrigin(currentOrigin)
    const apiOrigin = import.meta.env.VITE_CONTENT_ORIGIN || (isTauri() && !isLocalDev ? FLAXIA_ORIGIN : currentOrigin)
    const zipUrl = url || `${apiOrigin}/api/zip/${postId}`
    const dosPlayerUrl = `${apiOrigin}/api/dos-player/${postId}?zip_url=${encodeURIComponent(zipUrl)}&load_failed=${encodeURIComponent(t('dos_player.load_failed'))}`

    const iframe = document.createElement('iframe')
    iframe.sandbox = 'allow-scripts allow-pointer-lock allow-fullscreen'
    iframe.src = dosPlayerUrl
    iframe.setAttribute('allow', 'fullscreen')
    iframe.setAttribute('referrerpolicy', 'no-referrer')
    iframe.style.cssText = `
      flex: 1;
      width: 100%;
      height: 100%;
      border: none;
      background: #000;
    `

    const fullscreenBtn = document.createElement('button')
    fullscreenBtn.textContent = t('dos_player.fullscreen')
    fullscreenBtn.className = 'dos-fullscreen-btn'
    fullscreenBtn.style.cssText = `
      margin-top: 0;
      padding: 4px 8px;
      font-size: 12px;
      border: 1px solid #555;
      background: #222;
      color: #fff;
      cursor: pointer;
      border-radius: 4px;
      align-self: center;
    `
    fullscreenBtn.onclick = (event) => {
      event.preventDefault()
      event.stopPropagation()
      try {
        if (iframeContainer.requestFullscreen) {
          iframeContainer.requestFullscreen().catch((err: Error) => {
            console.warn('Container fullscreen failed:', err)
            if (iframe.requestFullscreen) {
              iframe.requestFullscreen().catch((err2: Error) => {
                console.warn('Iframe fullscreen failed:', err2)
              })
            }
          })
        } else if (iframe.requestFullscreen) {
          iframe.requestFullscreen().catch((err: Error) => {
            console.warn('Iframe fullscreen failed:', err)
          })
        }
      } catch (error) {
        console.error('Fullscreen error:', error)
      }
    }

    containerEl.innerHTML = ''
    containerEl.appendChild(iframeContainer)
    iframeContainer.appendChild(iframe)
    if (!hideFullscreen) {
      iframeContainer.appendChild(fullscreenBtn)
    }

    const handle: DosPlayerHandle = {
      destroy: () => {
        if (iframeContainer.parentNode) {
          iframeContainer.parentNode.removeChild(iframeContainer)
        }
        const btn = containerEl.querySelector('.dos-fullscreen-btn')
        if (btn) btn.parentNode?.removeChild(btn)
      }
    }

    activeHandle = handle
    return handle

  } catch (error) {
    if (activeHandle) {
      activeHandle.destroy()
      activeHandle = null
    }

    containerEl.innerHTML = `
      <div style="
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        padding: 20px;
        text-align: center;
        color: #999;
        background: #000;
      ">
        <div style="font-size: 48px; margin-bottom: 16px;">💾</div>
        <div style="font-weight: bold; margin-bottom: 8px; color: #fff;">${t('dos_player.error_heading')}</div>
        <div style="font-size: 14px;">${error instanceof Error ? error.message : t('common.error')}</div>
      </div>
    `

    throw error
  }
}
