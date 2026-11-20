<script lang="ts">
import { onMount } from 'svelte';
import { t } from '../../lib/i18n.ts';

interface Props {
  videoUrl: string;
  cueElement: HTMLElement | null;
  onCueTime: (time: number) => void;
}

let { videoUrl, cueElement, onCueTime }: Props = $props();

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
    '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="3" x2="21" y2="3"/><line x1="10" y1="14" x2="3" y2="21"/>',
  ),
} as const;

const SPEEDS = [0.5, 1, 1.5, 2] as const;

let videoEl: HTMLVideoElement;
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
let fullscreen = $state(false);
let speedIndex = $state(1);
let dragging = $state(false);
let controlsHidden = $state(false);
let hideTimer: ReturnType<typeof setTimeout> | null = null;

let progressPct = $derived(duration ? (currentTime / duration) * 100 : 0);
let bufferedPct = $derived(duration ? (bufferedEnd / duration) * 100 : 0);
let playIcon = $derived(playing && !ended ? ICONS.pause : ICONS.play);
let volumeIcon = $derived(
  muted || volume === 0 ? ICONS.volumeMuted : volume < 0.5 ? ICONS.volumeLow : ICONS.volumeHigh,
);

onMount(() => {
  if (cueElement && cueHost) cueHost.appendChild(cueElement);
  videoEl.src = videoUrl;
  videoEl.load();
  showControls();

  const onFullscreenChange = () => (fullscreen = !!document.fullscreenElement);
  const onDocMove = (e: MouseEvent) => {
    if (dragging) seekTo(e.clientX);
  };
  const onDocUp = () => {
    if (!dragging) return;
    dragging = false;
    resetHideTimer();
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('mousemove', onDocMove);
  document.addEventListener('mouseup', onDocUp);
  return () => {
    if (hideTimer) clearTimeout(hideTimer);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('mousemove', onDocMove);
    document.removeEventListener('mouseup', onDocUp);
  };
});

function resetHideTimer(): void {
  if (hideTimer) clearTimeout(hideTimer);
  if (!videoEl.paused)
    hideTimer = setTimeout(() => {
      if (!videoEl.paused && !dragging) controlsHidden = true;
    }, 3000);
}

function showControls(): void {
  controlsHidden = false;
  resetHideTimer();
}

function hideControls(): void {
  if (!videoEl.paused && !dragging) controlsHidden = true;
}

function maybeHideControls(): void {
  if (!videoEl.paused) hideControls();
}

function togglePlay(): void {
  if (videoEl.paused || videoEl.ended) void videoEl.play().catch(() => {});
  else videoEl.pause();
}

function seekTo(clientX: number): void {
  if (!videoEl.duration) return;
  const rect = seekbarTrack.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  videoEl.currentTime = ratio * videoEl.duration;
  currentTime = videoEl.currentTime;
  onCueTime(currentTime);
}

function setVolume(val: number): void {
  videoEl.muted = false;
  muted = false;
  volume = Math.max(0, Math.min(1, val));
  videoEl.volume = volume;
}

function toggleMute(): void {
  videoEl.muted = !videoEl.muted;
  muted = videoEl.muted;
}

function cycleSpeed(): void {
  speedIndex = (speedIndex + 1) % SPEEDS.length;
  videoEl.playbackRate = SPEEDS[speedIndex];
}

function toggleFullscreen(): void {
  if (!document.fullscreenElement) void root.requestFullscreen().catch(() => {});
  else void document.exitFullscreen().catch(() => {});
}

function retry(): void {
  failed = false;
  loading = true;
  videoEl.src = `${videoUrl}${videoUrl.includes('?') ? '&' : '?'}_=${Date.now()}`;
  videoEl.load();
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
      videoEl.currentTime = Math.max(0, videoEl.currentTime - 5);
      currentTime = videoEl.currentTime;
      break;
    case 'ArrowRight':
      e.preventDefault();
      videoEl.currentTime = Math.min(videoEl.duration || 0, videoEl.currentTime + 5);
      currentTime = videoEl.currentTime;
      break;
    case 'ArrowUp':
      e.preventDefault();
      setVolume(videoEl.volume + 0.1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      setVolume(videoEl.volume - 0.1);
      break;
    case 'f':
      e.preventDefault();
      toggleFullscreen();
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
  class="video-player"
  class:video-player--loaded={loaded}
  class:video-player--scrubbing={dragging}
  tabindex="0"
  onmousemove={showControls}
  onmouseenter={showControls}
  onmouseleave={maybeHideControls}
  onfocus={showControls}
  onblur={maybeHideControls}
  onkeydown={onKeydown}
>
  <video
    bind:this={videoEl}
    class="video-player-element"
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
      currentTime = videoEl.currentTime;
      if (videoEl.buffered.length > 0) bufferedEnd = videoEl.buffered.end(videoEl.buffered.length - 1);
      onCueTime(currentTime);
    }}
    onprogress={() => {
      if (videoEl.buffered.length > 0) bufferedEnd = videoEl.buffered.end(videoEl.buffered.length - 1);
    }}
    onloadedmetadata={() => {
      duration = videoEl.duration;
      loaded = true;
    }}
    onerror={() => { failed = true; loading = false; }}
    onvolumechange={() => {
      muted = videoEl.muted;
      volume = videoEl.volume;
    }}
  ></video>

  {#if failed}
    <div class="video-player-error" style="display:flex;">
      <div class="video-player-error-content">
        <span class="video-player-error-text">{t('video_player.load_failed')}</span>
        <button class="video-player-retry-btn" type="button" onclick={retry}>{t('video_player.retry')}</button>
      </div>
    </div>
  {/if}

  {#if loading && !failed}
    <div class="video-player-loading" style="display:flex;">
      <div class="video-player-spinner"></div>
    </div>
  {/if}

  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="video-player-overlay"
    style:opacity={controlsHidden ? '0' : '1'}
    style:display={failed ? 'none' : ''}
    onclick={() => videoEl.pause()}
  >
    <button
      class="video-player-big-play"
      type="button"
      style:display={playing && !ended ? 'none' : 'flex'}
      onclick={(e) => { e.stopPropagation(); togglePlay(); }}
    >
      {@html ICONS.play}
    </button>
  </div>

  <div class="video-player-controls" class:video-player-controls--hidden={controlsHidden} style:display={failed ? 'none' : ''}>
    <div class="video-player-seekbar-row">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="video-player-seekbar"
        bind:this={seekbarTrack}
        onmousedown={(e) => { e.preventDefault(); dragging = true; seekTo(e.clientX); }}
        ontouchstart={(e) => { e.preventDefault(); dragging = true; seekTo(e.touches[0].clientX); }}
        ontouchmove={(e) => { if (dragging) { e.preventDefault(); seekTo(e.touches[0].clientX); } }}
        ontouchend={() => { dragging = false; resetHideTimer(); }}
      >
        <div class="video-player-seekbar-track">
          <div class="video-player-seekbar-buffered" style:width={`${bufferedPct}%`}></div>
          <div class="video-player-seekbar-progress" style:width={`${progressPct}%`}></div>
          <div class="video-player-seekbar-thumb" style:left={`${progressPct}%`}></div>
        </div>
      </div>
    </div>
    <div class="video-player-buttons-row">
      <button
        class="video-player-btn video-player-btn-play"
        type="button"
        onclick={(e) => { e.stopPropagation(); togglePlay(); }}
      >
        {@html playIcon}
      </button>
      <span class="video-player-time">{formatTime(currentTime)}</span>
      <span class="video-player-time-sep">/</span>
      <span class="video-player-time">{formatTime(duration)}</span>
      <div class="video-player-spacer"></div>
      <div class="video-player-volume-wrap">
        <button class="video-player-btn video-player-volume-btn" type="button" onclick={(e) => { e.stopPropagation(); toggleMute(); }}>
          {@html volumeIcon}
        </button>
        <input
          class="video-player-volume-slider"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={volume}
          oninput={(e) => setVolume(parseFloat(e.currentTarget.value))}
        />
      </div>
      <button class="video-player-btn video-player-speed-btn" type="button" onclick={(e) => { e.stopPropagation(); cycleSpeed(); }}>
        {SPEEDS[speedIndex]}x
      </button>
      <button class="video-player-btn video-player-fs-btn" type="button" onclick={(e) => { e.stopPropagation(); toggleFullscreen(); }}>
        {@html fullscreen ? ICONS.fullscreenExit : ICONS.fullscreen}
      </button>
    </div>
  </div>

  <div bind:this={cueHost} class="video-player-cue-host"></div>
</div>
