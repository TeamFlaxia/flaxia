(function () {
  const O = typeof FRESH_PARENT_ORIGIN !== 'undefined' ? FRESH_PARENT_ORIGIN : 'https://flaxia.com';
  var MUTED = false;
  var nativePlay = null;
  var contexts = [];

  // Mirror the sandbox-wide audio mute runtime for legacy games that load this
  // bridge instead of the WVFS-injected compatibility runtime. The app mutes a
  // game while its post stage is collapsed or its view is parked.
  function applyMuted() {
    var media = document.querySelectorAll('audio,video');
    var i;
    for (i = 0; i < media.length; i++) {
      try {
        media[i].muted = MUTED;
      } catch (e) {}
    }
  }
  function applyAudioContexts() {
    var i;
    for (i = 0; i < contexts.length; i++) {
      try {
        var result = null;
        if (MUTED && contexts[i].state === 'running') result = contexts[i].suspend();
        else if (!MUTED && contexts[i].state === 'suspended') result = contexts[i].resume();
        if (result && typeof result.catch === 'function') result.catch(function () {});
      } catch (e) {}
    }
  }
  function trackAudioContexts() {
    var Native = window.AudioContext || window.webkitAudioContext;
    if (!Native || typeof Reflect === 'undefined' || !Reflect.construct) return;
    function WrappedAudioContext() {
      var context = Reflect.construct(Native, arguments);
      contexts.push(context);
      if (MUTED) {
        try {
          var suspended = context.suspend();
          if (suspended && typeof suspended.catch === 'function') suspended.catch(function () {});
        } catch (e) {}
      }
      return context;
    }
    WrappedAudioContext.prototype = Native.prototype;
    try {
      window.AudioContext = WrappedAudioContext;
    } catch (e) {}
    try {
      if (window.webkitAudioContext === Native) window.webkitAudioContext = WrappedAudioContext;
    } catch (e) {}
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== O) return;
    var data = e.data;
    if (!data || typeof data !== 'object' || data.type !== 'FLAXIA_AUDIO_MUTE') return;
    MUTED = Boolean(data.muted);
    applyMuted();
    applyAudioContexts();
  });
  try {
    if (typeof MutationObserver === 'function') {
      new MutationObserver(function () {
        if (MUTED) applyMuted();
      }).observe(document.documentElement || document, { childList: true, subtree: true });
    }
  } catch (e) {}
  try {
    nativePlay = window.HTMLMediaElement && HTMLMediaElement.prototype.play;
    if (nativePlay) {
      HTMLMediaElement.prototype.play = function () {
        if (MUTED) {
          try {
            this.muted = true;
          } catch (e) {}
        }
        return nativePlay.apply(this, arguments);
      };
    }
  } catch (e) {}

  trackAudioContexts();

  const B = {
    requestFullscreen: function () {
      try {
        parent.postMessage({ type: 'REQUEST_FULLSCREEN' }, O);
      } catch (e) {
        console.error('Failed to request fullscreen:', e);
      }
    },
    requestFresh: function () {
      try {
        parent.postMessage({ type: 'REQUEST_FRESH' }, O);
      } catch (e) {
        console.error('Failed to request fresh:', e);
      }
    },
    postScore: function (s, l) {
      try {
        const n = Number(s);
        if (Number.isNaN(n)) {
          console.warn('Invalid score:', s);
          return;
        }
        parent.postMessage({ type: 'POST_SCORE', score: n, label: String(l || '') }, O);
      } catch (e) {
        console.error('Failed to post score:', e);
      }
    },
    onMessage: function (c) {
      if (typeof c !== 'function') {
        console.warn('onMessage callback must be a function');
        return;
      }
      function h(e) {
        if (e.origin !== O) return;
        const d = e.data;
        if (!d || typeof d !== 'object') return;
        c(d.type, d);
      }
      window.addEventListener('message', h);
      return function () {
        window.removeEventListener('message', h);
      };
    },
  };
  const G = typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : self;
  G.FreshBridge = B;
  B.onMessage(function (t, d) {
    switch (t) {
      case 'FULLSCREEN_GRANTED':
        if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(function (e) {
            console.error('Failed to enter fullscreen:', e);
          });
        }
        break;
      case 'FULLSCREEN_DENIED':
        console.log('Fullscreen request denied');
        break;
      case 'FRESH_GRANTED':
        console.log('Fresh! granted');
        break;
      case 'FRESH_DENIED':
        console.log('Fresh! denied');
        break;
      case 'SCORE_SUBMITTED':
        console.log('Score submitted:', d.score, d.label);
        break;
    }
  });
})();
