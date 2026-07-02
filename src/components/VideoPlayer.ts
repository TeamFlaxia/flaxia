import { t } from '../lib/i18n.js';

export interface VideoPlayerProps {
  gifKey: string;
  postId: string;
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
  fullscreen: svgIcon(
    '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  ),
  fullscreenExit: svgIcon(
    '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="10" y1="14" x2="3" y2="21"/>',
  ),
} as const;

const SPEEDS = [0.5, 1, 1.5, 2] as const;

export function createVideoPlayer(props: VideoPlayerProps): HTMLElement {
  if (!props.gifKey) {
    const fallback = document.createElement('div');
    fallback.className = 'video-player-error';
    fallback.textContent = t('video_player.no_video');
    return fallback;
  }

  const container = document.createElement('div');
  container.className = 'video-player';
  container.tabIndex = 0;

  const video = document.createElement('video');
  video.className = 'video-player-element';
  video.preload = 'metadata';
  video.playsInline = true;

  const videoUrl = `/api/video/${props.gifKey}`;

  const errorEl = document.createElement('div');
  errorEl.className = 'video-player-error';
  errorEl.style.display = 'none';

  const loadingEl = document.createElement('div');
  loadingEl.className = 'video-player-loading';
  const spinner = document.createElement('div');
  spinner.className = 'video-player-spinner';
  loadingEl.appendChild(spinner);

  const overlay = document.createElement('div');
  overlay.className = 'video-player-overlay';

  const bigPlayBtn = document.createElement('button');
  bigPlayBtn.className = 'video-player-big-play';
  bigPlayBtn.innerHTML = ICONS.play;

  overlay.appendChild(bigPlayBtn);

  const controls = document.createElement('div');
  controls.className = 'video-player-controls';

  const seekbarRow = document.createElement('div');
  seekbarRow.className = 'video-player-seekbar-row';

  const seekbar = document.createElement('div');
  seekbar.className = 'video-player-seekbar';
  const seekbarTrack = document.createElement('div');
  seekbarTrack.className = 'video-player-seekbar-track';
  const seekbarBuffered = document.createElement('div');
  seekbarBuffered.className = 'video-player-seekbar-buffered';
  const seekbarProgress = document.createElement('div');
  seekbarProgress.className = 'video-player-seekbar-progress';
  const seekbarThumb = document.createElement('div');
  seekbarThumb.className = 'video-player-seekbar-thumb';

  seekbarTrack.appendChild(seekbarBuffered);
  seekbarTrack.appendChild(seekbarProgress);
  seekbarTrack.appendChild(seekbarThumb);
  seekbar.appendChild(seekbarTrack);
  seekbarRow.appendChild(seekbar);

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'video-player-buttons-row';

  const playBtn = document.createElement('button');
  playBtn.className = 'video-player-btn video-player-btn-play';
  playBtn.innerHTML = ICONS.play;

  const timeCurrent = document.createElement('span');
  timeCurrent.className = 'video-player-time';
  timeCurrent.textContent = '0:00';

  const timeSep = document.createElement('span');
  timeSep.className = 'video-player-time-sep';
  timeSep.textContent = '/';

  const timeDuration = document.createElement('span');
  timeDuration.className = 'video-player-time';
  timeDuration.textContent = '0:00';

  const spacer = document.createElement('div');
  spacer.className = 'video-player-spacer';

  const volumeWrap = document.createElement('div');
  volumeWrap.className = 'video-player-volume-wrap';
  const volumeBtn = document.createElement('button');
  volumeBtn.className = 'video-player-btn video-player-volume-btn';
  volumeBtn.innerHTML = ICONS.volumeHigh;
  const volumeSlider = document.createElement('input');
  volumeSlider.type = 'range';
  volumeSlider.className = 'video-player-volume-slider';
  volumeSlider.min = '0';
  volumeSlider.max = '1';
  volumeSlider.step = '0.05';
  volumeSlider.value = '1';

  const speedBtn = document.createElement('button');
  speedBtn.className = 'video-player-btn video-player-speed-btn';
  speedBtn.textContent = '1x';

  const fsBtn = document.createElement('button');
  fsBtn.className = 'video-player-btn video-player-fs-btn';
  fsBtn.innerHTML = ICONS.fullscreen;

  volumeWrap.appendChild(volumeBtn);
  volumeWrap.appendChild(volumeSlider);
  buttonsRow.appendChild(playBtn);
  buttonsRow.appendChild(timeCurrent);
  buttonsRow.appendChild(timeSep);
  buttonsRow.appendChild(timeDuration);
  buttonsRow.appendChild(spacer);
  buttonsRow.appendChild(volumeWrap);
  buttonsRow.appendChild(speedBtn);
  buttonsRow.appendChild(fsBtn);
  controls.appendChild(seekbarRow);
  controls.appendChild(buttonsRow);

  container.appendChild(video);
  container.appendChild(errorEl);
  container.appendChild(loadingEl);
  container.appendChild(overlay);
  container.appendChild(controls);

  let isDragging = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let speedIndex = 1;

  const showControls = () => {
    controls.classList.remove('video-player-controls--hidden');
    overlay.style.opacity = '1';
    resetHideTimer();
  };

  const hideControls = () => {
    if (!video.paused && !isDragging) {
      controls.classList.add('video-player-controls--hidden');
      overlay.style.opacity = '0';
    }
  };

  const resetHideTimer = () => {
    if (hideTimer) clearTimeout(hideTimer);
    if (!video.paused) {
      hideTimer = setTimeout(hideControls, 3000);
    }
  };

  const updatePlayButton = () => {
    if (video.paused || video.ended) {
      bigPlayBtn.style.display = 'flex';
      playBtn.innerHTML = ICONS.play;
    } else {
      bigPlayBtn.style.display = 'none';
      playBtn.innerHTML = ICONS.pause;
    }
  };

  const updateVolumeIcon = () => {
    if (video.muted || video.volume === 0) {
      volumeBtn.innerHTML = ICONS.volumeMuted;
    } else if (video.volume < 0.5) {
      volumeBtn.innerHTML = ICONS.volumeLow;
    } else {
      volumeBtn.innerHTML = ICONS.volumeHigh;
    }
  };

  const updateSeekbar = () => {
    if (!isDragging && video.duration) {
      const pct = (video.currentTime / video.duration) * 100;
      seekbarProgress.style.width = `${pct}%`;
      seekbarThumb.style.left = `${pct}%`;
    }
    timeCurrent.textContent = formatTime(video.currentTime);
  };

  const updateBuffered = () => {
    if (video.buffered.length > 0 && video.duration) {
      const end = video.buffered.end(video.buffered.length - 1);
      seekbarBuffered.style.width = `${(end / video.duration) * 100}%`;
    }
  };

  const togglePlay = () => {
    if (video.paused || video.ended) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  const seekTo = (clientX: number) => {
    if (!video.duration) return;
    const rect = seekbarTrack.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
    updateSeekbar();
  };

  const setVolume = (val: number) => {
    video.muted = false;
    video.volume = Math.max(0, Math.min(1, val));
    volumeSlider.value = video.volume.toString();
    updateVolumeIcon();
  };

  // --- Error handling ---
  const showError = () => {
    loadingEl.style.display = 'none';
    overlay.style.display = 'none';
    controls.style.display = 'none';
    video.style.display = 'none';
    errorEl.style.display = 'flex';
    errorEl.innerHTML = `
      <div class="video-player-error-content">
        <span class="video-player-error-text">${t('video_player.load_failed')}</span>
        <button class="video-player-retry-btn">${t('video_player.retry')}</button>
      </div>
    `;
    errorEl.querySelector('.video-player-retry-btn')?.addEventListener('click', () => {
      errorEl.style.display = 'none';
      video.style.display = 'block';
      controls.style.display = '';
      overlay.style.display = '';
      loadingEl.style.display = '';
      video.src = videoUrl;
      video.load();
    });
  };

  // --- Video events ---
  video.addEventListener('loadstart', () => {
    loadingEl.style.display = 'flex';
    errorEl.style.display = 'none';
  });

  video.addEventListener('canplay', () => {
    loadingEl.style.display = 'none';
  });

  video.addEventListener('waiting', () => {
    loadingEl.style.display = 'flex';
  });

  video.addEventListener('playing', () => {
    loadingEl.style.display = 'none';
    updatePlayButton();
  });

  video.addEventListener('play', updatePlayButton);
  video.addEventListener('pause', () => {
    updatePlayButton();
    showControls();
  });

  video.addEventListener('ended', () => {
    updatePlayButton();
    showControls();
  });

  video.addEventListener('timeupdate', () => {
    updateSeekbar();
    updateBuffered();
  });

  video.addEventListener('progress', updateBuffered);

  video.addEventListener('loadedmetadata', () => {
    timeDuration.textContent = formatTime(video.duration);
  });

  video.addEventListener('error', () => {
    showError();
  });

  video.addEventListener('volumechange', updateVolumeIcon);

  // --- Overlay click ---
  overlay.addEventListener('click', togglePlay);

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
    container.classList.add('video-player--scrubbing');
  });

