import { type AudioTimelineClip, mixAudioTimeline } from '../lib/editor/audio-mixer.ts';
import { saveStudioHandoff } from '../lib/editor/studio-handoff.js';
import {
  exportStudioProject,
  importStudioProject,
  loadStudioProject,
  type StudioImageLayer,
  type StudioVideoClip,
  saveStudioProject,
} from '../lib/editor/studio-project-store.js';
import { probeVideo } from '../lib/editor/video-editor.ts';
import { renderVideoSequence } from '../lib/editor/video-sequence.ts';
import { computeAudioPeaks } from '../lib/editor/waveform.ts';
import { getVaultKey, tryDeviceUnlock } from '../lib/vault/session.js';
import type { ZipExecutorHandle } from '../lib/zip-executor.js';
import { executeFlash, type FlashPlayerHandle } from './FlashPlayer.js';
import { openMediaEditor } from './MediaEditorModal.js';

type StudioKind = 'image' | 'video' | 'audio' | 'code' | 'game' | 'other';

const KIND_LABELS: Record<StudioKind, string> = {
  image: 'IMAGE',
  video: 'VIDEO',
  audio: 'AUDIO',
  code: 'CODE',
  game: 'GAME',
  other: 'FILE',
};

function kindOf(file: File): StudioKind {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (['html', 'htm', 'css', 'js', 'mjs', 'json', 'txt', 'md', 'glsl', 'wgsl', 'rsp'].includes(ext)) {
    return ['html', 'htm'].includes(ext) ? 'game' : 'code';
  }
  if (['zip', 'swf', 'wasm'].includes(ext)) return 'game';
  return 'other';
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Local-first workspace for preparing the interactive media shared on Flaxia. */
export function createStudioPage(): { getElement(): HTMLElement; destroy(): void } {
  let files: File[] = [];
  let activeIndex = -1;
  let objectUrl: string | null = null;
  let codeDirty = false;
  let htmlEditing = false;
  let editorText = '';
  let previewUrl: string | null = null;
  let destroyed = false;
  let interacted = false;
  let restoreFinished = false;
  let pendingImports: File[] = [];
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  let saveRevision = 0;
  let saveChain: Promise<void> = Promise.resolve();
  let zipPreview: ZipExecutorHandle | null = null;
  let flashPreview: FlashPlayerHandle | null = null;
  let audioClips: AudioTimelineClip[] = [];
  let videoClips: StudioVideoClip[] = [];
  let imageLayers: StudioImageLayer[] = [];
  let selectedImageLayerId: string | null = null;
  let imageComposerOverlay: HTMLElement | null = null;
  let imageDrawRevision = 0;
  const audioDurations = new Map<number, number>();
  const audioPeaks = new Map<number, Float32Array>();
  const videoDurations = new Map<number, number>();
  let audioTrackCount = 1;
  let mixPreviewUrl: string | null = null;
  let mixPreview: HTMLAudioElement | null = null;
  let videoSequencePlayer: HTMLVideoElement | null = null;
  let videoSequenceUrl: string | null = null;
  let videoSequenceIndex = -1;
  let videoSequenceTimer: ReturnType<typeof setTimeout> | null = null;

  const root = document.createElement('main');
  root.className = 'studio-page';
  root.innerHTML = `
    <header class="studio-topbar">
      <a class="studio-brand" href="/home" aria-label="Flaxia home"><span class="studio-brand-mark">f</span> flaxia <i>/</i> studio</a>
      <div class="studio-project-name"><span class="studio-live-dot"></span><span class="studio-project-title">Untitled project</span><span class="studio-save-state">Local workspace</span></div>
      <div class="studio-top-actions"><button class="studio-button studio-open" type="button">＋ Import</button><button class="studio-button studio-project-import" type="button">Open project</button><button class="studio-button studio-project-export" type="button" disabled>Save project</button><button class="studio-button studio-export" type="button" disabled>Export</button><button class="studio-button studio-create-post" type="button" disabled>Create post ↗</button></div>
    </header>
    <div class="studio-workspace">
      <aside class="studio-rail" aria-label="Editor modes">
        <button class="studio-tool active" data-tool="all" title="All assets"><b>▦</b><span>Project</span></button>
        <button class="studio-tool" data-tool="image" title="Images"><b>▧</b><span>Image</span></button>
        <button class="studio-tool" data-tool="video" title="Video"><b>▶</b><span>Video</span></button>
        <button class="studio-tool" data-tool="audio" title="Audio"><b>♫</b><span>Audio</span></button>
        <button class="studio-tool" data-tool="code" title="Code"><b>⌘</b><span>Code</span></button>
        <button class="studio-tool" data-tool="game" title="Games"><b>◇</b><span>Game</span></button>
      </aside>
      <aside class="studio-assets">
        <div class="studio-panel-heading"><span>PROJECT ASSETS</span><button class="studio-add" type="button" aria-label="Import files">＋</button></div>
        <div class="studio-project-label"><span class="studio-folder">▾</span> Untitled project <span class="studio-count">0</span></div>
        <div class="studio-file-list"></div>
        <button class="studio-dropzone" type="button"><span>＋</span><b>Import media</b><small>Images, video, audio, code, games</small></button>
        <div class="studio-sidebar-note">Projects autosave encrypted with Flaxia Vault when unlocked. <a href="/settings">Vault settings →</a></div>
      </aside>
      <section class="studio-center">
        <div class="studio-tabs"><span class="studio-tab active">⌂ &nbsp;Workspace</span><button class="studio-tab-open" type="button">＋</button><span class="studio-center-spacer"></span><button class="studio-shortcut" type="button" title="Import files">⌘ O</button></div>
        <div class="studio-stage"><div class="studio-empty"><div class="studio-empty-art"><div class="studio-orbit studio-orbit-one"></div><div class="studio-orbit studio-orbit-two"></div><div class="studio-empty-glyph">✳</div><span class="studio-float studio-float-image">▧</span><span class="studio-float studio-float-audio">♫</span><span class="studio-float studio-float-code">&lt;/&gt;</span><span class="studio-float studio-float-game">◇</span></div><h1>Your ideas, in one studio.</h1><p>Bring images, sound, video, code, and games into one creative workspace.</p><button class="studio-button studio-open studio-primary" type="button">Import files</button><small>or drop files anywhere in the workspace</small></div><div class="studio-preview"></div></div>
        <div class="studio-timeline"><div class="studio-timeline-head"><span>⌁ &nbsp;TIMELINE</span><span class="studio-timeline-hint">Drag clips to arrange · select to trim</span><button class="studio-video-play" type="button" disabled>▶ Preview video</button><button class="studio-video-export" type="button" disabled>Export MP4</button><button class="studio-add-track" type="button">＋ Audio track</button><button class="studio-mix-play" type="button">▶ Play mix</button><button class="studio-mix-export" type="button">Mixdown WAV</button><span class="studio-mix-status"></span><button class="studio-timeline-add" type="button" title="Add files">＋</button></div><div class="studio-video-workarea"><div class="studio-video-timeline"></div></div><div class="studio-track"><div class="studio-track-label">MEDIA</div><div class="studio-track-content"><span class="studio-track-empty">Drop an asset here to start creating</span><div class="studio-clip-list"></div></div></div><div class="studio-audio-workarea"><div class="studio-audio-timeline"></div></div></div>
      </section>
      <aside class="studio-inspector"><div class="studio-inspector-tabs"><span class="active">Inspector</span><span>Publish</span></div><div class="studio-inspector-body"><div class="studio-inspector-icon">✳</div><h2>Make something living</h2><p>Flaxia posts can hold playable games and interactive media. Import an asset to preview, edit, and prepare it for sharing.</p><div class="studio-inspector-divider"></div><div class="studio-format-title">SUPPORTED CREATIVE FILES</div><div class="studio-format-list"><span>IMAGE</span><small>PNG · JPG · GIF · WEBP</small><span>VIDEO</span><small>MP4 · WEBM · MOV</small><span>AUDIO</span><small>MP3 · WAV · OGG · M4A</small><span>CODE / GAME</span><small>HTML · JS · ZIP · SWF · WASM</small></div><div class="studio-local-badge">◉ &nbsp;Private by default</div></div></aside>
    </div>
    <input class="studio-file-input" type="file" multiple accept="image/*,video/*,audio/*,.html,.htm,.css,.js,.mjs,.json,.txt,.md,.glsl,.wgsl,.rsp,.zip,.swf,.wasm" hidden />
    <input class="studio-project-input" type="file" accept=".flaxia-studio,application/vnd.flaxia.studio-project" hidden />
  `;

  const input = root.querySelector<HTMLInputElement>('.studio-file-input')!;
  const list = root.querySelector<HTMLElement>('.studio-file-list')!;
  const preview = root.querySelector<HTMLElement>('.studio-preview')!;
  const empty = root.querySelector<HTMLElement>('.studio-empty')!;
  const exportButton = root.querySelector<HTMLButtonElement>('.studio-export')!;
  const projectImportButton = root.querySelector<HTMLButtonElement>('.studio-project-import')!;
  const projectExportButton = root.querySelector<HTMLButtonElement>('.studio-project-export')!;
  const projectInput = root.querySelector<HTMLInputElement>('.studio-project-input')!;
  const createPostButton = root.querySelector<HTMLButtonElement>('.studio-create-post')!;
  const saveState = root.querySelector<HTMLElement>('.studio-save-state')!;
  const projectTitle = root.querySelector<HTMLElement>('.studio-project-title')!;
  const audioTimeline = root.querySelector<HTMLElement>('.studio-audio-timeline')!;
  const videoTimeline = root.querySelector<HTMLElement>('.studio-video-timeline')!;
  const inspectorBody = root.querySelector<HTMLElement>('.studio-inspector-body')!;
  const defaultInspector = inspectorBody.innerHTML;
  const mixStatus = root.querySelector<HTMLElement>('.studio-mix-status')!;
  const mixPlayButton = root.querySelector<HTMLButtonElement>('.studio-mix-play')!;
  const mixExportButton = root.querySelector<HTMLButtonElement>('.studio-mix-export')!;
  const addTrackButton = root.querySelector<HTMLButtonElement>('.studio-add-track')!;
  const videoPlayButton = root.querySelector<HTMLButtonElement>('.studio-video-play')!;
  const videoExportButton = root.querySelector<HTMLButtonElement>('.studio-video-export')!;
  const stopVideoSequence = (): void => {
    if (videoSequenceTimer) clearTimeout(videoSequenceTimer);
    videoSequenceTimer = null;
    videoSequencePlayer?.pause();
    videoSequencePlayer?.remove();
    videoSequencePlayer = null;
    if (videoSequenceUrl) URL.revokeObjectURL(videoSequenceUrl);
    videoSequenceUrl = null;
    videoSequenceIndex = -1;
    videoPlayButton.textContent = '▶ Preview video';
  };

  const manuallyPlacedVideoClips = new Set<string>();

  const ensureAudioClip = (fileIndex: number, useFullDuration = false): void => {
    const file = files[fileIndex];
    if (!file || kindOf(file) !== 'audio') return;
    let clip = audioClips.find((item) => item.fileIndex === fileIndex);
    const expandToSource = useFullDuration || !clip;
    if (!clip) {
      const track = Math.min(audioClips.length, 7);
      clip = {
        id: crypto.randomUUID(),
        fileIndex,
        track,
        start: 0,
        sourceStart: 0,
        sourceEnd: 1,
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        pan: 0,
        muted: false,
      };
      audioClips.push(clip);
      audioTrackCount = Math.max(audioTrackCount, track + 1);
    }
    if (audioDurations.has(fileIndex)) return;
    void computeAudioPeaks(file)
      .then(({ duration, peaks }) => {
        if (destroyed) return;
        audioDurations.set(fileIndex, duration);
        audioPeaks.set(fileIndex, peaks);
        const audioClip = audioClips.find((item) => item.fileIndex === fileIndex);
        if (audioClip && expandToSource) audioClip.sourceEnd = duration;
        renderAudioTimeline();
        renderInspector();
        scheduleAutosave();
      })
      .catch(() => {
        if (destroyed) return;
        audioDurations.set(fileIndex, 1);
        renderAudioTimeline();
      });
  };

  const ensureVideoClip = (fileIndex: number, useFullDuration = false): void => {
    const file = files[fileIndex];
    if (!file || kindOf(file) !== 'video') return;
    let clip = videoClips.find((item) => item.fileIndex === fileIndex);
    const expandToSource = useFullDuration || !clip;
    if (!clip) {
      clip = {
        id: crypto.randomUUID(),
        fileIndex,
        start: videoClips.reduce((end, item) => Math.max(end, item.start + item.sourceEnd - item.sourceStart), 0),
        sourceStart: 0,
        sourceEnd: 1,
      };
      videoClips.push(clip);
    }
    if (videoDurations.has(fileIndex)) return;
    void probeVideo(file)
      .then((meta) => {
        if (destroyed) return;
        videoDurations.set(fileIndex, meta.duration);
        const videoClip = videoClips.find((item) => item.fileIndex === fileIndex);
        if (videoClip && expandToSource) {
          videoClip.sourceEnd = meta.duration;
          const clipIndex = videoClips.indexOf(videoClip);
          for (let index = clipIndex + 1; index < videoClips.length; index++) {
            const previous = videoClips[index - 1];
            const following = videoClips[index];
            if (!manuallyPlacedVideoClips.has(following.id)) {
              following.start = previous.start + previous.sourceEnd - previous.sourceStart;
            }
          }
        }
        renderVideoTimeline();
        renderInspector();
        scheduleAutosave();
      })
      .catch(() => {
        if (!destroyed) videoDurations.set(fileIndex, 1);
      });
  };

  const clearUrl = (): void => {
    zipPreview?.destroy();
    zipPreview = null;
    flashPreview?.destroy();
    flashPreview = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  };

  const download = (file: File): void => {
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const scheduleAutosave = (): void => {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    const revision = ++saveRevision;
    saveState.textContent = 'Saving locally…';
    autosaveTimer = setTimeout(() => {
      const vaultKey = getVaultKey();
      if (!vaultKey) {
        saveState.textContent = 'Unlock Vault to save securely';
        return;
      }
      const currentFile = files[activeIndex];
      const projectFiles = [...files];
      if (
        codeDirty &&
        currentFile &&
        (kindOf(currentFile) === 'code' || (kindOf(currentFile) === 'game' && /\.html?$/i.test(currentFile.name)))
      ) {
        projectFiles[activeIndex] = new File([editorText], currentFile.name, {
          type: currentFile.type || (kindOf(currentFile) === 'game' ? 'text/html' : 'text/plain'),
        });
      }
      saveChain = saveChain
        .catch(() => undefined)
        .then(async () => {
          if (destroyed || revision !== saveRevision) return;
          try {
            await saveStudioProject(projectFiles, audioClips, videoClips, imageLayers, vaultKey);
            if (!destroyed && revision === saveRevision) saveState.textContent = 'Saved on this device';
          } catch (error) {
            if (!destroyed && revision === saveRevision) {
              saveState.textContent = error instanceof Error ? error.message : 'Could not save encrypted project';
            }
          }
        });
    }, 700);
  };

  const renderVideoTimeline = (): void => {
    videoTimeline.innerHTML = '';
    const end = Math.max(30, ...videoClips.map((clip) => clip.start + clip.sourceEnd - clip.sourceStart + 5));
    const contentWidth = Math.max(1200, end * 42);
    const ruler = document.createElement('div');
    ruler.className = 'studio-video-ruler';
    ruler.style.width = `${contentWidth}px`;
    for (let second = 0; second <= end; second += 5) {
      const tick = document.createElement('span');
      tick.style.left = `${second * 42}px`;
      tick.textContent = `${Math.floor(second / 60)}:${String(second % 60).padStart(2, '0')}`;
      ruler.appendChild(tick);
    }
    videoTimeline.appendChild(ruler);
    const lane = document.createElement('div');
    lane.className = 'studio-video-lane';
    const label = document.createElement('div');
    label.className = 'studio-video-track-label';
    label.textContent = 'V1';
    const canvas = document.createElement('div');
    canvas.className = 'studio-video-lane-canvas';
    canvas.style.width = `${contentWidth}px`;
    for (const clip of videoClips) {
      const file = files[clip.fileIndex];
      if (!file) continue;
      const block = document.createElement('button');
      block.type = 'button';
      block.draggable = true;
      block.className = `studio-video-clip ${clip.fileIndex === activeIndex ? 'active' : ''}`;
      block.dataset.clipId = clip.id;
      block.style.left = `${clip.start * 42}px`;
      block.style.width = `${Math.max(54, (clip.sourceEnd - clip.sourceStart) * 42)}px`;
      const duration = videoDurations.get(clip.fileIndex);
      block.textContent = `${file.name} · ${duration ? `${(clip.sourceEnd - clip.sourceStart).toFixed(1)}s` : '…'}`;
      block.title = file.name;
      block.addEventListener('click', () => select(clip.fileIndex));
      block.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('application/x-flaxia-video-clip', clip.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      canvas.appendChild(block);
    }
    lane.appendChild(label);
    lane.appendChild(canvas);
    lane.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes('application/x-flaxia-video-clip')) event.preventDefault();
    });
    lane.addEventListener('drop', (event) => {
      const clipId = event.dataTransfer?.getData('application/x-flaxia-video-clip');
      const clip = videoClips.find((item) => item.id === clipId);
      if (!clip) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      clip.start = Math.max(0, Math.round(((event.clientX - rect.left) / 42) * 10) / 10);
      manuallyPlacedVideoClips.add(clip.id);
      renderVideoTimeline();
      renderInspector();
      scheduleAutosave();
    });
    videoTimeline.appendChild(lane);
    videoPlayButton.disabled = videoClips.length === 0;
    videoExportButton.disabled = videoClips.length === 0;
  };

  const renderAudioTimeline = (): void => {
    audioTimeline.innerHTML = '';
    const ruler = document.createElement('div');
    ruler.className = 'studio-audio-ruler';
    const end = Math.max(30, ...audioClips.map((clip) => clip.start + clip.sourceEnd - clip.sourceStart + 5));
    const contentWidth = Math.max(1200, end * 42);
    ruler.style.width = `${contentWidth}px`;
    for (let second = 0; second <= end; second += 5) {
      const tick = document.createElement('span');
      tick.style.left = `${second * 42}px`;
      tick.textContent = `${Math.floor(second / 60)}:${String(second % 60).padStart(2, '0')}`;
      ruler.appendChild(tick);
    }
    audioTimeline.appendChild(ruler);
    for (let track = 0; track < audioTrackCount; track++) {
      const lane = document.createElement('div');
      lane.className = 'studio-audio-lane';
      lane.dataset.track = String(track);
      lane.innerHTML = `<div class="studio-audio-track-label">A${track + 1}</div><div class="studio-audio-lane-canvas" style="width:${contentWidth}px"></div>`;
      const canvas = lane.querySelector<HTMLElement>('.studio-audio-lane-canvas')!;
      const trackClips = audioClips.filter((clip) => clip.track === track);
      for (const clip of trackClips) {
        const file = files[clip.fileIndex];
        if (!file) continue;
        const duration = Math.max(0.1, clip.sourceEnd - clip.sourceStart);
        const block = document.createElement('button');
        block.type = 'button';
        block.draggable = true;
        block.className = `studio-audio-clip ${clip.fileIndex === activeIndex ? 'active' : ''} ${clip.muted ? 'muted' : ''}`;
        block.dataset.clipId = clip.id;
        block.style.left = `${clip.start * 42}px`;
        block.style.width = `${Math.max(48, duration * 42)}px`;
        const peaks = audioPeaks.get(clip.fileIndex);
        const bars = peaks
          ? Array.from(peaks)
              .filter((_, index) => index % Math.max(1, Math.floor(peaks.length / 48)) === 0)
              .slice(0, 48)
          : [];
        block.innerHTML = `<span class="studio-audio-clip-name">${escapeHtml(file.name)}</span><span class="studio-audio-clip-wave">${bars.map((peak) => `<i style="height:${Math.max(8, Math.min(100, peak * 100))}%"></i>`).join('')}</span>`;
        block.addEventListener('click', () => select(clip.fileIndex));
        block.addEventListener('dragstart', (event) => {
          event.dataTransfer?.setData('application/x-flaxia-audio-clip', clip.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });
        canvas.appendChild(block);
      }
      lane.addEventListener('dragover', (event) => {
        if (event.dataTransfer?.types.includes('application/x-flaxia-audio-clip')) event.preventDefault();
      });
      lane.addEventListener('drop', (event) => {
        const id = event.dataTransfer?.getData('application/x-flaxia-audio-clip');
        const clip = audioClips.find((item) => item.id === id);
        if (!clip) return;
        event.preventDefault();
        const canvasRect = canvas.getBoundingClientRect();
        clip.start = Math.max(0, Math.round(((event.clientX - canvasRect.left) / 42) * 10) / 10);
        clip.track = track;
        audioTrackCount = Math.max(audioTrackCount, track + 1);
        renderAudioTimeline();
        renderInspector();
        scheduleAutosave();
      });
      audioTimeline.appendChild(lane);
    }
    const empty = document.createElement('div');
    empty.className = 'studio-audio-empty';
    empty.textContent = audioClips.length ? '' : 'Import audio, then drag clips between tracks to arrange your mix';
    audioTimeline.appendChild(empty);
    mixPlayButton.disabled = audioClips.length === 0;
    mixExportButton.disabled = audioClips.length === 0;
  };

  const renderInspector = (): void => {
    const videoClip = videoClips.find((item) => item.fileIndex === activeIndex);
    const videoFile = videoClip ? files[videoClip.fileIndex] : null;
    if (videoClip && videoFile) {
      const duration = videoDurations.get(videoClip.fileIndex) ?? videoClip.sourceEnd;
      inspectorBody.innerHTML = `<div class="studio-inspector-icon">▶</div><h2>${escapeHtml(videoFile.name)}</h2><p>Video clip · ${duration.toFixed(1)}s source</p><div class="studio-inspector-divider"></div><label class="studio-property"><span>Position</span><input class="studio-video-position" type="number" min="0" step="0.1" value="${videoClip.start.toFixed(1)}"><small>s</small></label><label class="studio-property"><span>Trim in</span><input class="studio-video-in" type="number" min="0" max="${duration.toFixed(2)}" step="0.1" value="${videoClip.sourceStart.toFixed(1)}"><small>s</small></label><label class="studio-property"><span>Trim out</span><input class="studio-video-out" type="number" min="0.1" max="${duration.toFixed(2)}" step="0.1" value="${videoClip.sourceEnd.toFixed(1)}"><small>s</small></label><p class="studio-video-hint">These trims apply to sequence preview. Use Edit above for standalone video encoding.</p><button class="studio-button studio-remove-video" type="button">Remove from timeline</button>`;
      const update = (selector: string, set: (value: number) => void): void => {
        inspectorBody.querySelector<HTMLInputElement>(selector)!.addEventListener('change', (event) => {
          const input = event.currentTarget as HTMLInputElement;
          const value = Number(input.value);
          if (!Number.isFinite(value)) return;
          set(value);
          renderVideoTimeline();
          renderInspector();
          scheduleAutosave();
        });
      };
      update('.studio-video-position', (value) => {
        manuallyPlacedVideoClips.add(videoClip.id);
        videoClip.start = Math.max(0, Math.min(value, 14_400));
      });
      update('.studio-video-in', (value) => {
        videoClip.sourceStart = Math.max(0, Math.min(value, videoClip.sourceEnd - 0.1));
      });
      update('.studio-video-out', (value) => {
        videoClip.sourceEnd = Math.max(videoClip.sourceStart + 0.1, Math.min(value, duration));
      });
      inspectorBody.querySelector<HTMLButtonElement>('.studio-remove-video')!.addEventListener('click', () => {
        videoClips = videoClips.filter((item) => item.id !== videoClip.id);
        renderVideoTimeline();
        renderInspector();
        scheduleAutosave();
      });
      return;
    }
    const clip = audioClips.find((item) => item.fileIndex === activeIndex);
    const file = clip ? files[clip.fileIndex] : null;
    if (!clip || !file) {
      inspectorBody.innerHTML = defaultInspector;
      return;
    }
    const duration = audioDurations.get(clip.fileIndex) ?? clip.sourceEnd;
    inspectorBody.innerHTML = `<div class="studio-inspector-icon">♫</div><h2>${escapeHtml(file.name)}</h2><p>Audio clip · ${duration.toFixed(1)}s source</p><div class="studio-inspector-divider"></div><label class="studio-property"><span>Position</span><input class="studio-clip-position" type="number" min="0" step="0.1" value="${clip.start.toFixed(1)}"><small>s</small></label><label class="studio-property"><span>Trim in</span><input class="studio-clip-in" type="number" min="0" max="${duration.toFixed(2)}" step="0.1" value="${clip.sourceStart.toFixed(1)}"><small>s</small></label><label class="studio-property"><span>Trim out</span><input class="studio-clip-out" type="number" min="0.1" max="${duration.toFixed(2)}" step="0.1" value="${clip.sourceEnd.toFixed(1)}"><small>s</small></label><label class="studio-property studio-gain-property"><span>Gain</span><input class="studio-clip-gain" type="range" min="0" max="200" value="${Math.round(clip.gain * 100)}"><small class="studio-gain-value">${Math.round(clip.gain * 100)}%</small></label><label class="studio-property studio-gain-property"><span>Pan</span><input class="studio-clip-pan" type="range" min="-100" max="100" value="${Math.round(clip.pan * 100)}"><small class="studio-pan-value">${clip.pan === 0 ? 'Center' : `${Math.abs(Math.round(clip.pan * 100))}% ${clip.pan < 0 ? 'L' : 'R'}`}</small></label><label class="studio-property"><span>Fade in</span><input class="studio-clip-fade-in" type="number" min="0" max="${(clip.sourceEnd - clip.sourceStart).toFixed(1)}" step="0.1" value="${clip.fadeIn.toFixed(1)}"><small>s</small></label><label class="studio-property"><span>Fade out</span><input class="studio-clip-fade-out" type="number" min="0" max="${(clip.sourceEnd - clip.sourceStart).toFixed(1)}" step="0.1" value="${clip.fadeOut.toFixed(1)}"><small>s</small></label><label class="studio-property studio-mute-property"><input class="studio-clip-muted" type="checkbox" ${clip.muted ? 'checked' : ''}><span>Mute clip</span></label><div class="studio-inspector-divider"></div><button class="studio-button studio-remove-audio" type="button">Remove from timeline</button>`;
    const numeric = (selector: string, update: (value: number) => void): void => {
      const input = inspectorBody.querySelector<HTMLInputElement>(selector)!;
      input.addEventListener('change', () => {
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        update(value);
        renderAudioTimeline();
        scheduleAutosave();
      });
    };
    numeric('.studio-clip-position', (value) => (clip.start = Math.max(0, value)));
    numeric('.studio-clip-in', (value) => (clip.sourceStart = Math.max(0, Math.min(value, clip.sourceEnd - 0.1))));
    numeric(
      '.studio-clip-out',
      (value) => (clip.sourceEnd = Math.max(clip.sourceStart + 0.1, Math.min(value, duration))),
    );
    const gain = inspectorBody.querySelector<HTMLInputElement>('.studio-clip-gain')!;
    gain.addEventListener('input', () => {
      clip.gain = Number(gain.value) / 100;
      inspectorBody.querySelector('.studio-gain-value')!.textContent = `${gain.value}%`;
    });
    gain.addEventListener('change', () => {
      renderAudioTimeline();
      scheduleAutosave();
    });
    const pan = inspectorBody.querySelector<HTMLInputElement>('.studio-clip-pan')!;
    pan.addEventListener('input', () => {
      clip.pan = Number(pan.value) / 100;
      inspectorBody.querySelector('.studio-pan-value')!.textContent =
        clip.pan === 0 ? 'Center' : `${Math.abs(Number(pan.value))}% ${clip.pan < 0 ? 'L' : 'R'}`;
    });
    pan.addEventListener('change', () => {
      renderAudioTimeline();
      scheduleAutosave();
    });
    numeric('.studio-clip-fade-in', (value) => {
      clip.fadeIn = Math.max(0, Math.min(value, clip.sourceEnd - clip.sourceStart));
    });
    numeric('.studio-clip-fade-out', (value) => {
      clip.fadeOut = Math.max(0, Math.min(value, clip.sourceEnd - clip.sourceStart));
    });
    inspectorBody.querySelector<HTMLInputElement>('.studio-clip-muted')!.addEventListener('change', (event) => {
      clip.muted = (event.currentTarget as HTMLInputElement).checked;
      renderAudioTimeline();
      scheduleAutosave();
    });
    inspectorBody.querySelector<HTMLButtonElement>('.studio-remove-audio')!.addEventListener('click', () => {
      audioClips = audioClips.filter((item) => item.id !== clip.id);
      renderAudioTimeline();
      renderInspector();
      scheduleAutosave();
    });
  };

  const render = (): void => {
    if (destroyed) return;
    list.innerHTML = '';
    root.querySelector('.studio-count')!.textContent = String(files.length);
    files.forEach((file, index) => {
      const kind = kindOf(file);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `studio-asset ${index === activeIndex ? 'active' : ''}`;
      row.innerHTML = `<span class="studio-asset-icon studio-kind-${kind}">${({ image: '▧', video: '▶', audio: '♫', code: '&lt;/&gt;', game: '◇', other: '▤' } as const)[kind]}</span><span class="studio-asset-name">${escapeHtml(file.name)}</span><span class="studio-asset-size">${sizeLabel(file.size)}</span>`;
      row.addEventListener('click', () => select(index));
      list.appendChild(row);
    });
    const clips = root.querySelector<HTMLElement>('.studio-clip-list')!;
    clips.innerHTML = files
      .map(
        (file, index) =>
          `<button class="studio-clip ${index === activeIndex ? 'active' : ''}" data-index="${index}" type="button"><span>${KIND_LABELS[kindOf(file)]}</span>${escapeHtml(file.name)}</button>`,
      )
      .join('');
    clips.querySelectorAll<HTMLButtonElement>('[data-index]').forEach((button) => {
      button.addEventListener('click', () => select(Number(button.dataset.index)));
    });
    exportButton.disabled = activeIndex < 0;
    projectExportButton.disabled = files.length === 0;
    createPostButton.disabled = files.length === 0;
    renderVideoTimeline();
    renderAudioTimeline();
    renderInspector();
  };

  const createCodeEditor = (text: string, fileName: string, onChange: () => void): HTMLElement => {
    const workbench = document.createElement('div');
    workbench.className = 'studio-code-workbench';
    const toolbar = document.createElement('div');
    toolbar.className = 'studio-code-toolbar';
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Find';
    search.setAttribute('aria-label', 'Find in file');
    const replacement = document.createElement('input');
    replacement.type = 'text';
    replacement.placeholder = 'Replace';
    replacement.setAttribute('aria-label', 'Replace with');
    const replaceButton = document.createElement('button');
    replaceButton.type = 'button';
    replaceButton.textContent = 'Replace';
    const lineInput = document.createElement('input');
    lineInput.type = 'number';
    lineInput.min = '1';
    lineInput.value = '1';
    lineInput.setAttribute('aria-label', 'Go to line');
    const goButton = document.createElement('button');
    goButton.type = 'button';
    goButton.textContent = 'Go';
    toolbar.appendChild(search);
    toolbar.appendChild(replacement);
    toolbar.appendChild(replaceButton);
    toolbar.appendChild(lineInput);
    toolbar.appendChild(goButton);

    const editorRow = document.createElement('div');
    editorRow.className = 'studio-code-row';
    const gutter = document.createElement('div');
    gutter.className = 'studio-code-gutter';
    gutter.setAttribute('aria-hidden', 'true');
    const area = document.createElement('textarea');
    area.className = 'studio-code-editor';
    area.spellcheck = false;
    area.wrap = 'off';
    area.setAttribute('aria-label', `Edit ${fileName}`);
    area.value = text;
    const updateGutter = (): void => {
      const lines = area.value.split('\n').length;
      gutter.textContent = Array.from({ length: lines }, (_, index) => String(index + 1)).join('\n');
      gutter.scrollTop = area.scrollTop;
      lineInput.max = String(lines);
    };
    area.addEventListener('input', () => {
      editorText = area.value;
      codeDirty = true;
      saveState.textContent = 'Unsaved changes';
      exportButton.textContent = 'Save file';
      updateGutter();
      onChange();
    });
    area.addEventListener('scroll', updateGutter);
    area.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (codeDirty) exportButton.click();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        const runButton = workbench.parentElement?.querySelector<HTMLButtonElement>('.studio-code-run');
        if (runButton) {
          event.preventDefault();
          runButton.click();
        }
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
        area.dispatchEvent(new Event('input'));
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        search.focus();
      }
    });
    goButton.addEventListener('click', () => {
      const line = Math.max(1, Math.min(Number(lineInput.value) || 1, area.value.split('\n').length));
      const offset = area.value
        .split('\n')
        .slice(0, line - 1)
        .reduce((total, current) => total + current.length + 1, 0);
      area.focus();
      area.setSelectionRange(offset, offset);
      const lineHeight = Number.parseFloat(getComputedStyle(area).lineHeight) || 20;
      area.scrollTop = (line - 1) * lineHeight;
      updateGutter();
    });
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !search.value) return;
      event.preventDefault();
      const query = search.value;
      const from = area.selectionEnd;
      const found = area.value.indexOf(query, from);
      const start = found >= 0 ? found : area.value.indexOf(query);
      if (start >= 0) {
        area.focus();
        area.setSelectionRange(start, start + query.length);
      }
    });
    replaceButton.addEventListener('click', () => {
      if (!search.value) return;
      const start = area.selectionStart;
      const end = area.selectionEnd;
      if (area.value.slice(start, end) === search.value) {
        area.setRangeText(replacement.value, start, end, 'end');
        area.dispatchEvent(new Event('input'));
      } else {
        search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
    });
    editorRow.appendChild(gutter);
    editorRow.appendChild(area);
    workbench.appendChild(toolbar);
    workbench.appendChild(editorRow);
    updateGutter();
    return workbench;
  };

  const createCodePreview = (fileName: string, source: string): HTMLIFrameElement => {
    const frame = document.createElement('iframe');
    frame.className = 'studio-code-preview';
    frame.title = `${fileName} sandbox preview`;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    const extension = fileName.toLowerCase().split('.').pop();
    const page =
      extension === 'css'
        ? `<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;padding:24px;color:#222}.preview-card{padding:24px;border:1px solid #aaa;border-radius:12px;max-width:480px}</style><style>${source.replace(/<\/style/gi, '<\\/style')}</style><main class="preview-card"><h1>CSS preview</h1><p>Edit this stylesheet and run again.</p><button>Sample button</button></main>`
        : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body><main id="app"></main><script>${source.replace(/<\/script/gi, '<\\/script')}</script></body>`;
    frame.srcdoc = page;
    return frame;
  };

  const openImageComposer = async (initialFileIndex: number): Promise<void> => {
    if (imageComposerOverlay) return;
    const initialLayer = imageLayers.find((layer) => layer.kind !== 'text' && layer.fileIndex === initialFileIndex);
    if (initialLayer) selectedImageLayerId = initialLayer.id;

    const overlay = document.createElement('section');
    overlay.className = 'studio-composer-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Image layer composer');
    overlay.innerHTML = `<header class="studio-composer-header"><div><b>Image composition</b><small>1080 × 1080 transparent canvas · drag layers to position</small></div><div><button class="studio-composer-export" type="button">Export PNG</button><button class="studio-composer-close" type="button" aria-label="Close">×</button></div></header><div class="studio-composer-layout"><div class="studio-composer-board"><div class="studio-composer-canvas-wrap"><canvas class="studio-composer-canvas" width="1080" height="1080" aria-label="Layer composition canvas"></canvas></div><div class="studio-composer-status" aria-live="polite"></div></div><aside class="studio-composer-panel"><div class="studio-composer-section"><div class="studio-composer-title">IMAGE ASSETS</div><div class="studio-composer-assets"></div></div><div class="studio-composer-section"><div class="studio-composer-title">LAYERS <button class="studio-composer-add-text" type="button">＋ Text</button><span class="studio-composer-count"></span></div><div class="studio-composer-layers"></div></div><div class="studio-composer-properties"></div></aside></div>`;
    root.appendChild(overlay);
    imageComposerOverlay = overlay;
    const canvas = overlay.querySelector<HTMLCanvasElement>('.studio-composer-canvas')!;
    const context = canvas.getContext('2d');
    const layerList = overlay.querySelector<HTMLElement>('.studio-composer-layers')!;
    const assetList = overlay.querySelector<HTMLElement>('.studio-composer-assets')!;
    const properties = overlay.querySelector<HTMLElement>('.studio-composer-properties')!;
    const status = overlay.querySelector<HTMLElement>('.studio-composer-status')!;
    const bitmaps = new Map<number, Promise<ImageBitmap>>();
    let drag: { id: string; dx: number; dy: number } | null = null;
    const close = (): void => {
      imageDrawRevision++;
      for (const bitmapPromise of bitmaps.values()) {
        void bitmapPromise.then((bitmap) => bitmap.close()).catch(() => undefined);
      }
      bitmaps.clear();
      overlay.remove();
      imageComposerOverlay = null;
    };
    overlay.querySelector<HTMLButtonElement>('.studio-composer-close')!.addEventListener('click', close);

    const getBitmap = (fileIndex: number): Promise<ImageBitmap> => {
      let bitmap = bitmaps.get(fileIndex);
      if (!bitmap) {
        const file = files[fileIndex];
        if (!file) return Promise.reject(new Error('Image asset not found'));
        bitmap = createImageBitmap(file);
        bitmaps.set(fileIndex, bitmap);
      }
      return bitmap;
    };
    const draw = async (withSelection = true): Promise<void> => {
      const revision = ++imageDrawRevision;
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      status.textContent = '';
      try {
        for (const layer of imageLayers) {
          if (!layer.visible) continue;
          if (layer.kind === 'text') {
            context.save();
            context.globalAlpha = layer.opacity;
            context.globalCompositeOperation = layer.blend === 'normal' ? 'source-over' : layer.blend;
            context.translate(layer.x + layer.width / 2, layer.y + layer.height / 2);
            context.rotate((layer.rotation * Math.PI) / 180);
            const fontSize = layer.fontSize ?? 72;
            context.fillStyle = layer.color ?? '#ffffff';
            context.font = `${fontSize}px ${layer.fontFamily ?? 'sans-serif'}`;
            context.textBaseline = 'middle';
            (layer.text ?? '')
              .split('\n')
              .slice(0, 20)
              .forEach((line, index) => {
                context.fillText(
                  line,
                  -layer.width / 2,
                  -layer.height / 2 + fontSize * 0.7 + index * fontSize * 1.2,
                  layer.width,
                );
              });
            context.restore();
            continue;
          }
          const bitmap = await getBitmap(layer.fileIndex);
          if (revision !== imageDrawRevision) return;
          context.save();
          context.globalAlpha = layer.opacity;
          context.globalCompositeOperation = layer.blend === 'normal' ? 'source-over' : layer.blend;
          context.translate(layer.x + layer.width / 2, layer.y + layer.height / 2);
          context.rotate((layer.rotation * Math.PI) / 180);
          context.drawImage(bitmap, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
          context.restore();
        }
        const selected = withSelection ? imageLayers.find((layer) => layer.id === selectedImageLayerId) : null;
        if (selected) {
          context.save();
          context.translate(selected.x + selected.width / 2, selected.y + selected.height / 2);
          context.rotate((selected.rotation * Math.PI) / 180);
          context.strokeStyle = '#b8ef6a';
          context.lineWidth = 2;
          context.setLineDash([8, 5]);
          context.strokeRect(-selected.width / 2, -selected.height / 2, selected.width, selected.height);
          context.restore();
        }
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Could not load this image';
      }
    };
    const selectLayer = (layerId: string): void => {
      selectedImageLayerId = layerId;
      renderLayers();
      renderProperties();
      void draw();
    };
    const renderProperties = (): void => {
      const layer = imageLayers.find((item) => item.id === selectedImageLayerId);
      const file = layer?.kind === 'image' ? files[layer.fileIndex] : null;
      if (!layer || (layer.kind === 'image' && !file)) {
        properties.innerHTML =
          '<div class="studio-composer-title">TRANSFORM</div><p>Select a layer to edit its transform.</p>';
        return;
      }
      const layerName = layer.kind === 'text' ? 'Text layer' : (file?.name ?? 'Image layer');
      const textControls =
        layer.kind === 'text'
          ? `<label class="studio-composer-text-label">Text<textarea data-prop="text" maxlength="2000">${escapeHtml(layer.text ?? '')}</textarea></label><label class="studio-composer-field">Color<input data-prop="color" type="color" value="${layer.color ?? '#ffffff'}"></label><label class="studio-composer-field">Font size<input data-prop="fontSize" type="number" min="8" max="256" value="${layer.fontSize ?? 72}"></label><label class="studio-composer-field">Font<select data-prop="fontFamily"><option value="sans-serif" ${(layer.fontFamily ?? 'sans-serif') === 'sans-serif' ? 'selected' : ''}>Sans serif</option><option value="serif" ${layer.fontFamily === 'serif' ? 'selected' : ''}>Serif</option><option value="monospace" ${layer.fontFamily === 'monospace' ? 'selected' : ''}>Monospace</option></select></label>`
          : '';
      properties.innerHTML = `<div class="studio-composer-title">TRANSFORM</div><div class="studio-composer-layer-name">${escapeHtml(layerName)}</div>${textControls}<div class="studio-composer-grid"><label>X<input data-prop="x" type="number" value="${Math.round(layer.x)}"></label><label>Y<input data-prop="y" type="number" value="${Math.round(layer.y)}"></label><label>Width<input data-prop="width" type="number" min="1" max="4096" value="${Math.round(layer.width)}"></label><label>Height<input data-prop="height" type="number" min="1" max="4096" value="${Math.round(layer.height)}"></label></div><label class="studio-composer-range">Opacity <output>${Math.round(layer.opacity * 100)}%</output><input data-prop="opacity" type="range" min="0" max="100" value="${Math.round(layer.opacity * 100)}"></label><label class="studio-composer-field">Rotation<input data-prop="rotation" type="number" min="-360" max="360" value="${Math.round(layer.rotation)}">°</label><label class="studio-composer-field">Blend mode<select data-prop="blend"><option value="normal" ${layer.blend === 'normal' ? 'selected' : ''}>Normal</option><option value="multiply" ${layer.blend === 'multiply' ? 'selected' : ''}>Multiply</option><option value="screen" ${layer.blend === 'screen' ? 'selected' : ''}>Screen</option></select></label><div class="studio-composer-order"><button class="studio-composer-down" type="button">Send backward</button><button class="studio-composer-up" type="button">Bring forward</button></div><button class="studio-composer-remove" type="button">Remove layer</button>`;
      const updateProperty = (property: string, value: string): void => {
        if (property === 'blend') layer.blend = value as StudioImageLayer['blend'];
        else if (property === 'opacity') {
          layer.opacity = Number(value) / 100;
          properties.querySelector('output')!.textContent = `${value}%`;
        } else if (property === 'x' || property === 'y') {
          layer[property] = Math.max(-8192, Math.min(8192, Number(value) || 0));
        } else if (property === 'width' || property === 'height') {
          layer[property] = Math.max(1, Math.min(4096, Number(value) || 1));
        } else if (property === 'rotation') {
          layer.rotation = Math.max(-3600, Math.min(3600, Number(value) || 0));
        } else if (property === 'text' && layer.kind === 'text') {
          layer.text = value.slice(0, 2000);
        } else if (property === 'color' && layer.kind === 'text' && /^#[\da-f]{6}$/i.test(value)) {
          layer.color = value;
        } else if (property === 'fontSize' && layer.kind === 'text') {
          layer.fontSize = Math.max(8, Math.min(256, Number(value) || 72));
        } else if (
          property === 'fontFamily' &&
          layer.kind === 'text' &&
          ['sans-serif', 'serif', 'monospace'].includes(value)
        ) {
          layer.fontFamily = value as NonNullable<StudioImageLayer['fontFamily']>;
        }
        renderLayers();
        void draw();
        scheduleAutosave();
      };
      properties.querySelectorAll<HTMLInputElement>('input[data-prop]').forEach((control) => {
        control.addEventListener('input', () => updateProperty(control.dataset.prop ?? '', control.value));
      });
      const blendSelect = properties.querySelector('select[data-prop]') as HTMLSelectElement | null;
      blendSelect?.addEventListener('change', () => {
        updateProperty(blendSelect.dataset.prop ?? '', blendSelect.value);
      });
      const fontSelect = properties.querySelector('select[data-prop="fontFamily"]') as HTMLSelectElement | null;
      fontSelect?.addEventListener('change', () => updateProperty('fontFamily', fontSelect.value));
      properties
        .querySelector<HTMLTextAreaElement>('textarea[data-prop="text"]')
        ?.addEventListener('input', (event) => {
          updateProperty('text', (event.currentTarget as HTMLTextAreaElement).value);
        });
      properties.querySelector<HTMLButtonElement>('.studio-composer-up')!.addEventListener('click', () => {
        const index = imageLayers.indexOf(layer);
        if (index < imageLayers.length - 1) {
          imageLayers.splice(index, 1);
          imageLayers.splice(index + 1, 0, layer);
          renderLayers();
          void draw();
          scheduleAutosave();
        }
      });
      properties.querySelector<HTMLButtonElement>('.studio-composer-down')!.addEventListener('click', () => {
        const index = imageLayers.indexOf(layer);
        if (index > 0) {
          imageLayers.splice(index, 1);
          imageLayers.splice(index - 1, 0, layer);
          renderLayers();
          void draw();
          scheduleAutosave();
        }
      });
      properties.querySelector<HTMLButtonElement>('.studio-composer-remove')!.addEventListener('click', () => {
        imageLayers = imageLayers.filter((item) => item.id !== layer.id);
        selectedImageLayerId = imageLayers.at(-1)?.id ?? null;
        renderLayers();
        renderProperties();
        void draw();
        scheduleAutosave();
      });
    };
    const renderLayers = (): void => {
      overlay.querySelector<HTMLElement>('.studio-composer-count')!.textContent = String(imageLayers.length);
      layerList.innerHTML = '';
      [...imageLayers].reverse().forEach((layer) => {
        const row = document.createElement('div');
        row.className = `studio-composer-layer ${layer.id === selectedImageLayerId ? 'active' : ''}`;
        const name = document.createElement('button');
        name.type = 'button';
        name.className = 'studio-composer-layer-select';
        name.textContent =
          layer.kind === 'text'
            ? `Text: ${(layer.text ?? '').split('\n')[0]}`
            : (files[layer.fileIndex]?.name ?? 'Image layer');
        name.addEventListener('click', () => selectLayer(layer.id));
        const visibility = document.createElement('button');
        visibility.type = 'button';
        visibility.className = 'studio-composer-visibility';
        visibility.textContent = layer.visible ? '◉' : '○';
        visibility.title = layer.visible ? 'Hide layer' : 'Show layer';
        visibility.addEventListener('click', () => {
          layer.visible = !layer.visible;
          renderLayers();
          void draw();
          scheduleAutosave();
        });
        row.appendChild(name);
        row.appendChild(visibility);
        layerList.appendChild(row);
      });
      assetList.innerHTML = '';
      files.forEach((file, fileIndex) => {
        if (kindOf(file) !== 'image') return;
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'studio-composer-asset';
        add.textContent = `＋ ${file.name}`;
        add.addEventListener('click', () => void addLayer(fileIndex));
        assetList.appendChild(add);
      });
    };
    const addLayer = async (fileIndex: number): Promise<void> => {
      const file = files[fileIndex];
      if (!file || kindOf(file) !== 'image' || imageLayers.length >= 32) {
        status.textContent =
          imageLayers.length >= 32 ? 'A composition can have up to 32 layers' : 'Choose an image asset';
        return;
      }
      try {
        const bitmap = await getBitmap(fileIndex);
        const scale = Math.min(1, 760 / bitmap.width, 760 / bitmap.height);
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const layer: StudioImageLayer = {
          id: crypto.randomUUID(),
          kind: 'image',
          fileIndex,
          x: Math.round((canvas.width - width) / 2 + (imageLayers.length % 7) * 16),
          y: Math.round((canvas.height - height) / 2 + (imageLayers.length % 7) * 16),
          width,
          height,
          rotation: 0,
          opacity: 1,
          visible: true,
          blend: 'normal',
        };
        imageLayers.push(layer);
        selectedImageLayerId = layer.id;
        renderLayers();
        renderProperties();
        void draw();
        scheduleAutosave();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Could not decode this image';
      }
    };
    overlay.querySelector<HTMLButtonElement>('.studio-composer-add-text')!.addEventListener('click', () => {
      if (imageLayers.length >= 32) {
        status.textContent = 'A composition can have up to 32 layers';
        return;
      }
      const layer: StudioImageLayer = {
        id: crypto.randomUUID(),
        kind: 'text',
        fileIndex: -1,
        x: 180,
        y: 430,
        width: 720,
        height: 140,
        rotation: 0,
        opacity: 1,
        visible: true,
        blend: 'normal',
        text: 'Your title',
        color: '#ffffff',
        fontSize: 72,
        fontFamily: 'sans-serif',
      };
      imageLayers.push(layer);
      selectedImageLayerId = layer.id;
      renderLayers();
      renderProperties();
      void draw();
      scheduleAutosave();
    });

    const pointerPosition = (event: PointerEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) / rect.width) * canvas.width,
        y: ((event.clientY - rect.top) / rect.height) * canvas.height,
      };
    };
    canvas.addEventListener('pointerdown', (event) => {
      const point = pointerPosition(event);
      const hit = [...imageLayers].reverse().find((layer) => {
        const dx = point.x - (layer.x + layer.width / 2);
        const dy = point.y - (layer.y + layer.height / 2);
        const angle = (-layer.rotation * Math.PI) / 180;
        const x = dx * Math.cos(angle) - dy * Math.sin(angle);
        const y = dx * Math.sin(angle) + dy * Math.cos(angle);
        return layer.visible && Math.abs(x) <= layer.width / 2 && Math.abs(y) <= layer.height / 2;
      });
      if (!hit) return;
      selectLayer(hit.id);
      drag = { id: hit.id, dx: point.x - hit.x, dy: point.y - hit.y };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const layer = imageLayers.find((item) => item.id === drag?.id);
      if (!layer) return;
      const point = pointerPosition(event);
      layer.x = Math.round(point.x - drag.dx);
      layer.y = Math.round(point.y - drag.dy);
      const x = properties.querySelector<HTMLInputElement>('[data-prop="x"]');
      const y = properties.querySelector<HTMLInputElement>('[data-prop="y"]');
      if (x) x.value = String(layer.x);
      if (y) y.value = String(layer.y);
      void draw();
    });
    canvas.addEventListener('pointerup', () => {
      if (!drag) return;
      drag = null;
      scheduleAutosave();
    });
    const exportButton = overlay.querySelector<HTMLButtonElement>('.studio-composer-export')!;
    exportButton.addEventListener('click', async () => {
      if (imageLayers.length === 0) return;
      exportButton.disabled = true;
      await draw(false);
      canvas.toBlob((blob) => {
        exportButton.disabled = false;
        void draw();
        if (!blob) {
          status.textContent = 'Could not export this composition';
          return;
        }
        const output = new File([blob], 'flaxia-composition.png', { type: 'image/png' });
        download(output);
        files = [...files, output];
        interacted = true;
        close();
        scheduleAutosave();
        select(files.length - 1);
        status.textContent = 'PNG exported';
      }, 'image/png');
    });
    if (!initialLayer) await addLayer(initialFileIndex);
    renderLayers();
    renderProperties();
    await draw();
  };

  function select(index: number): void {
    const editingFile = files[activeIndex];
    if (
      codeDirty &&
      editingFile &&
      (kindOf(editingFile) === 'code' || (kindOf(editingFile) === 'game' && /\.html?$/i.test(editingFile.name)))
    ) {
      files[activeIndex] = new File([editorText], editingFile.name, {
        type: editingFile.type || (kindOf(editingFile) === 'game' ? 'text/html' : 'text/plain'),
      });
      codeDirty = false;
      interacted = true;
      scheduleAutosave();
    }
    stopVideoSequence();
    clearUrl();
    htmlEditing = false;
    activeIndex = index;
    const file = files[index];
    if (!file) {
      empty.style.display = '';
      preview.innerHTML = '';
      projectTitle.textContent = 'Untitled project';
      render();
      return;
    }
    projectTitle.textContent = file.name;
    empty.style.display = 'none';
    const kind = kindOf(file);
    const url = URL.createObjectURL(file);
    objectUrl = url;
    preview.innerHTML = `<div class="studio-preview-chrome"><span>${KIND_LABELS[kind]} &nbsp;/&nbsp; ${escapeHtml(file.name)}</span><div class="studio-preview-actions"><button class="studio-compose-button studio-composer-button" type="button" ${kind === 'image' ? '' : 'hidden'}>Layers</button><button class="studio-edit-button" type="button">Edit</button><button class="studio-download-button" type="button" aria-label="Download">↓</button></div></div><div class="studio-preview-content"></div>`;
    const content = preview.querySelector<HTMLElement>('.studio-preview-content')!;
    if (kind === 'image') {
      const image = document.createElement('img');
      image.src = url;
      image.alt = file.name;
      image.className = 'studio-image-preview';
      content.appendChild(image);
    } else if (kind === 'video') {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      video.className = 'studio-video-preview';
      content.appendChild(video);
    } else if (kind === 'audio') {
      const audio = document.createElement('audio');
      audio.src = url;
      audio.controls = true;
      content.appendChild(audio);
      const wave = document.createElement('div');
      wave.className = 'studio-waveform';
      wave.innerHTML = Array.from(
        { length: 72 },
        (_, i) => `<i style="height:${12 + ((i * 37 + file.size) % 62)}%"></i>`,
      ).join('');
      content.appendChild(wave);
      const audioName = document.createElement('div');
      audioName.className = 'studio-audio-name';
      audioName.textContent = file.name;
      content.appendChild(audioName);
    } else if (kind === 'code') {
      void file.text().then((text) => {
        if (destroyed || activeIndex !== index) return;
        editorText = text;
        const editor = createCodeEditor(text, file.name, () => scheduleAutosave());
        content.appendChild(editor);
        if (/\.(?:js|mjs|css)$/i.test(file.name)) {
          const run = document.createElement('button');
          run.type = 'button';
          run.className = 'studio-code-run';
          run.textContent = '▶ Run sandbox preview';
          const output = document.createElement('div');
          output.className = 'studio-code-output';
          run.addEventListener('click', () => {
            output.replaceChildren(createCodePreview(file.name, editorText));
          });
          content.insertBefore(run, editor);
          content.appendChild(output);
        }
      });
    } else if (kind === 'game') {
      if (/\.html?$/i.test(file.name)) {
        void file.text().then((html) => {
          if (destroyed || activeIndex !== index) return;
          const frame = document.createElement('iframe');
          frame.className = 'studio-game-frame';
          frame.title = `${file.name} preview`;
          frame.setAttribute('sandbox', 'allow-scripts');
          frame.srcdoc = html;
          content.appendChild(frame);
        });
      } else if (/\.zip$/i.test(file.name)) {
        content.style.position = 'relative';
        content.style.height = '46vh';
        content.style.minHeight = '250px';
        const status = document.createElement('div');
        status.className = 'studio-file-notice';
        status.textContent = 'Checking game package…';
        content.appendChild(status);
        void import('../lib/zip-executor.js')
          .then(({ previewZipFile }) => previewZipFile(file, content))
          .then((handle) => {
            if (destroyed || activeIndex !== index) {
              handle.destroy();
              return;
            }
            zipPreview = handle;
          })
          .catch((error: unknown) => {
            if (destroyed || activeIndex !== index) return;
            content.innerHTML = `<div class="studio-file-notice"><span>!</span><h2>Game preview unavailable</h2><p>${escapeHtml(error instanceof Error ? error.message : 'The package could not be opened.')}</p></div>`;
          });
      } else if (/\.swf$/i.test(file.name)) {
        content.style.position = 'relative';
        content.style.height = '46vh';
        content.style.minHeight = '250px';
        const status = document.createElement('div');
        status.className = 'studio-file-notice';
        status.textContent = 'Starting Flash runtime…';
        content.appendChild(status);
        void file
          .arrayBuffer()
          .then((data) => executeFlash(file.name, content, undefined, true, data))
          .then((handle) => {
            if (destroyed || activeIndex !== index) {
              handle.destroy();
              return;
            }
            flashPreview = handle;
          })
          .catch((error: unknown) => {
            if (destroyed || activeIndex !== index) return;
            content.innerHTML = `<div class="studio-file-notice"><span>!</span><h2>Flash preview unavailable</h2><p>${escapeHtml(error instanceof Error ? error.message : 'The SWF file could not be opened.')}</p></div>`;
          });
      } else {
        content.innerHTML = `<div class="studio-file-notice"><span>◇</span><h2>${escapeHtml(file.name)}</h2><p>Game package imported. ZIP and SWF files are ready to attach to a Flaxia post. HTML games can run in the isolated preview.</p></div>`;
      }
    } else {
      content.innerHTML = `<div class="studio-file-notice"><span>▤</span><h2>${escapeHtml(file.name)}</h2><p>${sizeLabel(file.size)} · ${escapeHtml(file.type || 'Unknown file type')}</p></div>`;
    }
    preview
      .querySelector<HTMLButtonElement>('.studio-download-button')!
      .addEventListener('click', () => download(file));
    preview.querySelector<HTMLButtonElement>('.studio-compose-button')!.addEventListener('click', () => {
      void openImageComposer(index);
    });
    preview.querySelector<HTMLButtonElement>('.studio-edit-button')!.addEventListener('click', async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      if (kind === 'image' || kind === 'audio' || kind === 'video') {
        const edited = await openMediaEditor(file);
        if (edited) {
          files[index] = edited;
          if (kind === 'video') {
            videoDurations.delete(index);
            const clip = videoClips.find((item) => item.fileIndex === index);
            if (clip) {
              clip.sourceStart = 0;
              clip.sourceEnd = 1;
            }
            ensureVideoClip(index, true);
          }
          saveState.textContent = 'Edited locally';
          interacted = true;
          scheduleAutosave();
          render();
          select(index);
        }
      } else if (kind === 'code') {
        content.querySelector<HTMLTextAreaElement>('.studio-code-editor')?.focus();
      } else if (kind === 'game' && /\.html?$/i.test(file.name)) {
        if (htmlEditing) {
          files[index] = new File([editorText], file.name, { type: 'text/html' });
          codeDirty = false;
          htmlEditing = false;
          saveState.textContent = 'Saved locally';
          interacted = true;
          scheduleAutosave();
          select(index);
          return;
        }
        void file.text().then((html) => {
          if (destroyed || activeIndex !== index) return;
          editorText = html;
          htmlEditing = true;
          content.innerHTML = '';
          content.appendChild(createCodeEditor(html, file.name, () => scheduleAutosave()));
          preview.querySelector<HTMLButtonElement>('.studio-edit-button')!.textContent = 'Preview';
        });
      } else {
        button.disabled = true;
      }
    });
    preview.querySelector<HTMLButtonElement>('.studio-edit-button')!.textContent =
      kind === 'code' ? 'Save edits' : 'Edit';
    render();
  }

  const addFiles = (additions: File[]): void => {
    if (!additions.length) return;
    interacted = true;
    files = [...files, ...additions];
    additions.forEach((_file, index) => {
      ensureAudioClip(files.length - additions.length + index, true);
      ensureVideoClip(files.length - additions.length + index, true);
    });
    saveState.textContent = 'Local files';
    select(files.length - additions.length);
    scheduleAutosave();
  };

  const importFiles = (incoming: FileList | File[]): void => {
    const additions = Array.from(incoming);
    if (!restoreFinished) {
      pendingImports.push(...additions);
      return;
    }
    addFiles(additions);
  };

  const finishRestore = (project: {
    files: File[];
    audioClips: AudioTimelineClip[];
    videoClips: StudioVideoClip[];
    imageLayers: StudioImageLayer[];
  }): void => {
    if (!interacted && files.length === 0 && project.files.length > 0) {
      files = project.files;
      audioClips = project.audioClips.filter((clip) => clip.track < 8 && clip.fileIndex < files.length);
      videoClips = project.videoClips.filter((clip) => clip.fileIndex < files.length);
      imageLayers = project.imageLayers.filter(
        (layer) =>
          layer.kind === 'text' || (layer.fileIndex < files.length && kindOf(files[layer.fileIndex]) === 'image'),
      );
      selectedImageLayerId = imageLayers.at(-1)?.id ?? null;
      videoClips.forEach((clip) => {
        manuallyPlacedVideoClips.add(clip.id);
      });
      audioTrackCount = Math.max(1, ...audioClips.map((clip) => clip.track + 1));
      saveState.textContent = 'Project restored';
      files.forEach((_file, index) => {
        ensureAudioClip(index);
        ensureVideoClip(index);
      });
      select(0);
    }
    restoreFinished = true;
    if (pendingImports.length > 0) {
      const queuedFiles = pendingImports;
      pendingImports = [];
      addFiles(queuedFiles);
    }
  };

  input.addEventListener('change', () => {
    importFiles(input.files ?? []);
    input.value = '';
  });
  projectImportButton.addEventListener('click', () => projectInput.click());
  projectInput.addEventListener('change', async () => {
    const projectFile = projectInput.files?.[0];
    projectInput.value = '';
    if (!projectFile) return;
    if (!window.confirm('Open this project and replace the current Studio workspace?')) return;
    const passphrase = window.prompt('Enter the project passphrase. It is only used in this browser.');
    if (passphrase === null) return;
    projectImportButton.disabled = true;
    projectImportButton.textContent = 'Opening…';
    try {
      const restored = await importStudioProject(projectFile, passphrase);
      if (autosaveTimer) clearTimeout(autosaveTimer);
      saveRevision++;
      await saveChain.catch(() => undefined);
      clearUrl();
      stopVideoSequence();
      audioDurations.clear();
      audioPeaks.clear();
      videoDurations.clear();
      manuallyPlacedVideoClips.clear();
      files = restored.files;
      audioClips = restored.audioClips;
      videoClips = restored.videoClips;
      imageLayers = restored.imageLayers;
      selectedImageLayerId = imageLayers.at(-1)?.id ?? null;
      audioTrackCount = Math.max(1, ...audioClips.map((clip) => clip.track + 1));
      activeIndex = -1;
      codeDirty = false;
      interacted = true;
      saveState.textContent = 'Project opened · saving to this device…';
      render();
      if (files.length > 0) select(0);
      scheduleAutosave();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not open this project');
    } finally {
      projectImportButton.disabled = false;
      projectImportButton.textContent = 'Open project';
    }
  });
  projectExportButton.addEventListener('click', async () => {
    if (files.length === 0) return;
    const passphrase = window.prompt(
      'Set a project passphrase (at least 12 characters). Keep it safe; Flaxia cannot recover it.',
    );
    if (passphrase === null) return;
    if (passphrase.length < 12) {
      window.alert('Use a passphrase with at least 12 characters.');
      return;
    }
    const confirmation = window.prompt('Enter the project passphrase again to confirm.');
    if (confirmation === null) return;
    if (confirmation !== passphrase) {
      window.alert('The passphrases do not match.');
      return;
    }
    projectExportButton.disabled = true;
    projectExportButton.textContent = 'Encrypting…';
    try {
      const snapshot = [...files];
      const activeFile = snapshot[activeIndex];
      if (
        codeDirty &&
        activeFile &&
        (kindOf(activeFile) === 'code' || (kindOf(activeFile) === 'game' && /\.html?$/i.test(activeFile.name)))
      ) {
        snapshot[activeIndex] = new File([editorText], activeFile.name, {
          type: activeFile.type || (kindOf(activeFile) === 'game' ? 'text/html' : 'text/plain'),
          lastModified: activeFile.lastModified,
        });
      }
      download(await exportStudioProject(snapshot, audioClips, videoClips, imageLayers, passphrase));
      saveState.textContent = 'Encrypted project downloaded';
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not export this project');
    } finally {
      projectExportButton.disabled = files.length === 0;
      projectExportButton.textContent = 'Save project';
    }
  });
  root
    .querySelectorAll<HTMLButtonElement>(
      '.studio-open, .studio-add, .studio-tab-open, .studio-timeline-add, .studio-dropzone, .studio-shortcut',
    )
    .forEach((button) => {
      button.addEventListener('click', () => input.click());
    });
  root.querySelectorAll<HTMLButtonElement>('.studio-tool').forEach((button) => {
    button.addEventListener('click', () => {
      root.querySelector('.studio-tool.active')?.classList.remove('active');
      button.classList.add('active');
      const filter = button.dataset.tool;
      list.querySelectorAll<HTMLElement>('.studio-asset').forEach((row, index) => {
        row.hidden = filter !== 'all' && kindOf(files[index]) !== filter;
      });
    });
  });
  exportButton.addEventListener('click', () => {
    const file = files[activeIndex];
    if (!file) return;
    if (codeDirty && (kindOf(file) === 'code' || (kindOf(file) === 'game' && /\.html?$/i.test(file.name)))) {
      const updated = new File([editorText], file.name, {
        type: file.type || (kindOf(file) === 'game' ? 'text/html' : 'text/plain'),
      });
      files[activeIndex] = updated;
      codeDirty = false;
      saveState.textContent = 'Saved locally';
      exportButton.textContent = 'Export';
      interacted = true;
      scheduleAutosave();
      render();
      select(activeIndex);
      return;
    }
    download(file);
  });
  createPostButton.addEventListener('click', async () => {
    if (files.length === 0 || createPostButton.disabled) return;
    createPostButton.disabled = true;
    createPostButton.textContent = 'Preparing…';
    try {
      const currentFile = files[activeIndex];
      if (
        codeDirty &&
        currentFile &&
        (kindOf(currentFile) === 'code' || (kindOf(currentFile) === 'game' && /\.html?$/i.test(currentFile.name)))
      ) {
        files[activeIndex] = new File([editorText], currentFile.name, {
          type: currentFile.type || (kindOf(currentFile) === 'game' ? 'text/html' : 'text/plain'),
        });
        codeDirty = false;
      }
      if (autosaveTimer) clearTimeout(autosaveTimer);
      saveRevision++;
      await saveChain.catch(() => undefined);
      const vaultKey = getVaultKey();
      if (vaultKey)
        await saveStudioProject(files, audioClips, videoClips, imageLayers, vaultKey).catch(() => undefined);
      const token = saveStudioHandoff(files);
      window.history.pushState({}, '', `/home?studio_handoff=${encodeURIComponent(token)}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch {
      saveState.textContent = 'Could not prepare post';
      createPostButton.disabled = false;
      createPostButton.textContent = 'Create post ↗';
    }
  });
  addTrackButton.addEventListener('click', () => {
    if (audioTrackCount >= 8) return;
    audioTrackCount++;
    renderAudioTimeline();
    scheduleAutosave();
  });
  const renderMixdown = async (): Promise<File> => {
    mixPlayButton.disabled = true;
    mixExportButton.disabled = true;
    mixStatus.textContent = 'Rendering…';
    try {
      const output = await mixAudioTimeline(files, audioClips);
      mixStatus.textContent = `${output.name} · ${sizeLabel(output.size)}`;
      return output;
    } catch (error) {
      mixStatus.textContent = error instanceof Error ? error.message : 'Could not render mix';
      throw error;
    } finally {
      mixPlayButton.disabled = audioClips.length === 0;
      mixExportButton.disabled = audioClips.length === 0;
    }
  };
  mixPlayButton.addEventListener('click', async () => {
    try {
      const output = await renderMixdown();
      if (mixPreview) mixPreview.pause();
      if (mixPreviewUrl) URL.revokeObjectURL(mixPreviewUrl);
      mixPreviewUrl = URL.createObjectURL(output);
      mixPreview = new Audio(mixPreviewUrl);
      await mixPreview.play();
      mixStatus.textContent = 'Playing rendered mix';
    } catch {
      // The render status already explains the failure.
    }
  });
  mixExportButton.addEventListener('click', async () => {
    try {
      download(await renderMixdown());
      mixStatus.textContent = 'WAV downloaded';
    } catch {
      // The render status already explains the failure.
    }
  });
  videoPlayButton.addEventListener('click', () => {
    if (videoSequencePlayer) {
      stopVideoSequence();
      return;
    }
    const sequence = [...videoClips].sort((left, right) => left.start - right.start);
    if (sequence.length === 0) return;
    const stage = root.querySelector<HTMLElement>('.studio-stage')!;
    const player = document.createElement('video');
    player.className = 'studio-sequence-player';
    player.controls = true;
    player.playsInline = true;
    player.setAttribute('aria-label', 'Video sequence preview');
    stage.appendChild(player);
    videoSequencePlayer = player;
    videoPlayButton.textContent = '■ Stop preview';
    let activeClip: StudioVideoClip | null = null;
    let advancing = false;
    let playAt: (index: number) => void = () => undefined;
    const playClip = (index: number): void => {
      if (index >= sequence.length || !videoSequencePlayer) {
        mixStatus.textContent = 'Video sequence finished';
        stopVideoSequence();
        return;
      }
      videoSequenceIndex = index;
      activeClip = sequence[index];
      const file = files[activeClip.fileIndex];
      if (!file) {
        playAt(index + 1);
        return;
      }
      player.style.visibility = 'visible';
      if (videoSequenceUrl) URL.revokeObjectURL(videoSequenceUrl);
      videoSequenceUrl = URL.createObjectURL(file);
      player.src = videoSequenceUrl;
      player.onloadedmetadata = () => {
        if (videoSequenceIndex !== index) return;
        advancing = false;
        player.currentTime = Math.min(activeClip?.sourceStart ?? 0, player.duration || 0);
        void player.play().catch(() => {
          mixStatus.textContent = 'Press play in the video preview to continue';
        });
      };
      mixStatus.textContent = `Video ${index + 1} / ${sequence.length}`;
    };
    playAt = (index: number): void => {
      if (index >= sequence.length || !videoSequencePlayer) {
        playClip(index);
        return;
      }
      const clip = sequence[index];
      const previous = index > 0 ? sequence[index - 1] : null;
      const previousEnd = previous ? previous.start + previous.sourceEnd - previous.sourceStart : 0;
      const gap = Math.max(0, clip.start - previousEnd);
      if (gap <= 0.04) {
        playClip(index);
        return;
      }
      videoSequenceIndex = index;
      player.pause();
      player.removeAttribute('src');
      player.load();
      if (videoSequenceUrl) URL.revokeObjectURL(videoSequenceUrl);
      videoSequenceUrl = null;
      player.style.visibility = 'hidden';
      mixStatus.textContent = `Gap · ${gap.toFixed(1)}s`;
      videoSequenceTimer = setTimeout(() => {
        videoSequenceTimer = null;
        playClip(index);
      }, gap * 1000);
    };
    const advance = (): void => {
      if (videoSequenceIndex >= 0 && !advancing) {
        advancing = true;
        playAt(videoSequenceIndex + 1);
      }
    };
    player.addEventListener('timeupdate', () => {
      if (activeClip && player.currentTime >= activeClip.sourceEnd - 0.04) advance();
    });
    player.addEventListener('ended', advance);
    playAt(0);
  });
  videoExportButton.addEventListener('click', async () => {
    if (videoClips.length === 0) return;
    stopVideoSequence();
    videoExportButton.disabled = true;
    mixStatus.textContent = 'Encoding MP4 · 0%';
    try {
      const output = await renderVideoSequence(files, videoClips, audioClips, (progress) => {
        mixStatus.textContent = `Encoding MP4 · ${Math.round(progress * 100)}%`;
      });
      download(output);
      mixStatus.textContent = `MP4 downloaded · ${sizeLabel(output.size)}`;
    } catch (error) {
      mixStatus.textContent = error instanceof Error ? error.message : 'Could not export video sequence';
    } finally {
      videoExportButton.disabled = videoClips.length === 0;
    }
  });
  root.addEventListener('dragover', (event) => {
    event.preventDefault();
    root.classList.add('dragging');
  });
  root.addEventListener('dragleave', (event) => {
    if (!root.contains(event.relatedTarget as Node | null)) root.classList.remove('dragging');
  });
  root.addEventListener('drop', (event) => {
    event.preventDefault();
    root.classList.remove('dragging');
    if (event.dataTransfer?.files.length) importFiles(event.dataTransfer.files);
  });
  const keyHandler = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      input.click();
    }
  };
  window.addEventListener('keydown', keyHandler);
  void (async () => {
    if (!getVaultKey()) await tryDeviceUnlock();
    const vaultKey = getVaultKey();
    if (!vaultKey) {
      if (destroyed) return;
      saveState.textContent = 'Unlock Vault to restore saved projects';
      finishRestore({ files: [], audioClips: [], videoClips: [], imageLayers: [] });
      return;
    }
    const project = await loadStudioProject(vaultKey);
    if (!destroyed) finishRestore(project);
  })().catch(() => {
    if (destroyed) return;
    saveState.textContent = 'Could not restore encrypted project';
    finishRestore({ files: [], audioClips: [], videoClips: [], imageLayers: [] });
  });

  return {
    getElement: () => root,
    destroy: () => {
      destroyed = true;
      if (autosaveTimer) clearTimeout(autosaveTimer);
      mixPreview?.pause();
      if (mixPreviewUrl) URL.revokeObjectURL(mixPreviewUrl);
      clearUrl();
      stopVideoSequence();
      window.removeEventListener('keydown', keyHandler);
      root.remove();
    },
  };
}

