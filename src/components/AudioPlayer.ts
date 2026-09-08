import { t } from '../lib/i18n.js';
import { GifPreviewProps } from '../types/post.js';
import { AudioVisualizer } from './AudioVisualizer.js';

export function createAudioPlayer(props: GifPreviewProps): HTMLElement {
  const container = document.createElement('div');
  container.className = 'audio-player';
  container.tabIndex = 0;

  if (!props.gifKey && !props.src) {
    const fallback = document.createElement('div');
    fallback.className = 'audio-player-error';
    fallback.textContent = t('audio.no_audio');
    container.appendChild(fallback);
    return container;
  }

  // --- Audio element (hidden; the visualizer is the surface) ---
  const audio = document.createElement('audio');
  audio.className = 'audio-player-element';
  audio.preload = 'metadata';
  audio.setAttribute('playsinline', 'true');
  audio.oncontextmenu = (e) => e.preventDefault();
  audio.setAttribute('controlsList', 'nodownload');
  audio.style.position = 'absolute';
  audio.style.width = '0';
  audio.style.height = '0';
  audio.style.opacity = '0';
  audio.style.pointerEvents = 'none';

  const audioUrl = props.src || `/api/audio/${props.gifKey || ''}`;

  const visualizerCanvas = document.createElement('canvas');
  visualizerCanvas.className = 'audio-visualizer-canvas';

  // --- Error / loading / overlay ---
  const errorEl = document.createElement('div');
  errorEl.className = 'audio-player-error';
  errorEl.style.display = 'none';

  const loadingEl = document.createElement('div');
  loadingEl.className = 'audio-player-loading';
  const spinner = document.createElement('div');
  spinner.className = 'audio-player-spinner';
  loadingEl.appendChild(spinner);

  const overlay = document.createElement('div');
  overlay.className = 'audio-player-overlay';

  const bigPlayBtn = document.createElement('button');
  bigPlayBtn.className = 'audio-player-big-play';
  bigPlayBtn.innerHTML = ICONS.play;

  overlay.appendChild(bigPlayBtn);

  const controls = document.createElement('div');
  controls.className = 'audio-player-controls';

  const seekbarRow = document.createElement('div');
  seekbarRow.className = 'audio-player-seekbar-row';

  const seekbar = document.createElement('div');
  seekbar.className = 'audio-player-seekbar';
  const seekbarTrack = document.createElement('div');
  seekbarTrack.className = 'audio-player-seekbar-track';
  const seekbarBuffered = document.createElement('div');
  seekbarBuffered.className = 'audio-player-seekbar-buffered';
  const seekbarProgress = document.createElement('div');
  seekbarProgress.className = 'audio-player-seekbar-progress';
  const seekbarThumb = document.createElement('div');
  seekbarThumb.className = 'audio-player-seekbar-thumb';

  seekbarTrack.appendChild(seekbarBuffered);
  seekbarTrack.appendChild(seekbarProgress);
  seekbarTrack.appendChild(seekbarThumb);
  seekbar.appendChild(seekbarTrack);
  seekbarRow.appendChild(seekbar);

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'audio-player-buttons-row';

  const playBtn = document.createElement('button');
  playBtn.className = 'audio-player-btn audio-player-btn-play';
  playBtn.innerHTML = ICONS.play;

  const timeCurrent = document.createElement('span');
  timeCurrent.className = 'audio-player-time';
  timeCurrent.textContent = '0:00';

  const timeSep = document.createElement('span');
  timeSep.className = 'audio-player-time-sep';
  timeSep.textContent = '/';

  const timeDuration = document.createElement('span');
  timeDuration.className = 'audio-player-time';
  timeDuration.textContent = '0:00';

  const spacer = document.createElement('div');
  spacer.className = 'audio-player-spacer';

  const volumeWrap = document.createElement('div');
  volumeWrap.className = 'audio-player-volume-wrap';
  const volumeBtn = document.createElement('button');
  volumeBtn.className = 'audio-player-btn audio-player-volume-btn';
  volumeBtn.innerHTML = ICONS.volumeHigh;
  const volumeSlider = document.createElement('input');
  volumeSlider.type = 'range';
  volumeSlider.className = 'audio-player-volume-slider';
  volumeSlider.min = '0';
  volumeSlider.max = '1';
  volumeSlider.step = '0.05';
  volumeSlider.value = '1';

  const speedBtn = document.createElement('button');
  speedBtn.className = 'audio-player-btn audio-player-speed-btn';
  speedBtn.textContent = '1x';

  volumeWrap.appendChild(volumeBtn);
  volumeWrap.appendChild(volumeSlider);
  buttonsRow.appendChild(playBtn);
  buttonsRow.appendChild(timeCurrent);
  buttonsRow.appendChild(timeSep);
  buttonsRow.appendChild(timeDuration);
  buttonsRow.appendChild(spacer);
  buttonsRow.appendChild(volumeWrap);
  buttonsRow.appendChild(speedBtn);
  controls.appendChild(seekbarRow);
  controls.appendChild(buttonsRow);

  container.appendChild(audio);
  container.appendChild(visualizerCanvas);
  container.appendChild(errorEl);
  container.appendChild(loadingEl);
  container.appendChild(overlay);
  container.appendChild(controls);

  let isDragging = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let initTimer: ReturnType<typeof setTimeout> | null = null;
  let speedIndex = 1;
  let visualizer: AudioVisualizer | null = null;

  const showControls = () => {
    controls.classList.remove('audio-player-controls--hidden');
    overlay.style.opacity = '1';
    resetHideTimer();
  };

  const hideControls = () => {
    if (!audio.paused && !isDragging) {
      controls.classList.add('audio-player-controls--hidden');
      overlay.style.opacity = '0';
    }
  };

  const resetHideTimer = () => {
    if (hideTimer) clearTimeout(hideTimer);
    if (!audio.paused) {
      hideTimer = setTimeout(hideControls, 3000);
    }
  };

  const updatePlayButton = () => {
    if (audio.paused || audio.ended) {
      bigPlayBtn.style.display = 'flex';
      playBtn.innerHTML = ICONS.play;
    } else {
      bigPlayBtn.style.display = 'none';
      playBtn.innerHTML = ICONS.pause;
    }
  };

  const updateVolumeIcon = () => {
    if (audio.muted || audio.volume === 0) {
      volumeBtn.innerHTML = ICONS.volumeMuted;
    } else if (audio.volume < 0.5) {
      volumeBtn.innerHTML = ICONS.volumeLow;
    } else {
      volumeBtn.innerHTML = ICONS.volumeHigh;
    }
  };

  const updateSeekbar = () => {
    if (!isDragging && audio.duration) {
      const pct = (audio.currentTime / audio.duration) * 100;
      seekbarProgress.style.width = `${pct}%`;
      seekbarThumb.style.left = `${pct}%`;
    }
    timeCurrent.textContent = formatTime(audio.currentTime);
  };

  const updateBuffered = () => {
    if (audio.buffered.length > 0 && audio.duration) {
      const end = audio.buffered.end(audio.buffered.length - 1);
      seekbarBuffered.style.width = `${(end / audio.duration) * 100}%`;
    }
  };

  const togglePlay = () => {
    if (audio.paused || audio.ended) {
      // Visualizer must be created AFTER the src is set, because
      // createMediaElementSource() severs the media-element→graph connection
      // when the element's src is assigned afterwards. The src is assigned
      // synchronously on init, so create the visualizer and start playback.
      ensureVisualizer();
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  };

  const seekTo = (clientX: number) => {
    if (!audio.duration) return;
    const rect = seekbarTrack.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
    updateSeekbar();
  };

  const setVolume = (val: number) => {
    audio.muted = false;
    audio.volume = Math.max(0, Math.min(1, val));
    volumeSlider.value = audio.volume.toString();
    updateVolumeIcon();
  };

  // --- Initialize source (deferred for Chrome) ---
  initTimer = setTimeout(() => {
    initTimer = null;
    audio.src = audioUrl;
    audio.load();
    // If the user already started playback before the src was attached, make
    // sure the visualizer is created too.
    if (!audio.paused && !visualizer) {
      ensureVisualizer();
    }
  }, 100);

  // --- Visualizer is created lazily on first play so idle audio posts don't
  // each reserve an AudioContext (browsers cap how many can stay alive). ---
  // It must only run AFTER audio.src is assigned: createMediaElementSource()
  // severs the element→graph connection if the src changes afterwards.
  const ensureVisualizer = () => {
    if (visualizer) return;
    if (!audio.src) return;
    try {
      visualizer = new AudioVisualizer(audio, visualizerCanvas);
    } catch (error) {
      console.warn('Failed to initialize audio visualizer:', error);
    }
  };

  // --- Error handling ---
  const showError = () => {
    loadingEl.style.display = 'none';
    overlay.style.display = 'none';
    controls.style.display = 'none';
    visualizerCanvas.style.display = 'none';
    errorEl.style.display = 'flex';
    errorEl.innerHTML = `
      <div class="audio-player-error-content">
        <span class="audio-player-error-text">${t('audio.load_failed', { error: t('common.error') })}</span>
        <button class="audio-player-retry-btn">${t('video_player.retry')}</button>
      </div>
    `;
    errorEl.querySelector('.audio-player-retry-btn')?.addEventListener('click', () => {
      errorEl.style.display = 'none';
      visualizerCanvas.style.display = 'block';
      controls.style.display = '';
      overlay.style.display = '';
      loadingEl.style.display = '';
      audio.src = audioUrl + '?_=' + Date.now();
      audio.load();
    });
  };

  // --- Audio events ---
  audio.addEventListener('loadstart', () => {
    loadingEl.style.display = 'flex';
    errorEl.style.display = 'none';
  });

  audio.addEventListener('canplay', () => {
    loadingEl.style.display = 'none';
  });

  audio.addEventListener('waiting', () => {
    loadingEl.style.display = 'flex';
  });

  audio.addEventListener('playing', () => {
    loadingEl.style.display = 'none';
    updatePlayButton();
  });

  audio.addEventListener('play', updatePlayButton);
  audio.addEventListener('pause', () => {
    updatePlayButton();
    showControls();
  });

  audio.addEventListener('ended', () => {
    updatePlayButton();
    showControls();
  });

  audio.addEventListener('timeupdate', () => {
    updateSeekbar();
    updateBuffered();
  });

  audio.addEventListener('progress', updateBuffered);

  audio.addEventListener('loadedmetadata', () => {
    timeDuration.textContent = formatTime(audio.duration);
    container.classList.add('audio-player--loaded');
  });

  audio.addEventListener('error', () => {
    showError();
  });

  audio.addEventListener('volumechange', updateVolumeIcon);

  // --- Overlay click (tap the surface = play/pause) ---
  overlay.addEventListener('click', () => {
    togglePlay();
  });

  // --- Big play button ---
  bigPlayBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlay();
  });

  // --- Play button ---
  playBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlay();
  });

  // --- Seekbar ---
  seekbarTrack.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDragging = true;
    seekTo(e.clientX);
    container.classList.add('audio-player--scrubbing');
  });

  // --- Seekbar (drag tracking lives on document so the thumb follows the
  // pointer even outside the track) ---
  const onDocumentMouseMove = (e: MouseEvent) => {
    if (isDragging) {
      seekTo(e.clientX);
    }
  };

  const onDocumentMouseUp = () => {
    if (isDragging) {
      isDragging = false;
      container.classList.remove('audio-player--scrubbing');
      resetHideTimer();
    }
  };

  document.addEventListener('mousemove', onDocumentMouseMove);
  document.addEventListener('mouseup', onDocumentMouseUp);

  seekbarTrack.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      isDragging = true;
      const touch = e.touches[0];
      seekTo(touch.clientX);
    },
    { passive: false },
  );

  seekbarTrack.addEventListener(
    'touchmove',
    (e) => {
      if (isDragging) {
        e.preventDefault();
        const touch = e.touches[0];
        seekTo(touch.clientX);
      }
    },
    { passive: false },
  );

  seekbarTrack.addEventListener('touchend', () => {
    isDragging = false;
    resetHideTimer();
  });

  // --- Volume ---
  volumeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    audio.muted = !audio.muted;
    updateVolumeIcon();
    volumeSlider.value = audio.muted ? '0' : audio.volume.toString();
  });

  volumeSlider.addEventListener('input', () => {
    setVolume(parseFloat(volumeSlider.value));
  });

  // --- Speed ---
  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    speedIndex = (speedIndex + 1) % SPEEDS.length;
    audio.playbackRate = SPEEDS[speedIndex];
    speedBtn.textContent = `${SPEEDS[speedIndex]}x`;
  });

  // --- Controls show/hide ---
  container.addEventListener('mousemove', showControls);
  container.addEventListener('mouseenter', showControls);
  container.addEventListener('mouseleave', () => {
    if (!audio.paused) {
      hideControls();
    }
  });
  container.addEventListener('focus', showControls);
  container.addEventListener('blur', () => {
    if (!audio.paused) {
      hideControls();
    }
  });

  // --- Keyboard shortcuts ---
  container.addEventListener('keydown', (e) => {
    switch (e.key) {
      case ' ':
      case 'k':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        audio.currentTime = Math.max(0, audio.currentTime - 5);
        updateSeekbar();
        break;
      case 'ArrowRight':
        e.preventDefault();
        audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
        updateSeekbar();
        break;
      case 'ArrowUp':
        e.preventDefault();
        setVolume(audio.volume + 0.1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        setVolume(audio.volume - 0.1);
        break;
      case 'm':
        e.preventDefault();
        volumeBtn.click();
        break;
    }
  });

  // --- Cleanup ---
  container.addEventListener('DOMNodeRemoved', () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (initTimer) {
      clearTimeout(initTimer);
      initTimer = null;
    }
    document.removeEventListener('mousemove', onDocumentMouseMove);
    document.removeEventListener('mouseup', onDocumentMouseUp);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (visualizer) {
      visualizer.cleanup();
      visualizer = null;
    }
  });

  updatePlayButton();
  showControls();

  return container;
}