  document.addEventListener('mousemove', (e) => {
    if (isDragging) {
      seekTo(e.clientX);
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      container.classList.remove('video-player--scrubbing');
      resetHideTimer();
    }
  });

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
    video.muted = !video.muted;
    updateVolumeIcon();
    volumeSlider.value = video.muted ? '0' : video.volume.toString();
  });

  volumeSlider.addEventListener('input', () => {
    setVolume(parseFloat(volumeSlider.value));
  });

  // --- Speed ---
  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    speedIndex = (speedIndex + 1) % SPEEDS.length;
    video.playbackRate = SPEEDS[speedIndex];
    speedBtn.textContent = `${SPEEDS[speedIndex]}x`;
  });

  // --- Fullscreen ---
  fsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  document.addEventListener('fullscreenchange', () => {
    fsBtn.innerHTML = document.fullscreenElement ? ICONS.fullscreenExit : ICONS.fullscreen;
  });

  // --- Controls show/hide ---
  container.addEventListener('mousemove', showControls);
  container.addEventListener('mouseenter', showControls);
  container.addEventListener('mouseleave', () => {
    if (!video.paused) {
      hideControls();
    }
  });
  container.addEventListener('focus', showControls);
  container.addEventListener('blur', () => {
    if (!video.paused) {
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
        video.currentTime = Math.max(0, video.currentTime - 5);
        updateSeekbar();
        break;
      case 'ArrowRight':
        e.preventDefault();
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
        updateSeekbar();
        break;
      case 'ArrowUp':
        e.preventDefault();
        setVolume(video.volume + 0.1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        setVolume(video.volume - 0.1);
        break;
      case 'f':
        e.preventDefault();
        fsBtn.click();
        break;
      case 'm':
        e.preventDefault();
        volumeBtn.click();
        break;
    }
  });

  // --- Init ---
  video.src = videoUrl;
  video.load();

  updatePlayButton();
  showControls();

  return container;
}