const studioCss = `
.studio-composer-add-text{padding:2px 5px;border:1px solid #393d46;border-radius:4px;background:#24272e;color:#dce0e7;font-size:9px;letter-spacing:0;cursor:pointer}.studio-composer-text-label{display:flex;flex-direction:column;gap:5px;margin:8px 0;color:#aeb3bd;font-size:10px}.studio-composer-text-label textarea{min-height:58px;resize:vertical;padding:6px;border:1px solid #383c46;border-radius:4px;background:#111216;color:#e9ebef;font:11px/1.4 system-ui,sans-serif}.studio-composer-field input[type=color]{width:42px;height:26px;padding:2px}
.studio-layout{max-width:none}.studio-layout>.right-panel{display:none}.studio-page{--studio-bg:#101114;--studio-panel:#17191e;--studio-border:#282b33;--studio-muted:#888e9a;--studio-text:#eceef2;--studio-accent:#b8ef6a;display:flex;flex:1;flex-direction:column;width:calc(100% - 240px);min-width:0;height:100dvh;min-height:620px;background:var(--studio-bg);color:var(--studio-text);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.studio-topbar{height:56px;flex:0 0 56px;display:flex;align-items:center;gap:22px;padding:0 20px;border-bottom:1px solid var(--studio-border);background:#15171b}.studio-brand{display:flex;align-items:center;gap:7px;color:var(--studio-text);font-weight:750;text-decoration:none;white-space:nowrap}.studio-brand i{color:#626874;font-style:normal}.studio-brand-mark{display:grid;place-items:center;width:23px;height:23px;border-radius:7px;background:var(--studio-accent);color:#182012;font-size:18px}.studio-project-name{display:flex;align-items:center;gap:8px;min-width:0;margin-right:auto;font-size:12px}.studio-project-title{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650}.studio-save-state{color:var(--studio-muted);font-size:11px}.studio-live-dot{width:7px;height:7px;border-radius:50%;background:var(--studio-accent)}.studio-top-actions{display:flex;gap:7px}.studio-button{border:1px solid var(--studio-border);border-radius:6px;padding:8px 11px;background:#202228;color:var(--studio-text);font-size:12px;font-weight:600;cursor:pointer}.studio-button:hover:not(:disabled){border-color:#555b67;background:#272a31}.studio-button:disabled{opacity:.45;cursor:default}.studio-create-post{background:var(--studio-accent);border-color:var(--studio-accent);color:#17200f}.studio-workspace{display:grid;grid-template-columns:58px 235px minmax(320px,1fr) 280px;flex:1;min-height:0}.studio-rail{display:flex;flex-direction:column;align-items:center;gap:7px;padding:14px 6px;border-right:1px solid var(--studio-border);background:#14161a}.studio-tool{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;width:46px;height:49px;border:0;border-radius:6px;background:transparent;color:#9da3ad;font-size:9px;cursor:pointer}.studio-tool b{font-size:17px;font-weight:500}.studio-tool:hover,.studio-tool.active{background:#292c33;color:var(--studio-accent)}.studio-assets,.studio-inspector{min-width:0;overflow:auto;background:var(--studio-panel)}.studio-assets{display:flex;flex-direction:column;border-right:1px solid var(--studio-border)}.studio-panel-heading,.studio-project-label{display:flex;align-items:center;gap:8px;padding:13px 14px;color:var(--studio-muted);font-size:10px;font-weight:700;letter-spacing:.07em}.studio-panel-heading{justify-content:space-between}.studio-add,.studio-tab-open,.studio-shortcut,.studio-timeline-add{border:1px solid transparent;border-radius:5px;background:transparent;color:var(--studio-muted);cursor:pointer}.studio-add{font-size:17px}.studio-add:hover,.studio-tab-open:hover,.studio-shortcut:hover,.studio-timeline-add:hover{border-color:var(--studio-border);color:var(--studio-text)}.studio-project-label{padding-top:5px;padding-bottom:8px;color:#d3d6dc;font-weight:600;letter-spacing:0}.studio-folder{color:var(--studio-accent)}.studio-count{margin-left:auto;color:var(--studio-muted)}.studio-file-list{display:flex;flex-direction:column;gap:2px;padding:0 7px}.studio-asset{display:flex;align-items:center;gap:8px;min-width:0;padding:8px;border:0;border-radius:5px;background:transparent;color:var(--studio-text);text-align:left;cursor:pointer}.studio-asset:hover,.studio-asset.active{background:#272a31}.studio-asset-icon{flex:0 0 24px;color:#abb0ba;text-align:center}.studio-kind-image{color:#7fc8ff}.studio-kind-video{color:#c8a8ff}.studio-kind-audio{color:#9bd77b}.studio-asset-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.studio-asset-size{margin-left:auto;color:var(--studio-muted);font-size:9px;white-space:nowrap}.studio-dropzone{display:flex;flex-direction:column;align-items:center;gap:6px;margin:18px 12px;padding:16px 8px;border:1px dashed #3c404a;border-radius:7px;background:#1b1d22;color:#d8dbe1;cursor:pointer}.studio-dropzone>span{color:var(--studio-accent);font-size:19px}.studio-dropzone small,.studio-sidebar-note{color:var(--studio-muted);font-size:10px}.studio-sidebar-note{margin:auto 13px 14px;line-height:1.6}.studio-sidebar-note a{color:var(--studio-accent);text-decoration:none}.studio-center{display:grid;grid-template-rows:38px minmax(180px,1fr) auto;min-width:0;min-height:0;background:#111216}.studio-tabs{display:flex;align-items:center;gap:9px;padding:0 12px;border-bottom:1px solid var(--studio-border);color:var(--studio-muted);font-size:11px}.studio-tab.active{color:var(--studio-text)}.studio-tab-open{font-size:15px}.studio-center-spacer{flex:1}.studio-shortcut{padding:4px 7px;font-size:10px}.studio-stage{position:relative;display:grid;place-items:center;min-height:0;overflow:auto;padding:22px;background:radial-gradient(ellipse at center,#1d2026 0,#111216 70%)}.studio-empty{display:flex;flex-direction:column;align-items:center;text-align:center}.studio-empty-art{position:relative;display:grid;place-items:center;width:180px;height:130px;margin-bottom:8px}.studio-orbit{position:absolute;width:130px;height:74px;border:1px solid #383d46;border-radius:50%;transform:rotate(-22deg)}.studio-orbit-two{transform:rotate(34deg)}.studio-empty-glyph{color:var(--studio-accent);font-size:46px}.studio-float{position:absolute;display:grid;place-items:center;width:29px;height:29px;border:1px solid #393e47;border-radius:8px;background:#20232a;color:#c8d1bd}.studio-float-image{top:16px;left:22px}.studio-float-audio{right:15px;top:38px}.studio-float-code{bottom:12px;left:38px;font-size:10px}.studio-float-game{right:37px;bottom:11px}.studio-empty h1{margin:8px 0;font-size:19px}.studio-empty p{max-width:360px;margin:0 0 15px;color:var(--studio-muted);font-size:12px}.studio-empty small{margin-top:9px;color:var(--studio-muted);font-size:10px}.studio-primary{background:var(--studio-accent);border-color:var(--studio-accent);color:#17200f}.studio-preview{display:flex;flex-direction:column;width:min(100%,900px);max-height:100%;min-height:0}.studio-preview-chrome{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 10px;border:1px solid var(--studio-border);border-bottom:0;border-radius:7px 7px 0 0;background:#1a1c21;color:#c7cbd2;font-size:10px}.studio-preview-actions{display:flex;gap:5px}.studio-preview-actions button{border:1px solid var(--studio-border);border-radius:4px;background:#252830;color:var(--studio-text);cursor:pointer}.studio-preview-content{display:flex;flex-direction:column;align-items:center;gap:10px;min-height:0;overflow:auto;padding:13px;border:1px solid var(--studio-border);border-radius:0 0 7px 7px;background:#17191e}.studio-image-preview{max-width:100%;max-height:58vh;object-fit:contain}.studio-video-preview{width:min(100%,820px);max-height:58vh;background:#000}.studio-preview-content audio{width:min(100%,620px);margin:24px auto}.studio-waveform{display:flex;align-items:center;gap:3px;width:min(100%,650px);height:75px}.studio-waveform i{flex:1;background:#567c48;border-radius:3px}.studio-audio-name{color:var(--studio-muted);font-size:11px}.studio-file-notice{max-width:560px;margin:auto;text-align:center;color:var(--studio-muted);font-size:12px;line-height:1.6}.studio-file-notice h2{color:var(--studio-text);font-size:16px}.studio-game-frame{width:min(100%,860px);height:min(56vh,600px);border:1px solid var(--studio-border);border-radius:6px;background:#fff}.studio-inspector{border-left:1px solid var(--studio-border)}.studio-inspector-tabs{display:flex;gap:20px;padding:14px;border-bottom:1px solid var(--studio-border);color:var(--studio-muted);font-size:11px}.studio-inspector-tabs .active{color:var(--studio-text)}.studio-inspector-body{padding:17px 15px;color:var(--studio-text)}.studio-inspector-body h2{overflow-wrap:anywhere;font-size:14px}.studio-inspector-body p{color:var(--studio-muted);font-size:11px;line-height:1.5}.studio-inspector-icon{font-size:21px;color:var(--studio-accent)}.studio-inspector-divider{height:1px;margin:14px 0;background:var(--studio-border)}.studio-format-title{margin-bottom:11px;color:var(--studio-muted);font-size:9px;font-weight:700;letter-spacing:.08em}.studio-format-list{display:grid;grid-template-columns:1fr;gap:5px}.studio-format-list span{margin-top:6px;color:#d8dbe1;font-size:9px;font-weight:700}.studio-format-list small{color:var(--studio-muted);font-size:10px}.studio-local-badge{margin-top:20px;padding:8px;border:1px solid #354333;border-radius:5px;color:#a6cf8a;font-size:10px}.studio-timeline{display:flex;flex-direction:column;min-height:0;max-height:290px;border-top:1px solid var(--studio-border);background:#17191e}.studio-timeline-head{display:flex;align-items:center;gap:7px;min-height:39px;padding:0 10px;border-bottom:1px solid var(--studio-border);color:#d9dce2;font-size:10px;font-weight:650}.studio-timeline-hint{margin-right:auto;color:var(--studio-muted);font-size:9px;font-weight:400}.studio-track{display:flex;align-items:stretch;min-height:45px;border-bottom:1px solid var(--studio-border)}.studio-track-label{position:sticky;left:0;z-index:2;display:grid;place-items:center;flex:0 0 54px;background:#1b1d22;color:var(--studio-muted);font-size:9px;font-weight:700}.studio-track-content{display:flex;align-items:center;gap:6px;min-width:0;overflow-x:auto;padding:5px 8px}.studio-track-empty{color:var(--studio-muted);font-size:10px}.studio-clip-list{display:flex;gap:6px}.studio-clip{display:flex;align-items:center;gap:7px;max-width:210px;padding:6px 9px;overflow:hidden;border:1px solid var(--studio-border);border-radius:5px;background:#24262d;color:var(--studio-text);text-overflow:ellipsis;white-space:nowrap;font-size:10px;cursor:pointer}.studio-clip.active{border-color:var(--studio-accent)}.studio-clip span{color:var(--studio-muted);font-size:8px;font-weight:700}
.studio-audio-workarea{overflow:auto;max-height:220px;background:#121318}.studio-audio-timeline{position:relative;min-width:100%;font-size:11px}.studio-audio-ruler{height:22px;position:relative;border-bottom:1px solid var(--studio-border);background:repeating-linear-gradient(90deg,transparent 0,transparent 208px,#292c34 209px,#292c34 210px)}.studio-audio-ruler>span{position:absolute;top:4px;color:var(--studio-muted);font-variant-numeric:tabular-nums}.studio-audio-lane{display:flex;min-height:48px;border-bottom:1px solid var(--studio-border)}.studio-audio-track-label{position:sticky;left:0;z-index:2;flex:0 0 48px;padding:17px 8px;background:#191b20;color:#9ea4af;border-right:1px solid var(--studio-border)}.studio-audio-lane-canvas{position:relative;min-height:47px;background:repeating-linear-gradient(90deg,transparent 0,transparent 41px,#202229 41px,#202229 42px)}.studio-audio-clip{position:absolute;top:5px;height:37px;overflow:hidden;border:1px solid #4e8142;border-radius:5px;background:#233a2a;color:#e7f5dd;text-align:left;cursor:grab}.studio-audio-clip.active{outline:1px solid var(--studio-accent)}.studio-audio-clip.muted{opacity:.48}.studio-audio-clip-name{position:absolute;z-index:1;left:6px;top:3px;max-width:calc(100% - 12px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.studio-audio-clip-wave{position:absolute;inset:17px 5px 2px;display:flex;align-items:center;gap:2px;opacity:.65}.studio-audio-clip-wave i{flex:1;min-width:1px;background:#9bd77b}.studio-audio-empty{padding:10px;color:var(--studio-muted)}.studio-timeline-head>button{border:1px solid var(--studio-border);border-radius:4px;background:#202228;color:var(--studio-text);padding:4px 8px;font-size:11px;cursor:pointer}.studio-timeline-head>button:disabled{opacity:.45;cursor:default}.studio-mix-status{max-width:190px;overflow:hidden;color:var(--studio-muted);text-overflow:ellipsis;white-space:nowrap;font-size:10px}.studio-property{display:flex;align-items:center;gap:8px;margin:12px 0;font-size:12px}.studio-property>span{flex:1}.studio-property input[type=number]{width:76px;padding:5px;border:1px solid var(--studio-border);border-radius:4px;background:#111216;color:var(--studio-text)}.studio-property small{color:var(--studio-muted)}.studio-property input[type=range]{width:105px}.studio-mute-property{justify-content:flex-start}.studio-mute-property input{accent-color:var(--studio-accent)}
.studio-video-workarea{overflow:auto;max-height:100px;background:#121318}.studio-video-timeline{position:relative;min-width:100%;font-size:11px}.studio-video-ruler{height:22px;position:relative;border-bottom:1px solid var(--studio-border);background:repeating-linear-gradient(90deg,transparent 0,transparent 208px,#292c34 209px,#292c34 210px)}.studio-video-ruler>span{position:absolute;top:4px;color:var(--studio-muted);font-variant-numeric:tabular-nums}.studio-video-lane{display:flex;min-height:46px;border-bottom:1px solid var(--studio-border)}.studio-video-track-label{position:sticky;left:0;z-index:2;flex:0 0 48px;padding:16px 8px;background:#191b20;color:#9ea4af;border-right:1px solid var(--studio-border)}.studio-video-lane-canvas{position:relative;min-height:45px;background:repeating-linear-gradient(90deg,transparent 0,transparent 41px,#202229 41px,#202229 42px)}.studio-video-clip{position:absolute;top:5px;height:35px;overflow:hidden;border:1px solid #69519b;border-radius:5px;background:#34294a;color:#eee6ff;text-align:left;text-overflow:ellipsis;white-space:nowrap;cursor:grab}.studio-video-clip.active{outline:1px solid #c8a8ff}.studio-video-hint{color:var(--studio-muted);font-size:11px}
.studio-code-workbench{display:flex;flex-direction:column;min-height:280px;max-height:48vh;border:1px solid var(--studio-border);border-radius:6px;background:#101116;overflow:hidden}.studio-code-toolbar{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:6px;border-bottom:1px solid var(--studio-border)}.studio-code-toolbar input{min-width:70px;width:22%;padding:5px 7px;border:1px solid var(--studio-border);border-radius:4px;background:#191b20;color:var(--studio-text);font:11px system-ui,sans-serif}.studio-code-toolbar input[type=number]{width:54px}.studio-code-toolbar button,.studio-code-run{padding:5px 8px;border:1px solid var(--studio-border);border-radius:4px;background:#202228;color:var(--studio-text);font-size:11px;cursor:pointer}.studio-code-row{display:flex;flex:1;min-height:0;overflow:hidden}.studio-code-gutter{flex:0 0 42px;padding:12px 8px 12px 0;overflow:hidden;background:#15161b;color:#686e7a;text-align:right;white-space:pre;font:12px/20px ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none}.studio-code-editor{flex:1;min-width:0;min-height:260px;padding:12px;border:0;outline:0;resize:vertical;background:#101116;color:#e3e5eb;caret-color:#b8ef6a;font:12px/20px ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:2;white-space:pre;overflow:auto}.studio-code-run{margin:8px 0}.studio-code-output{min-height:80px}.studio-code-preview{width:100%;height:250px;border:1px solid var(--studio-border);border-radius:6px;background:white}
.studio-sequence-player{position:absolute;z-index:5;inset:6% 8%;width:84%;height:88%;max-height:88%;background:#000;border:1px solid var(--studio-border);border-radius:8px;box-shadow:0 12px 40px #0009}
.studio-composer-button{border:1px solid #536843!important;background:#273323!important;color:#d8f3c2!important}.studio-composer-overlay{position:fixed;z-index:1000;inset:0;display:flex;flex-direction:column;background:#111216;color:#eceef2;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.studio-composer-header{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:58px;padding:8px 18px;border-bottom:1px solid #30333a;background:#181a1f}.studio-composer-header>div:first-child{display:flex;flex-direction:column;gap:4px}.studio-composer-header b{font-size:13px}.studio-composer-header small{color:#9298a3;font-size:10px}.studio-composer-header>div:last-child{display:flex;gap:8px}.studio-composer-header button,.studio-composer-order button,.studio-composer-remove{border:1px solid #393d46;border-radius:5px;background:#24272e;color:#e7e9ee;padding:7px 10px;font-size:11px;cursor:pointer}.studio-composer-export{background:#b8ef6a!important;border-color:#b8ef6a!important;color:#17200f!important;font-weight:700}.studio-composer-header .studio-composer-close{width:32px;padding:2px;font-size:21px}.studio-composer-layout{display:grid;grid-template-columns:minmax(0,1fr) 280px;flex:1;min-height:0}.studio-composer-board{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:0;min-height:0;padding:16px;background:#101115}.studio-composer-canvas-wrap{width:min(72vw,68vh);height:min(72vw,68vh);max-width:100%;max-height:100%;background-color:#202228;background-image:linear-gradient(45deg,#2b2d34 25%,transparent 25%),linear-gradient(-45deg,#2b2d34 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#2b2d34 75%),linear-gradient(-45deg,transparent 75%,#2b2d34 75%);background-size:24px 24px;background-position:0 0,0 12px,12px -12px,-12px 0}.studio-composer-canvas{display:block;width:100%;height:100%;touch-action:none;cursor:move}.studio-composer-status{min-height:22px;padding-top:8px;color:#f0a4a4;font-size:11px}.studio-composer-panel{min-width:0;overflow:auto;padding:12px;border-left:1px solid #30333a;background:#181a1f}.studio-composer-section{margin-bottom:17px}.studio-composer-title{display:flex;justify-content:space-between;margin-bottom:8px;color:#9298a3;font-size:9px;font-weight:700;letter-spacing:.08em}.studio-composer-count{color:#c1c5cd}.studio-composer-assets,.studio-composer-layers{display:flex;flex-direction:column;gap:4px;max-height:175px;overflow:auto}.studio-composer-asset,.studio-composer-layer{display:flex;align-items:center;gap:6px;min-width:0;border:1px solid transparent;border-radius:5px;background:#202229;color:#e4e6eb;font-size:10px}.studio-composer-asset{padding:7px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.studio-composer-asset:hover{border-color:#61764d}.studio-composer-layer{padding:3px}.studio-composer-layer.active{border-color:#b8ef6a}.studio-composer-layer-select{flex:1;min-width:0;padding:5px;border:0;background:transparent;color:inherit;text-align:left;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;font-size:10px;cursor:pointer}.studio-composer-visibility{border:0;background:transparent;color:#c2c7d0;cursor:pointer}.studio-composer-properties{padding-top:3px}.studio-composer-layer-name{margin-bottom:9px;overflow:hidden;color:#dce0e7;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.studio-composer-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.studio-composer-grid label,.studio-composer-field{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:6px 0;color:#aeb3bd;font-size:10px}.studio-composer-grid input,.studio-composer-field input,.studio-composer-field select{width:90px;padding:5px;border:1px solid #383c46;border-radius:4px;background:#111216;color:#e9ebef;font:11px system-ui,sans-serif}.studio-composer-field select{width:125px}.studio-composer-range{display:flex;flex-wrap:wrap;justify-content:space-between;gap:5px;margin:12px 0;color:#aeb3bd;font-size:10px}.studio-composer-range input{width:100%;accent-color:#b8ef6a}.studio-composer-range output{color:#e9ebef}.studio-composer-order{display:flex;gap:6px;margin:11px 0}.studio-composer-order button{flex:1;padding:6px 4px;font-size:9px}.studio-composer-remove{width:100%;margin-top:4px;border-color:#5c3737;color:#f0b8b8}.studio-composer-properties>p{color:#9298a3;font-size:10px}
@media(max-width:1050px){.studio-workspace{grid-template-columns:58px 190px minmax(300px,1fr)}.studio-inspector{display:none}.studio-topbar{padding:0 12px}.studio-project-name{display:none}}
@media(max-width:768px){.studio-page{width:100%;height:calc(100dvh - var(--bottom-nav-h, 62px));min-height:420px}.studio-workspace{grid-template-columns:48px minmax(0,1fr)}.studio-assets{display:none}.studio-rail{padding:10px 3px}.studio-tool{width:42px;height:47px}.studio-topbar{height:50px;flex-basis:50px;padding:0 8px}.studio-brand{font-size:13px}.studio-top-actions{gap:4px}.studio-top-actions .studio-button{padding:7px 8px;font-size:10px}.studio-empty-art{transform:scale(.8);margin:-12px 0}.studio-empty h1{font-size:16px}.studio-empty p{max-width:260px;line-height:1.5}.studio-timeline{height:205px;max-height:44vh}.studio-timeline-head{overflow-x:auto;flex:0 0 39px}.studio-timeline-hint{display:none}.studio-timeline-head>button{flex:0 0 auto}.studio-video-workarea{max-height:62px}.studio-video-ruler{height:17px}.studio-video-ruler>span{top:2px}.studio-video-lane{min-height:40px}.studio-video-track-label{padding:13px 7px}.studio-video-lane-canvas{min-height:39px}.studio-video-clip{height:30px}.studio-track{min-height:38px}.studio-audio-workarea{max-height:95px}.studio-audio-ruler{height:17px}.studio-audio-ruler>span{top:2px}.studio-audio-lane{min-height:40px}.studio-audio-track-label{padding:13px 7px}.studio-audio-lane-canvas{min-height:39px}.studio-audio-clip{height:30px}.studio-sequence-player{inset:8% 3%;width:94%;height:84%}}
@media(max-width:768px){.studio-composer-layout{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) 205px}.studio-composer-board{padding:8px}.studio-composer-canvas-wrap{width:min(78vw,48vh);height:min(78vw,48vh)}.studio-composer-panel{padding:8px;border-top:1px solid #30333a;border-left:0}.studio-composer-section{margin-bottom:9px}.studio-composer-assets,.studio-composer-layers{max-height:65px}}
`;

if (!document.getElementById('studio-page-styles')) {
  const style = document.createElement('style');
  style.id = 'studio-page-styles';
  style.textContent = studioCss;
  document.head.appendChild(style);
}
