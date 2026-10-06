export const FLASH_PLAYER_BOOTSTRAP = `
    var swfData = null;
    var ruffleLoaded = false;
    var playerContainer = document.getElementById('player');
    var loadFailedText = playerContainer
      ? playerContainer.getAttribute('data-load-failed') || 'Failed to load SWF.'
      : 'Failed to load SWF.';

    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'SWF_DATA') {
        swfData = e.data.data;
        tryStart();
      }
    });

    window.parent.postMessage('FLASH_IFRAME_READY', '*');

    var script = document.createElement('script');
    script.src = 'https://unpkg.com/@ruffle-rs/ruffle@0.1.0-nightly.2025.3.8/ruffle.js';
    // #95: pin the exact nightly with SRI — unpkg serves it byte-stable.
    script.integrity = 'sha384-w75+P3sM7trOxKqGYRXCs9wo5AHk7ArjlnQXp/0lg3snxMjUW+FWDm90ItjUnNks';
    script.crossOrigin = 'anonymous';
    script.onload = function() {
      ruffleLoaded = true;
      tryStart();
    };
    script.onerror = function() {
      var error = document.createElement('div');
      error.style.color = '#666';
      error.style.textAlign = 'center';
      error.style.padding = '20px';
      error.textContent = 'Failed to load Ruffle runtime.';
      if (playerContainer) playerContainer.replaceChildren(error);
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
        var errorNode = document.createElement('div');
        errorNode.style.color = '#666';
        errorNode.style.textAlign = 'center';
        errorNode.style.padding = '20px';
        errorNode.textContent = loadFailedText;
        container.replaceChildren(errorNode);
      });
    }
  `;

export function buildFlashPlayerDocument(title: string, loadFailedText: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtmlAttribute(title)}</title>
  <style>
    body, html {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    #player {
      width: 100%;
      height: 100%;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
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
  <div id="player" data-load-failed="${escapeHtmlAttribute(loadFailedText)}"></div>
  <script>${FLASH_PLAYER_BOOTSTRAP}</script>
</body>
</html>`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&#39;');
}
