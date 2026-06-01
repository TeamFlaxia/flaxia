import { t } from '../lib/i18n.js'

export interface FlashPlayerHandle {
  destroy: () => void
}

let activeHandle: FlashPlayerHandle | null = null

export async function executeFlash(
  postId: string,
  containerEl: HTMLElement,
  url?: string,
  hideFullscreen: boolean = false,
): Promise<FlashPlayerHandle> {
  if (activeHandle) {
    activeHandle.destroy()
    activeHandle = null
  }

  try {
    const swfUrl = url || `/api/swf/${postId}`

    // Start SWF fetch immediately — parallel with iframe creation
    const swfPromise = fetch(swfUrl).then(r => {
      if (!r.ok) throw new Error('Failed to fetch SWF')
      return r.arrayBuffer()
    })

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

    const loadFailedText = t('flash_player.load_failed')
    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${t('flash_player.title')}</title>
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
      max-width: 133.33vh;
      max-height: 75vw;
      object-fit: contain;
    }
  </style>
</head>
<body>
  <div id="player"></div>
  <script>
    var swfData = null;
    var ruffleLoaded = false;

    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'SWF_DATA') {
        swfData = e.data.data;
        tryStart();
      }
    });

    window.parent.postMessage('FLASH_IFRAME_READY', '*');

    var script = document.createElement('script');
    script.src = 'https://unpkg.com/@ruffle-rs/ruffle@0.1.0-nightly.2025.3.8/ruffle.js';
    script.onload = function() {
      ruffleLoaded = true;
      tryStart();
    };
    script.onerror = function() {
      document.getElementById('player').innerHTML =
        '<div style="color:white;text-align:center;padding:20px;">Failed to load Ruffle runtime.</div>';
    };
    document.head.appendChild(script);

    function tryStart() {
      if (!ruffleLoaded || !swfData) return;

      window.RufflePlayer = window.RufflePlayer || {};
      var ruffle = window.RufflePlayer.newest();
      var player = ruffle.createPlayer();
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

      var container = document.getElementById('player');
      container.appendChild(player);

      player.load({ data: new Uint8Array(swfData) }).catch(function(error) {
        console.error('Failed to load SWF:', error);
        container.innerHTML = '<div style="color:white;text-align:center;padding:20px;">${loadFailedText}</div>';
      });
    }
  </script>
</body>
</html>
    `

    const htmlBlob = new Blob([htmlContent], { type: 'text/html' })
    const htmlBlobUrl = URL.createObjectURL(htmlBlob)

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

    // Set up iframe-ready listener BEFORE adding iframe to DOM (avoid race)
    let iframeReady = false
    const readyHandler = (e: MessageEvent) => {
      if (e.data === 'FLASH_IFRAME_READY') {
        iframeReady = true
      }
    }
    window.addEventListener('message', readyHandler)

    containerEl.innerHTML = ''
    containerEl.appendChild(iframeContainer)
    iframeContainer.appendChild(iframe)
    if (!hideFullscreen) {
      iframeContainer.appendChild(fullscreenBtn)
    }

    // Wait for SWF data (fetched in parallel with iframe setup)
    const swfData = await swfPromise

    // Wait for iframe to signal readiness
    if (!iframeReady) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (iframeReady) return resolve()
          setTimeout(check, 10)
        }
        check()
      })
    }
    window.removeEventListener('message', readyHandler)

    iframe.contentWindow?.postMessage(
      { type: 'SWF_DATA', data: swfData },
      '*',
      [swfData],
    )

    const handle: FlashPlayerHandle = {
      destroy: () => {
        if (iframeContainer.parentNode) {
          iframeContainer.parentNode.removeChild(iframeContainer)
        }

        const btn = containerEl.querySelector('.flash-fullscreen-btn')
        if (btn) {
          btn.parentNode?.removeChild(btn)
        }

        URL.revokeObjectURL(htmlBlobUrl)
      },
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

export function isValidSwfFile(file: File): boolean {
  const ext = file.name.toLowerCase().split('.').pop()
  if (ext !== 'swf') return false

  const validTypes = ['application/x-shockwave-flash', 'application/vnd.adobe.flash.movie']
  if (file.type && !validTypes.includes(file.type)) {
    if (file.type !== '' && file.type !== 'application/octet-stream') return false
  }

  const maxSize = 50 * 1024 * 1024
  if (file.size > maxSize) return false

  return true
}

export async function validateSwfFile(file: File): Promise<boolean> {
  const header = await file.slice(0, 3).arrayBuffer()
  const headerStr = new TextDecoder().decode(header)
  return headerStr === 'FWS' || headerStr === 'CWS' || headerStr === 'ZWS'
}
