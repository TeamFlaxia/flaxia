import { t } from '../lib/i18n.js'

export interface FlashPlayerHandle {
  destroy: () => void
}

// Global execution manager
let activeHandle: FlashPlayerHandle | null = null

// Load Ruffle dynamically from CDN
declare const RufflePlayer: any

async function loadRuffle(): Promise<any> {
  if (typeof window !== 'undefined' && (window as any).RufflePlayer) {
    return (window as any).RufflePlayer
  }

  // Load Ruffle from CDN if not available
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://unpkg.com/@ruffle-rs/ruffle@0.1.0-nightly.2025.3.8/ruffle.js'
    script.onload = () => resolve((window as any).RufflePlayer)
    script.onerror = () => reject(new Error('Failed to load Ruffle'))
    document.head.appendChild(script)
  })
}

export async function executeFlash(
  postId: string,
  containerEl: HTMLElement,
  url?: string  // if provided, fetch from this URL instead of /api/swf/${postId}
): Promise<FlashPlayerHandle> {
  // Clean up any existing execution
  if (activeHandle) {
    activeHandle.destroy()
    activeHandle = null
  }

  try {
    // Step 1: Create iframe container
    const iframeContainer = document.createElement('div')
    iframeContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      flex-direction: column;
      background: #ffffff;
    `

    // Step 2: Create HTML content with Ruffle
    const swfUrl = url || `/api/swf/${postId}`
    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${t('flash_player.title')}</title>
  <script src="https://unpkg.com/@ruffle-rs/ruffle@0.1.0-nightly.2025.3.8/ruffle.js"></script>
  <style>
    body, html {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #ffffff;
    }
    #player {
      width: 100%;
      height: 100%;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #000;
    }
    #flash-player {
      width: 100% !important;
      height: 100% !important;
      position: relative;
      max-width: 133.33vh; /* 4:3 aspect ratio (4/3 = 1.3333) */
      max-height: 75vw; /* 4:3 aspect ratio (3/4 = 0.75) */
      object-fit: contain;
    }
  </style>
</head>
<body>
  <div id="player"></div>
  <script>
    window.RufflePlayer = window.RufflePlayer || {};
    window.addEventListener('load', (event) => {
      const ruffle = window.RufflePlayer.newest();
      const player = ruffle.createPlayer();
      player.id = 'flash-player';
      player.config = {
        autoplay: 'on',
        unmuteOverlay: 'visible',
        letterbox: 'on',
        backgroundColor: '#ffffff',
        allowScriptAccess: 'never',
        allowNetworking: 'none',
        maxExecutionDuration: 15,
        frameRate: 60,
        base: window.location.origin,
        quality: 'high',
        scale: 'showAll'
      };
      
      const container = document.getElementById('player');
      container.appendChild(player);
      
      // Load the SWF file
      const swfUrlFinal = window.location.origin + "${swfUrl}";
      player.load(swfUrlFinal).catch(error => {
        console.error('Failed to load SWF:', error);
        container.innerHTML = '<div style="color: white; text-align: center; padding: 20px;">' + t('flash_player.load_failed') + '</div>';
      });
    });
  </script>
</body>
</html>
    `

    // Step 3: Create blob URL for HTML
    const htmlBlob = new Blob([htmlContent], { type: 'text/html' })
    const htmlBlobUrl = URL.createObjectURL(htmlBlob)

    // Step 4: Create iframe
    const iframe = document.createElement('iframe')
    iframe.src = htmlBlobUrl
    iframe.sandbox = 'allow-scripts allow-pointer-lock allow-fullscreen'
    iframe.setAttribute('allow', 'fullscreen')
    iframe.setAttribute('referrerpolicy', 'no-referrer')
    iframe.style.cssText = `
      flex: 1;
      width: 100%;
      height: 100%;
      border: none;
      background: #ffffff;
    `

    // Step 5: Add fullscreen button
    const fullscreenBtn = document.createElement('button')
    fullscreenBtn.textContent = t('flash_player.fullscreen')
    fullscreenBtn.className = 'flash-fullscreen-btn'
    fullscreenBtn.style.cssText = `
      margin-top: 0;
      padding: 4px 8px;
      font-size: 12px;
      border: 1px solid #ccc;
      background: #f0f0f0;
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

    // Step 6: Clear container and add elements
    containerEl.innerHTML = ''
    containerEl.appendChild(iframeContainer)
    iframeContainer.appendChild(iframe)
    iframeContainer.appendChild(fullscreenBtn)

    // Step 7: Create handle with cleanup
    const handle: FlashPlayerHandle = {
      destroy: () => {
        // Remove iframe container from DOM
        if (iframeContainer.parentNode) {
          iframeContainer.parentNode.removeChild(iframeContainer)
        }

        // Remove fullscreen button if it exists
        const fullscreenBtn = containerEl.querySelector('.flash-fullscreen-btn')
        if (fullscreenBtn) {
          fullscreenBtn.parentNode?.removeChild(fullscreenBtn)
        }

        // Revoke blob URL
        URL.revokeObjectURL(htmlBlobUrl)
      }
    }

    activeHandle = handle
    return handle

  } catch (error) {
    // Clean up on error
    if (activeHandle) {
      activeHandle.destroy()
      activeHandle = null
    }

    // Show error message in container
    containerEl.innerHTML = `
      <div style="
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        padding: 20px;
        text-align: center;
        color: #666;
      ">
        <div style="font-size: 48px; margin-bottom: 16px;">⚡</div>
        <div style="font-weight: bold; margin-bottom: 8px;">${t('flash_player.error_heading')}</div>
        <div style="font-size: 14px;">${error instanceof Error ? error.message : t('common.error')}</div>
      </div>
    `

    throw error
  }
}

// Utility function to check if a file is a valid SWF
export function isValidSwfFile(file: File): boolean {
  // Check file extension
  const ext = file.name.toLowerCase().split('.').pop()
  if (ext !== 'swf') {
    return false
  }

  // Check MIME type (some browsers may not report this correctly for SWF)
  const validTypes = ['application/x-shockwave-flash', 'application/vnd.adobe.flash.movie']
  if (file.type && !validTypes.includes(file.type)) {
    // Allow if extension is correct but MIME type is generic
    if (file.type !== '' && file.type !== 'application/octet-stream') {
      return false
    }
  }

  // Check file size (max 50MB)
  const maxSize = 50 * 1024 * 1024
  if (file.size > maxSize) {
    return false
  }

  return true
}

// Validate SWF file by checking magic bytes
export async function validateSwfFile(file: File): Promise<boolean> {
  // SWF files start with "FWS" (uncompressed), "CWS" (zlib compressed), or "ZWS" (LZMA compressed)
  const header = await file.slice(0, 3).arrayBuffer()
  const headerStr = new TextDecoder().decode(header)

  return headerStr === 'FWS' || headerStr === 'CWS' || headerStr === 'ZWS'
}