// Legacy export for backward compatibility
export function createGifPreview(props: GifPreviewProps): HTMLElement {
  if (props.gifKey && props.gifKey.startsWith('audio/')) {
    return createAudioPlayer(props);
  }

  const container = document.createElement('div');
  container.className = 'image-preview';

  if (!props.gifKey) {
    const fallback = document.createElement('div');
    fallback.className = 'image-preview-error';
    fallback.textContent = t('image_preview.no_preview');
    container.appendChild(fallback);
    return container;
  }

  const img = document.createElement('img');
  img.className = 'image-preview-img';
  img.alt = t('image_preview.post_preview', { id: props.postId });
  img.loading = 'lazy';

  if (props.src) {
    img.src = props.src;
  } else {
    img.src = `/api/images/${props.gifKey}?_=${Date.now()}`;
  }

  img.onerror = () => {
    img.style.display = 'none';
    const fallback = document.createElement('div');
    fallback.className = 'image-preview-error';
    fallback.textContent = t('image_preview.load_failed');
    container.appendChild(fallback);
  };

  container.appendChild(img);
  return container;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function svgIcon(paths: string, viewBox = '0 0 24 24'): string {
  return `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

const ICONS = {
  play: svgIcon('<polygon points="6 3 20 12 6 21 6 3"/>'),
  pause: svgIcon('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'),
  volumeHigh: svgIcon('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>'),
  volumeLow: svgIcon('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>'),
  volumeMuted: svgIcon(
    '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>',
  ),
} as const;

const SPEEDS = [0.5, 1, 1.5, 2] as const;
