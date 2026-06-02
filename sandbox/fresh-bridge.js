(function () {
  const O = typeof FRESH_PARENT_ORIGIN !== 'undefined' ? FRESH_PARENT_ORIGIN : 'https://flaxia.com';
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
