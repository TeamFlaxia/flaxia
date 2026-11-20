<script lang="ts">
import { onMount } from 'svelte';
import { AudioVisualizer } from '../../components/AudioVisualizer.js';
import { t } from '../../lib/i18n.ts';

interface Props {
  audioUrl: string;
  cueElement: HTMLElement | null;
  onCueTime: (time: number) => void;
}

let { audioUrl, cueElement, onCueTime }: Props = $props();

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

let audioEl: HTMLAudioElement;
let canvasEl: HTMLCanvasElement;
let seekbarTrack: HTMLDivElement;
let cueHost: HTMLDivElement;
let root: HTMLDivElement;

let playing = $state(false);
let ended = $state(false);
let muted = $state(false);
let volume = $state(1);
let currentTime = $state(0);
let duration = $state(0);
let bufferedEnd = $state(0);
let loading = $state(true);
let failed = $state(false);
let loaded = $state(false);
let speedIndex = $state(1);
let dragging = $state(false);
let controlsHidden = $state(false);
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let visualizer: AudioVisualizer | null = null;

let progressPct = $derived(duration ? (currentTime / duration) * 100 : 0);
let bufferedPct = $derived(duration ? (bufferedEnd / duration) * 100 : 0);
let playIcon = $derived(playing && !ended ? ICONS.pause : ICONS.play);
let volumeIcon = $derived(
  muted || volume === 0 ? ICONS.volumeMuted : volume < 0.5 ? ICONS.volumeLow : ICONS.volumeHigh,
);

onMount(() => {
  if (cueElement && cueHost) cueHost.appendChild(cueElement);
  showControls();

  // Chrome needs the src attached in a later tick than construction.
  const initTimer = setTimeout(() => {
    audioEl.src = audioUrl;
    audioEl.load();
    if (!audioEl.paused && !visualizer) ensureVisualizer();
  }, 100);

  const onDocMove = (e: MouseEvent) => {
    if (dragging) seekTo(e.clientX);
  };
  const onDocUp = () => {
    if (!dragging) return;
    dragging = false;
    resetHideTimer();
  };
  document.addEventListener('mousemove', onDocMove);
  document.addEventListener('mouseup', onDocUp);

  return () => {
    clearTimeout(initTimer);
    if (hideTimer) clearTimeout(hideTimer);
    document.removeEventListener('mousemove', onDocMove);
    document.removeEventListener('mouseup', onDocUp);
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
    visualizer?.cleanup();
    visualizer = null;
  };
});

function ensureVisualizer(): void {
  if (visualizer || !audioEl.src) return;
  try {
    visualizer = new AudioVisualizer(audioEl, canvasEl);
  } catch (error) {
    console.warn('Failed to initialize audio visualizer:', error);
  }
}

function resetHideTimer(): void {
  if (hideTimer) clearTimeout(hideTimer);
  if (!audioEl.paused)
    hideTimer = setTimeout(() => {
      if (!audioEl.paused && !dragging) controlsHidden = true;
    }, 3000);
}

function showControls(): void {
  controlsHidden = false;
  resetHideTimer();
}

function hideControls(): void {
  if (!audioEl.paused && !dragging) controlsHidden = true;
}

function maybeHideControls(): void {
  if (!audioEl.paused) hideControls();
}

function togglePlay(): void {
  if (audioEl.paused || audioEl.ended) {
    // The visualizer must be created after the src is attached, otherwise
    // the Web Audio source node severs the element → graph connection.
    ensureVisualizer();
    void audioEl.play().catch(() => {});
  } else {
    audioEl.pause();
  }
}

function seekTo(clientX: number): void {
  if (!audioEl.duration) return;
  const rect = seekbarTrack.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  audioEl.currentTime = ratio * audioEl.duration;
  currentTime = audioEl.currentTime;
  onCueTime(currentTime);
}

function setVolume(val: number): void {
  audioEl.muted = false;
  muted = false;
  volume = Math.max(0, Math.min(1, val));
  audioEl.volume = volume;
}

function toggleMute(): void {
  audioEl.muted = !audioEl.muted;
  muted = audioEl.muted;
}

function cycleSpeed(): void {
  speedIndex = (speedIndex + 1) % SPEEDS.length;
  audioEl.playbackRate = SPEEDS[speedIndex];
}

function retry(): void {
  failed = false;
  loading = true;
  audioEl.src = `${audioUrl}?_=${Date.now()}`;
  audioEl.load();
}

