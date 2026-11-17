export const MAX_SANDBOX_ZIP_PREVIEW_BYTES = 25 * 1024 * 1024;

/**
 * Parent → game message used to silence a running game without destroying its
 * frame (collapsed post stage, parked view). The game document is opaque, so
 * this is the only channel available. Kept as a plain string because both the
 * trusted shells and the injected sandbox runtime need it without a bundler.
 */
export const GAME_AUDIO_MUTE_MESSAGE = 'FLAXIA_AUDIO_MUTE';

/**
 * Runtime injected into every WVFS game document (and the local ZIP preview)
 * before game scripts run. It mutes existing media immediately, keeps new
 * media muted while the parent asked for it, and listens for the typed
 * message above. Media created through the Web Audio API cannot be reached;
 * this covers <audio>/<video> and the HTML5 autoplay path.
 */
export const GAME_AUDIO_MUTE_RUNTIME = `(function () {
  var muted = false;
  var contexts = [];
  function apply(root) {
    if (!root || !root.querySelectorAll) return;
    var nodes = root.querySelectorAll('audio,video');
    for (var i = 0; i < nodes.length; i++) {
      try { nodes[i].muted = muted; } catch (error) {}
    }
  }
  function applyAudioContexts() {
    for (var i = 0; i < contexts.length; i++) {
      var context = contexts[i];
      try {
        var result = null;
        if (muted && context.state === 'running') result = context.suspend();
        else if (!muted && context.state === 'suspended') result = context.resume();
        if (result && typeof result.catch === 'function') result.catch(function () {});
      } catch (error) {}
    }
  }
  function trackAudioContexts() {
    var Native = window.AudioContext || window.webkitAudioContext;
    if (!Native || typeof Reflect === 'undefined' || !Reflect.construct) return;
    function WrappedAudioContext() {
      var context = Reflect.construct(Native, arguments);
      contexts.push(context);
      if (muted) {
        try {
          var suspended = context.suspend();
          if (suspended && typeof suspended.catch === 'function') suspended.catch(function () {});
        } catch (error) {}
      }
      return context;
    }
    WrappedAudioContext.prototype = Native.prototype;
    try { window.AudioContext = WrappedAudioContext; } catch (error) {}
    try {
      if (window.webkitAudioContext === Native) window.webkitAudioContext = WrappedAudioContext;
    } catch (error) {}
  }
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== '${GAME_AUDIO_MUTE_MESSAGE}') return;
    muted = Boolean(data.muted);
    apply(document);
    applyAudioContexts();
  });
  var Observer = window.MutationObserver;
  if (Observer) {
    try {
      new Observer(function () { if (muted) apply(document); }).observe(
        document.documentElement || document,
        { childList: true, subtree: true },
      );
    } catch (error) {}
  }
  var media = window.HTMLMediaElement;
  if (media && media.prototype && typeof media.prototype.play === 'function') {
    var nativePlay = media.prototype.play;
    media.prototype.play = function () {
      if (muted) {
        try { this.muted = true; } catch (error) {}
      }
      return nativePlay.apply(this, arguments);
    };
  }
  trackAudioContexts();
})();`;

const PREVIEW_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function isPreviewId(value) {
  return typeof value === 'string' && PREVIEW_ID_PATTERN.test(value);
}

export function isSandboxZipPreviewMessage(value) {
  if (!isRecord(value)) return false;
  if (value.type === 'PREVIEW_INIT') return isPreviewId(value.requestId);
  return (
    value.type === 'EXECUTE_ZIP' &&
    isPreviewId(value.postId) &&
    value.zipData instanceof ArrayBuffer &&
    value.zipData.byteLength <= MAX_SANDBOX_ZIP_PREVIEW_BYTES
  );
}

export function isParentZipPreviewMessage(value) {
  if (!isRecord(value)) return false;
  if (value.type === 'ZIP_PREVIEW_READY') return isPreviewId(value.requestId);
  if (value.type === 'ZIP_READY') return isPreviewId(value.postId);
  return (
    value.type === 'ZIP_ERROR' &&
    isPreviewId(value.postId) &&
    typeof value.error === 'string' &&
    value.error.length <= 500
  );
}

export function isPreviewFullscreenRequest(value) {
  return isRecord(value) && value.type === 'REQUEST_FULLSCREEN';
}