function onKeydown(e: KeyboardEvent): void {
  switch (e.key) {
    case ' ':
    case 'k':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      audioEl.currentTime = Math.max(0, audioEl.currentTime - 5);
      currentTime = audioEl.currentTime;
      break;
    case 'ArrowRight':
      e.preventDefault();
      audioEl.currentTime = Math.min(audioEl.duration || 0, audioEl.currentTime + 5);
      currentTime = audioEl.currentTime;
      break;
    case 'ArrowUp':
      e.preventDefault();
      setVolume(audioEl.volume + 0.1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      setVolume(audioEl.volume - 0.1);
      break;
    case 'm':
      e.preventDefault();
      toggleMute();
      break;
  }
}
</script>

<div
  bind:this={root}
  class="audio-player"
  class:audio-player--loaded={loaded}
  class:audio-player--scrubbing={dragging}
  tabindex="0"
  onmousemove={showControls}
  onmouseenter={showControls}
  onmouseleave={maybeHideControls}
  onfocus={showControls}
  onblur={maybeHideControls}
  onkeydown={onKeydown}
>
  <audio
    bind:this={audioEl}
    class="audio-player-element"
    preload="metadata"
    playsinline
    controlslist="nodownload"
    oncontextmenu={(e) => e.preventDefault()}
    onloadstart={() => { loading = true; failed = false; }}
    oncanplay={() => (loading = false)}
    onwaiting={() => (loading = true)}
    onplaying={() => { loading = false; playing = true; ended = false; }}
    onplay={() => { playing = true; ended = false; }}
    onpause={() => { playing = false; showControls(); }}
    onended={() => { ended = true; playing = false; showControls(); }}
    ontimeupdate={() => {
      currentTime = audioEl.currentTime;
      if (audioEl.buffered.length > 0) bufferedEnd = audioEl.buffered.end(audioEl.buffered.length - 1);
      onCueTime(currentTime);
    }}
    onprogress={() => {
      if (audioEl.buffered.length > 0) bufferedEnd = audioEl.buffered.end(audioEl.buffered.length - 1);
    }}
    onloadedmetadata={() => {
      duration = audioEl.duration;
      loaded = true;
    }}
    onerror={() => { failed = true; loading = false; }}
    onvolumechange={() => {
      muted = audioEl.muted;
      volume = audioEl.volume;
    }}
  ></audio>

  <canvas bind:this={canvasEl} class="audio-visualizer-canvas"></canvas>

  {#if failed}
    <div class="audio-player-error" style="display:flex;">
      <div class="audio-player-error-content">
        <span class="audio-player-error-text">{t('audio.load_failed', { error: t('common.error') })}</span>
        <button class="audio-player-retry-btn" type="button" onclick={retry}>{t('video_player.retry')}</button>
      </div>
    </div>
  {/if}

  {#if loading && !failed}
    <div class="audio-player-loading" style="display:flex;">
      <div class="audio-player-spinner"></div>
    </div>
  {/if}

  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="audio-player-overlay"
    style:opacity={controlsHidden ? '0' : '1'}
    style:display={failed ? 'none' : ''}
    onclick={togglePlay}
  >
    <button
      class="audio-player-big-play"
      type="button"
      style:display={playing && !ended ? 'none' : 'flex'}
      onclick={(e) => { e.stopPropagation(); togglePlay(); }}
    >
      {@html ICONS.play}
    </button>
  </div>

  <div class="audio-player-controls" class:audio-player-controls--hidden={controlsHidden} style:display={failed ? 'none' : ''}>
    <div class="audio-player-seekbar-row">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="audio-player-seekbar"
        bind:this={seekbarTrack}
        onmousedown={(e) => { e.preventDefault(); dragging = true; seekTo(e.clientX); }}
        ontouchstart={(e) => { e.preventDefault(); dragging = true; seekTo(e.touches[0].clientX); }}
        ontouchmove={(e) => { if (dragging) { e.preventDefault(); seekTo(e.touches[0].clientX); } }}
        ontouchend={() => { dragging = false; resetHideTimer(); }}
      >
        <div class="audio-player-seekbar-track">
          <div class="audio-player-seekbar-buffered" style:width={`${bufferedPct}%`}></div>
          <div class="audio-player-seekbar-progress" style:width={`${progressPct}%`}></div>
          <div class="audio-player-seekbar-thumb" style:left={`${progressPct}%`}></div>
        </div>
      </div>
    </div>
    <div class="audio-player-buttons-row">
      <button
        class="audio-player-btn audio-player-btn-play"
        type="button"
        onclick={(e) => { e.stopPropagation(); togglePlay(); }}
      >
        {@html playIcon}
      </button>
      <span class="audio-player-time">{formatTime(currentTime)}</span>
      <span class="audio-player-time-sep">/</span>
      <span class="audio-player-time">{formatTime(duration)}</span>
      <div class="audio-player-spacer"></div>
      <div class="audio-player-volume-wrap">
        <button class="audio-player-btn audio-player-volume-btn" type="button" onclick={(e) => { e.stopPropagation(); toggleMute(); }}>
          {@html volumeIcon}
        </button>
        <input
          class="audio-player-volume-slider"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={volume}
          oninput={(e) => setVolume(parseFloat(e.currentTarget.value))}
        />
      </div>
      <button class="audio-player-btn audio-player-speed-btn" type="button" onclick={(e) => { e.stopPropagation(); cycleSpeed(); }}>
        {SPEEDS[speedIndex]}x
      </button>
    </div>
  </div>

  <div bind:this={cueHost} class="audio-player-cue-host"></div>
</div>
