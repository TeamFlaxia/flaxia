import type * as Monaco from 'monaco-editor';
import { STUDIO_CONSOLE_CONNECT_MESSAGE } from '../lib/bridge.js';
import {
  type AudioTimelineClip,
  audibleAudioTimelineClips,
  audioClipEqSettings,
  audioClipGainEnvelope,
  audioClipGainEnvelopeAt,
  audioClipGainEnvelopePoints,
  audioClipSpeed,
  audioClipTimelineDuration,
  audioTrackMixSettings,
  mixAudioTimeline,
  moveAudioClipGainEnvelopePoint,
  removeAudioClipGainEnvelopePoint,
  setAudioClipGainEnvelopePoint,
  soloAudioTimelineClip,
  splitAudioClipGainEnvelope,
} from '../lib/editor/audio-mixer.ts';
import { createAudioRecordingFile, preferredAudioRecordingMimeType } from '../lib/editor/audio-recorder.ts';
import { imageLayerOpacityAt, nudgeImageLayerPosition } from '../lib/editor/image-adjustments.ts';
import { drawStudioImageLayer, STUDIO_IMAGE_BLEND_MODES } from '../lib/editor/image-layer-canvas.ts';
import {
  injectStudioConsoleBridge,
  parseStudioConsoleEntry,
  type StudioConsoleEntry,
} from '../lib/editor/studio-console.ts';
import { sameStudioFileHistoryState } from '../lib/editor/studio-edit-history.ts';
import { saveStudioHandoff } from '../lib/editor/studio-handoff.js';
import { resolveStudioPostMode } from '../lib/editor/studio-post-plan.ts';
import {
  exportStudioProject,
  importStudioProject,
  loadStudioProject,
  type StudioImageLayer,
  type StudioVideoClip,
  type StudioVideoFormat,
  saveStudioProject,
} from '../lib/editor/studio-project-store.js';
import {
  createStudioStarterFile,
  STUDIO_STARTER_TEMPLATES,
  type StudioStarterTemplateId,
} from '../lib/editor/studio-starter-files.ts';
import { probeVideo } from '../lib/editor/video-editor.ts';
import {
  renderVideoSequence,
  studioVideoFrameSize,
  studioVideoLayerPlacement,
  videoClipOpacityAt,
} from '../lib/editor/video-sequence.ts';
import { rippleOverlappingVideoClips, videoClipTransitionDuration } from '../lib/editor/video-timeline.ts';
import { computeAudioPeaks } from '../lib/editor/waveform.ts';
import { getVaultKey, tryDeviceUnlock } from '../lib/vault/session.js';
import type { ZipExecutorHandle } from '../lib/zip-executor.js';
import { executeFlash, type FlashPlayerHandle } from './FlashPlayer.js';
import { openMediaEditor } from './MediaEditorModal.js';

type StudioKind = 'image' | 'video' | 'audio' | 'code' | 'game' | 'other';

function videoClipSpeed(clip: StudioVideoClip): number {
  return Math.max(0.5, Math.min(2, clip.speed ?? 1));
}

function videoClipTimelineDuration(clip: StudioVideoClip): number {
  return (clip.sourceEnd - clip.sourceStart) / videoClipSpeed(clip);
}

type StudioEditHistorySnapshot = {
  files: File[];
  activeIndex: number;
  audioClips: AudioTimelineClip[];
  videoClips: StudioVideoClip[];
  videoFormat: StudioVideoFormat;
  imageLayers: StudioImageLayer[];
  audioTrackCount: number;
  selectedAudioClipId: string | null;
  selectedVideoClipId: string | null;
  selectedImageLayerId: string | null;
};

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
  if (
    [
      'html',
      'htm',
      'css',
      'scss',
      'less',
      'js',
      'mjs',
      'cjs',
      'jsx',
      'ts',
      'tsx',
      'json',
      'jsonc',
      'txt',
      'md',
      'mdx',
      'glsl',
      'vert',
      'frag',
      'wgsl',
      'rsp',
      'py',
      'pyw',
      'yaml',
      'yml',
      'xml',
      'sh',
      'bash',
      'sql',
      'rs',
      'go',
      'java',
      'c',
      'h',
      'cc',
      'cpp',
      'cxx',
      'hpp',
      'cs',
      'lua',
      'php',
      'rb',
      'swift',
      'graphql',
      'gql',
      'toml',
      'conf',
      'dockerfile',
      'ini',
    ].includes(ext)
  ) {
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

function highlightCode(source: string, fileName: string): string {
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  const pattern =
    extension === 'html' || extension === 'htm'
      ? /<!--[\s\S]*?-->|<\/?[a-z][^>]*>/gi
      : extension === 'md'
        ? /^#{1,6}[^\n]*|\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:true|false|null|undefined)\b/gm
        : /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|#[\da-f]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%)?\b|\b(?:async|await|break|case|catch|class|const|continue|default|else|export|extends|false|for|from|function|if|import|in|interface|let|new|null|of|return|static|switch|this|throw|true|try|type|undefined|var|while)\b/g;
  let cursor = 0;
  let output = '';
  for (const match of source.matchAll(pattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    output += escapeHtml(source.slice(cursor, start));
    let tokenClass = '';
    if (token.startsWith('<!--') || token.startsWith('/*') || token.startsWith('//')) tokenClass = 'comment';
    else if (token.startsWith('<')) tokenClass = 'tag';
    else if (extension === 'md' && token.startsWith('#')) tokenClass = 'heading';
    else if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) tokenClass = 'string';
    else if (token.startsWith('#')) tokenClass = 'color';
    else if (/^\d/.test(token)) tokenClass = 'number';
    else if (/^(true|false|null|undefined)$/.test(token)) tokenClass = 'literal';
    else if (
      /^(async|await|break|case|catch|class|const|continue|default|else|export|extends|for|from|function|if|import|in|interface|let|new|of|return|static|switch|this|throw|try|type|var|while)$/.test(
        token,
      )
    )
      tokenClass = 'keyword';
    else if (extension === 'css' && /^\s*:/.test(source.slice(start + token.length))) tokenClass = 'property';
    else if (/^\s*\(/.test(source.slice(start + token.length))) tokenClass = 'function';
    output += tokenClass ? `<span class="studio-token-${tokenClass}">${escapeHtml(token)}</span>` : escapeHtml(token);
    cursor = start + token.length;
  }
  output += escapeHtml(source.slice(cursor));
  return output || ' ';
}

function studioMonacoLanguage(fileName: string): string {
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  if (['js', 'mjs', 'cjs', 'jsx'].includes(extension)) return 'javascript';
  if (['ts', 'tsx'].includes(extension)) return 'typescript';
  if (['html', 'htm'].includes(extension)) return 'html';
  if (['css', 'scss', 'less'].includes(extension)) return extension;
  if (['json', 'jsonc'].includes(extension)) return 'json';
  if (['md', 'markdown', 'mdx'].includes(extension)) return 'markdown';
  if (['py', 'pyw'].includes(extension)) return 'python';
  if (['glsl', 'vert', 'frag', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp'].includes(extension)) return 'cpp';
  if (['yaml', 'yml'].includes(extension)) return 'yaml';
  if (['sh', 'bash'].includes(extension)) return 'shell';
  if (['xml'].includes(extension)) return 'xml';
  if (['rs'].includes(extension)) return 'rust';
  if (['go'].includes(extension)) return 'go';
  if (['java'].includes(extension)) return 'java';
  if (['cs'].includes(extension)) return 'csharp';
  if (['lua'].includes(extension)) return 'lua';
  if (['php'].includes(extension)) return 'php';
  if (['rb'].includes(extension)) return 'ruby';
  if (['swift'].includes(extension)) return 'swift';
  if (['graphql', 'gql'].includes(extension)) return 'graphql';
  if (['toml'].includes(extension)) return 'ini';
  if (['sql'].includes(extension)) return 'sql';
  if (['wgsl'].includes(extension)) return 'wgsl';
  if (['dockerfile'].includes(extension)) return 'dockerfile';
  if (['ini', 'conf'].includes(extension)) return 'ini';
  return 'plaintext';
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
  let pendingEditorDraftFile: { index: number; file: File } | null = null;
  let previewUrl: string | null = null;
  const activeSandboxPreviewDisposers = new Set<() => void>();
  const closeSandboxPreviews = (): void => {
    for (const dispose of activeSandboxPreviewDisposers) dispose();
  };
  let destroyed = false;
  let interacted = false;
  let restoreFinished = false;
  let pendingImports: File[] = [];
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  let codeHistoryTimer: ReturnType<typeof setTimeout> | null = null;
  let saveRevision = 0;
  let saveChain: Promise<void> = Promise.resolve();
  let zipPreview: ZipExecutorHandle | null = null;
  let flashPreview: FlashPlayerHandle | null = null;
  let audioClips: AudioTimelineClip[] = [];
  let videoClips: StudioVideoClip[] = [];
  let videoFormat: StudioVideoFormat = 'landscape';
  let imageLayers: StudioImageLayer[] = [];
  let openTabs: number[] = [];
  let selectedVideoClipId: string | null = null;
  let selectedAudioClipId: string | null = null;
  let selectedImageLayerId: string | null = null;
  let imageComposerOverlay: HTMLElement | null = null;
  let imageDrawRevision = 0;
  const audioDurations = new Map<number, number>();
  const audioPeaks = new Map<number, Float32Array>();
  const audioPeakTasks = new Map<number, Promise<{ duration: number; peaks: Float32Array }>>();
  const videoDurations = new Map<number, number>();
  const videoFilmstrips = new Map<string, Promise<string>>();
  let audioTrackCount = 1;
  let audioRecorder: MediaRecorder | null = null;
  let audioRecordingStream: MediaStream | null = null;
  let audioRecordingChunks: Blob[] = [];
  let audioRecordingTimer: ReturnType<typeof setInterval> | null = null;
  let audioRecordingStartedAt = 0;
  let audioRecordingTimelineStart = 0;
  let audioRecordingTrack = 0;
  let microphoneRequestPending = false;
  let mixPreviewUrl: string | null = null;
  let mixPreview: HTMLAudioElement | null = null;
  let mixPreviewTimelineOffset = 0;
  let soloPreviewClipId: string | null = null;
  let audioRenderRevision = 0;
  let codeEditorCleanup: (() => void) | null = null;
  let videoSequencePlayer: HTMLVideoElement | null = null;
  let videoSequenceUrl: string | null = null;
  let videoSequenceTransitionPlayer: HTMLVideoElement | null = null;
  let videoSequenceTransitionUrl: string | null = null;
  let videoSequencePipPlayer: HTMLVideoElement | null = null;
  let videoSequencePipUrl: string | null = null;
  let videoSequenceAudio: HTMLAudioElement | null = null;
  let videoSequenceAudioUrl: string | null = null;
  let videoSequenceOverlayCanvas: HTMLElement | null = null;
  let videoSequenceFrameObserver: ResizeObserver | null = null;
  let videoSequenceOverlayRevision = 0;
  const videoSequenceOverlayBitmaps = new Map<number, Promise<ImageBitmap>>();
  let videoSequenceIndex = -1;
  let videoSequenceTimer: ReturnType<typeof setTimeout> | null = null;
  let timelinePixelsPerSecond = 42;
  let videoSequenceStartTime = 0;
  let timelinePlayheadTime = 0;
  let videoPlayheadElement: HTMLElement | null = null;
  let audioPlayheadElements: HTMLElement[] = [];
  const captureEditHistory = (): StudioEditHistorySnapshot => {
    const snapshotFiles = [...files];
    if (codeDirty && pendingEditorDraftFile?.index === activeIndex && snapshotFiles[activeIndex]) {
      snapshotFiles[activeIndex] = pendingEditorDraftFile.file;
    }
    return {
      files: snapshotFiles,
      activeIndex,
      audioClips: audioClips.map((clip) => ({ ...clip })),
      videoClips: videoClips.map((clip) => ({ ...clip })),
      videoFormat,
      imageLayers: imageLayers.map((layer) => ({ ...layer })),
      audioTrackCount,
      selectedAudioClipId,
      selectedVideoClipId,
      selectedImageLayerId,
    };
  };
  let editHistoryBaseline = captureEditHistory();
  const undoHistory: StudioEditHistorySnapshot[] = [];
  const redoHistory: StudioEditHistorySnapshot[] = [];
  let restoringHistory = false;

  const root = document.createElement('main');
  root.className = 'studio-page';
  root.innerHTML = `
    <header class="studio-topbar">
      <a class="studio-brand" href="/home" aria-label="Flaxia home"><span class="studio-brand-mark">f</span> flaxia <i>/</i> studio</a>
      <div class="studio-project-name"><span class="studio-live-dot"></span><span class="studio-project-title">Untitled project</span><span class="studio-save-state">Local workspace</span></div>
      <div class="studio-top-actions"><button class="studio-button studio-open" type="button">＋ Import</button><button class="studio-button studio-new-file" type="button" aria-label="Create a new source file" title="Create a new source file" disabled>＋ New</button><button class="studio-button studio-project-import" type="button">Open project</button><button class="studio-button studio-project-export" type="button" disabled>Save project</button><button class="studio-button studio-export" type="button" disabled>Export</button><button class="studio-button studio-create-post" type="button" disabled>Create post ↗</button></div>
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
        <div class="studio-tabs"><button class="studio-tab studio-workspace-tab active" type="button">⌂ &nbsp;Workspace</button><div class="studio-document-tabs"></div><button class="studio-tab-open" type="button" aria-label="Open files">＋</button><span class="studio-center-spacer"></span><button class="studio-shortcut" type="button" title="Import files">⌘ O</button></div>
        <div class="studio-stage"><div class="studio-empty"><div class="studio-empty-art"><div class="studio-orbit studio-orbit-one"></div><div class="studio-orbit studio-orbit-two"></div><div class="studio-empty-glyph">✳</div><span class="studio-float studio-float-image">▧</span><span class="studio-float studio-float-audio">♫</span><span class="studio-float studio-float-code">&lt;/&gt;</span><span class="studio-float studio-float-game">◇</span></div><h1>Your ideas, in one studio.</h1><p>Bring images, sound, video, code, and games into one creative workspace.</p><button class="studio-button studio-open studio-primary" type="button">Import files</button><small>or drop files anywhere in the workspace</small></div><div class="studio-preview"></div></div>
        <div class="studio-timeline"><div class="studio-timeline-head"><span>⌁ &nbsp;TIMELINE</span><span class="studio-timeline-hint">Drag clips between V1/V2 · V2 is picture-in-picture</span><button class="studio-history-undo" type="button" disabled title="Undo (⌘Z / Ctrl+Z)">↶</button><button class="studio-history-redo" type="button" disabled title="Redo (⌘⇧Z / Ctrl+Y)">↷</button><button class="studio-video-split" type="button" disabled>Split selected clip</button><button class="studio-clip-duplicate" type="button" disabled>Duplicate clip</button><button class="studio-video-play" type="button" disabled>▶ Preview video</button><button class="studio-video-export" type="button" disabled>Export MP4</button><button class="studio-add-track" type="button">＋ Audio track</button><button class="studio-audio-record" type="button" aria-pressed="false" title="Record microphone audio at the playhead">● Record audio</button><button class="studio-audio-solo" type="button" disabled>▶ Solo clip</button><button class="studio-mix-play" type="button">▶ Play mix</button><button class="studio-mix-export" type="button">Mixdown WAV</button><span class="studio-mix-status"></span><button class="studio-timeline-add" type="button" title="Add files">＋</button></div><div class="studio-video-workarea"><div class="studio-video-timeline"></div></div><div class="studio-track"><div class="studio-track-label">MEDIA</div><div class="studio-track-content"><span class="studio-track-empty">Drop an asset here to start creating</span><div class="studio-clip-list"></div></div></div><div class="studio-audio-workarea"><div class="studio-audio-timeline"></div></div></div>
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
  const newFileButton = root.querySelector<HTMLButtonElement>('.studio-new-file')!;
  const projectImportButton = root.querySelector<HTMLButtonElement>('.studio-project-import')!;
  const projectExportButton = root.querySelector<HTMLButtonElement>('.studio-project-export')!;
  const projectInput = root.querySelector<HTMLInputElement>('.studio-project-input')!;
  const createPostButton = root.querySelector<HTMLButtonElement>('.studio-create-post')!;
  const saveState = root.querySelector<HTMLElement>('.studio-save-state')!;
  const projectTitle = root.querySelector<HTMLElement>('.studio-project-title')!;
  const documentTabs = root.querySelector<HTMLElement>('.studio-document-tabs')!;
  const workspaceTab = root.querySelector<HTMLButtonElement>('.studio-workspace-tab')!;
  const audioTimeline = root.querySelector<HTMLElement>('.studio-audio-timeline')!;
  const videoTimeline = root.querySelector<HTMLElement>('.studio-video-timeline')!;
  const inspectorBody = root.querySelector<HTMLElement>('.studio-inspector-body')!;
  const defaultInspector = inspectorBody.innerHTML;
  const mixStatus = root.querySelector<HTMLElement>('.studio-mix-status')!;
  const mixPlayButton = root.querySelector<HTMLButtonElement>('.studio-mix-play')!;
  const mixExportButton = root.querySelector<HTMLButtonElement>('.studio-mix-export')!;
  const soloAudioButton = root.querySelector<HTMLButtonElement>('.studio-audio-solo')!;
  const addTrackButton = root.querySelector<HTMLButtonElement>('.studio-add-track')!;
  const audioRecordButton = root.querySelector<HTMLButtonElement>('.studio-audio-record')!;
  const videoPlayButton = root.querySelector<HTMLButtonElement>('.studio-video-play')!;
  const videoSplitButton = root.querySelector<HTMLButtonElement>('.studio-video-split')!;
  const duplicateClipButton = root.querySelector<HTMLButtonElement>('.studio-clip-duplicate')!;
  const videoExportButton = root.querySelector<HTMLButtonElement>('.studio-video-export')!;
  const undoButton = root.querySelector<HTMLButtonElement>('.studio-history-undo')!;
  const redoButton = root.querySelector<HTMLButtonElement>('.studio-history-redo')!;
  duplicateClipButton.title = 'Duplicate selected clip (⌘D / Ctrl+D)';
  videoSplitButton.title = 'Split selected clip at the playhead';
  videoPlayButton.title = 'Start or stop video preview (Space)';
  mixPlayButton.title = 'Play or pause audio mix (Space)';
  soloAudioButton.title = 'Audition the selected audio clip';
  const clearMixPreview = (): void => {
    audioRenderRevision++;
    mixPreview?.pause();
    mixPreview = null;
    if (mixPreviewUrl) URL.revokeObjectURL(mixPreviewUrl);
    mixPreviewUrl = null;
    mixPreviewTimelineOffset = 0;
    soloPreviewClipId = null;
    mixPlayButton.textContent = '▶ Play mix';
    soloAudioButton.textContent = '▶ Solo clip';
  };
  const zoomLabel = document.createElement('label');
  zoomLabel.className = 'studio-timeline-zoom-control';
  zoomLabel.innerHTML =
    'Zoom <input class="studio-timeline-zoom" type="range" min="18" max="120" step="1" value="42" aria-label="Timeline zoom"><output>42 px/s</output>';
  videoExportButton.parentNode?.insertBefore(zoomLabel, videoExportButton.nextSibling);
  const zoomInput = zoomLabel.querySelector<HTMLInputElement>('input')!;
  const zoomOutput = zoomLabel.querySelector<HTMLOutputElement>('output')!;
  const videoFormatLabel = document.createElement('label');
  videoFormatLabel.className = 'studio-video-format-control';
  videoFormatLabel.innerHTML =
    'Canvas <select class="studio-video-format" aria-label="Video canvas format"><option value="landscape">16:9</option><option value="square">1:1</option><option value="portrait">9:16</option></select>';
  videoExportButton.parentNode?.insertBefore(videoFormatLabel, addTrackButton);
  const videoFormatInput = videoFormatLabel.querySelector('select') as HTMLSelectElement;
  videoFormatInput.value = videoFormat;
  videoFormatInput.addEventListener('change', () => {
    videoFormat = videoFormatInput.value as StudioVideoFormat;
    videoSequenceStartTime = timelinePlayheadTime;
    if (videoSequencePlayer) stopVideoSequence();
    scheduleAutosave();
  });
  const videoTimelineViewport = root.querySelector<HTMLElement>('.studio-video-workarea')!;
  const audioTimelineViewport = root.querySelector<HTMLElement>('.studio-audio-workarea')!;
  let syncedViewport: HTMLElement | null = null;
  let syncedViewportScrollLeft = 0;
  const syncTimelineScroll = (source: HTMLElement, target: HTMLElement): void => {
    if (syncedViewport === source && Math.abs(source.scrollLeft - syncedViewportScrollLeft) < 1) {
      syncedViewport = null;
      return;
    }
    syncedViewport = null;
    if (Math.abs(source.scrollLeft - target.scrollLeft) < 1) return;
    target.scrollLeft = source.scrollLeft;
    syncedViewport = target;
    syncedViewportScrollLeft = target.scrollLeft;
  };
  videoTimelineViewport.addEventListener('scroll', () =>
    syncTimelineScroll(videoTimelineViewport, audioTimelineViewport),
  );
  audioTimelineViewport.addEventListener('scroll', () =>
    syncTimelineScroll(audioTimelineViewport, videoTimelineViewport),
  );
  workspaceTab.addEventListener('click', () => select(-1));
  const renderDocumentTabs = (): void => {
    workspaceTab.classList.toggle('active', activeIndex < 0);
    documentTabs.replaceChildren();
    for (const index of openTabs) {
      const file = files[index];
      if (!file) continue;
      const tab = document.createElement('div');
      tab.className = `studio-document-tab-wrap ${index === activeIndex ? 'active' : ''}`;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'studio-document-tab';
      open.title = file.name;
      open.textContent = `${codeDirty && index === activeIndex ? '● ' : ''}${file.name}`;
      open.addEventListener('click', () => select(index));
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'studio-document-tab-close';
      close.textContent = '×';
      close.setAttribute('aria-label', `Close ${file.name}`);
      close.addEventListener('click', () => {
        openTabs = openTabs.filter((tabIndex) => tabIndex !== index);
        if (activeIndex === index) select(openTabs.at(-1) ?? -1);
        else renderDocumentTabs();
      });
      tab.appendChild(open);
      tab.appendChild(close);
      documentTabs.appendChild(tab);
    }
  };
  const stopVideoSequence = (): void => {
    if (videoSequenceTimer) clearTimeout(videoSequenceTimer);
    videoSequenceTimer = null;
    videoSequenceOverlayRevision++;
    videoSequenceFrameObserver?.disconnect();
    videoSequenceFrameObserver = null;
    videoSequenceOverlayCanvas?.remove();
    videoSequenceOverlayCanvas = null;
    for (const bitmapPromise of videoSequenceOverlayBitmaps.values()) {
      void bitmapPromise.then((bitmap) => bitmap.close()).catch(() => undefined);
    }
    videoSequenceOverlayBitmaps.clear();
    videoSequencePlayer?.pause();
    videoSequencePlayer?.remove();
    videoSequencePlayer = null;
    videoSequenceTransitionPlayer?.pause();
    videoSequenceTransitionPlayer?.remove();
    videoSequenceTransitionPlayer = null;
    videoSequencePipPlayer?.pause();
    videoSequencePipPlayer?.remove();
    videoSequencePipPlayer = null;
    videoSequenceAudio?.pause();
    videoSequenceAudio = null;
    if (videoSequenceAudioUrl) URL.revokeObjectURL(videoSequenceAudioUrl);
    videoSequenceAudioUrl = null;
    if (videoSequenceUrl) URL.revokeObjectURL(videoSequenceUrl);
    videoSequenceUrl = null;
    if (videoSequenceTransitionUrl) URL.revokeObjectURL(videoSequenceTransitionUrl);
    videoSequenceTransitionUrl = null;
    if (videoSequencePipUrl) URL.revokeObjectURL(videoSequencePipUrl);
    videoSequencePipUrl = null;
    videoSequenceIndex = -1;
    videoPlayButton.textContent = '▶ Preview video';
  };

  const updateSplitButton = (): void => {
    const videoClip = videoClips.find((item) => item.id === selectedVideoClipId);
    const audioClip = audioClips.find((item) => item.id === selectedAudioClipId);
    const imageLayer = imageLayers.find((item) => item.id === selectedImageLayerId);
    const clipStart = videoClip?.start ?? audioClip?.start;
    const clipDuration = videoClip
      ? videoClipTimelineDuration(videoClip)
      : audioClip
        ? audioClipTimelineDuration(audioClip)
        : 0;
    videoSplitButton.disabled =
      clipStart === undefined ||
      timelinePlayheadTime <= clipStart + 0.05 ||
      timelinePlayheadTime >= clipStart + clipDuration - 0.05;
    duplicateClipButton.disabled = !videoClip && !audioClip && !imageLayer;
  };

  const updateTimelinePlayhead = (time: number): void => {
    timelinePlayheadTime = Math.max(0, time);
    const left = `${timelinePlayheadTime * timelinePixelsPerSecond}px`;
    if (videoPlayheadElement) videoPlayheadElement.style.left = left;
    audioPlayheadElements.forEach((element) => {
      element.style.left = left;
    });
    updateSplitButton();
  };

  const requestVideoSeek = (time: number): void => {
    if (!videoClips.some((clip) => clip.track !== 'overlay')) {
      updateTimelinePlayhead(time);
      if (mixPreview) {
        const wasPlaying = !mixPreview.paused;
        const seekMix = (): void => {
          if (!mixPreview) return;
          mixPreview.currentTime = Math.max(
            0,
            Math.min(
              time - mixPreviewTimelineOffset,
              Number.isFinite(mixPreview.duration) ? mixPreview.duration : time,
            ),
          );
          if (wasPlaying) void mixPreview.play().catch(() => undefined);
        };
        if (mixPreview.readyState >= 1) seekMix();
        else mixPreview.addEventListener('loadedmetadata', seekMix, { once: true });
      }
      return;
    }
    mixPreview?.pause();
    if (mixPreview) mixPlayButton.textContent = soloPreviewClipId ? '▶ Play mix' : '▶ Resume mix';
    if (videoSequencePlayer) stopVideoSequence();
    const sequenceEnd = Math.max(0, ...videoClips.map((clip) => clip.start + videoClipTimelineDuration(clip)));
    videoSequenceStartTime = Math.max(0, Math.min(time, sequenceEnd));
    videoPlayButton.click();
  };

  videoSplitButton.addEventListener('click', () => {
    const clipIndex = videoClips.findIndex((item) => item.id === selectedVideoClipId);
    if (clipIndex >= 0) {
      const clip = videoClips[clipIndex];
      const offset = timelinePlayheadTime - clip.start;
      const duration = videoClipTimelineDuration(clip);
      if (offset <= 0.05 || offset >= duration - 0.05) return;
      const rightClip: StudioVideoClip = {
        ...clip,
        id: crypto.randomUUID(),
        start: timelinePlayheadTime,
        sourceStart: clip.sourceStart + offset * videoClipSpeed(clip),
      };
      clip.sourceEnd = rightClip.sourceStart;
      clip.transitionOut = 0;
      videoClips.splice(clipIndex + 1, 0, rightClip);
      manuallyPlacedVideoClips.add(rightClip.id);
      selectedVideoClipId = rightClip.id;
      selectedAudioClipId = null;
      stopVideoSequence();
      renderVideoTimeline();
    } else {
      const clipIndex = audioClips.findIndex((item) => item.id === selectedAudioClipId);
      const clip = audioClips[clipIndex];
      if (!clip) return;
      const offset = timelinePlayheadTime - clip.start;
      const duration = audioClipTimelineDuration(clip);
      if (offset <= 0.05 || offset >= duration - 0.05) return;
      const originalFadeOut = clip.fadeOut;
      const splitEnvelope = splitAudioClipGainEnvelope(clip, offset / duration);
      const rightClip: AudioTimelineClip = {
        ...clip,
        id: crypto.randomUUID(),
        start: timelinePlayheadTime,
        sourceStart: clip.sourceStart + offset * audioClipSpeed(clip),
        fadeIn: 0,
        fadeOut: originalFadeOut,
        gainEnvelope: splitEnvelope.right,
      };
      clip.sourceEnd = rightClip.sourceStart;
      clip.fadeOut = 0;
      clip.gainEnvelope = splitEnvelope.left;
      audioClips.splice(clipIndex + 1, 0, rightClip);
      selectedAudioClipId = rightClip.id;
      selectedVideoClipId = null;
      renderAudioTimeline();
    }
    renderInspector();
    scheduleAutosave();
  });

  duplicateClipButton.addEventListener('click', () => {
    const imageLayer = imageLayers.find((item) => item.id === selectedImageLayerId);
    if (imageLayer) {
      const duplicate: StudioImageLayer = {
        ...imageLayer,
        id: crypto.randomUUID(),
        x: Math.min(1080 - imageLayer.width, imageLayer.x + 24),
        y: Math.min(1080 - imageLayer.height, imageLayer.y + 24),
      };
      const index = imageLayers.indexOf(imageLayer);
      imageLayers.splice(index + 1, 0, duplicate);
      selectedImageLayerId = duplicate.id;
      selectedVideoClipId = null;
      selectedAudioClipId = null;
      renderVideoTimeline();
      scheduleAutosave();
      void openImageComposer(duplicate.fileIndex);
      return;
    }
    const videoClip = videoClips.find((item) => item.id === selectedVideoClipId);
    if (videoClip) {
      const duplicate: StudioVideoClip = {
        ...videoClip,
        id: crypto.randomUUID(),
        start: Math.max(
          0,
          ...videoClips
            .filter((item) => (item.track === 'overlay') === (videoClip.track === 'overlay'))
            .map((item) => item.start + videoClipTimelineDuration(item)),
        ),
      };
      videoClips.push(duplicate);
      manuallyPlacedVideoClips.add(duplicate.id);
      selectedVideoClipId = duplicate.id;
      selectedAudioClipId = null;
      renderVideoTimeline();
      videoTimelineViewport.scrollLeft = Math.max(
        0,
        duplicate.start * timelinePixelsPerSecond - videoTimelineViewport.clientWidth + 160,
      );
      audioTimelineViewport.scrollLeft = videoTimelineViewport.scrollLeft;
    } else {
      const audioClip = audioClips.find((item) => item.id === selectedAudioClipId);
      if (!audioClip) return;
      const duplicate: AudioTimelineClip = {
        ...audioClip,
        id: crypto.randomUUID(),
        start: Math.max(
          0,
          ...audioClips
            .filter((item) => item.track === audioClip.track)
            .map((item) => item.start + audioClipTimelineDuration(item)),
        ),
      };
      audioClips.push(duplicate);
      selectedAudioClipId = duplicate.id;
      selectedVideoClipId = null;
      renderAudioTimeline();
      audioTimelineViewport.scrollLeft = Math.max(
        0,
        duplicate.start * timelinePixelsPerSecond - audioTimelineViewport.clientWidth + 160,
      );
      videoTimelineViewport.scrollLeft = audioTimelineViewport.scrollLeft;
    }
    renderInspector();
    scheduleAutosave();
  });

  const manuallyPlacedVideoClips = new Set<string>();

  const renderAudioWaveform = (container: HTMLElement, peaks: Float32Array): void => {
    const bucketCount = 72;
    container.dataset.state = 'ready';
    container.setAttribute('aria-label', 'Decoded audio waveform');
    container.innerHTML = Array.from({ length: bucketCount }, (_, index) => {
      const peak = peaks[Math.min(peaks.length - 1, Math.floor((index * peaks.length) / bucketCount))] ?? 0;
      return `<i style="height:${Math.max(2, Math.min(100, Math.round(peak * 100)))}%"></i>`;
    }).join('');
  };

  const ensureAudioClip = (
    fileIndex: number,
    useFullDuration = false,
    placement?: { track: number; start: number },
  ): void => {
    const file = files[fileIndex];
    if (!file || kindOf(file) !== 'audio') return;
    let clip = audioClips.find((item) => item.fileIndex === fileIndex);
    const expandToSource = useFullDuration || !clip;
    if (!clip) {
      const track = placement ? Math.max(0, Math.min(7, Math.floor(placement.track))) : Math.min(audioClips.length, 7);
      clip = {
        id: crypto.randomUUID(),
        fileIndex,
        track,
        start: placement && Number.isFinite(placement.start) ? Math.max(0, placement.start) : 0,
        sourceStart: 0,
        sourceEnd: 1,
        speed: 1,
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        pan: 0,
        lowEqDb: 0,
        midEqDb: 0,
        highEqDb: 0,
        gainEnvelope: { start: 1, middle: 1, end: 1 },
        trackMuted: false,
        trackSolo: false,
        trackGain: 1,
        trackPan: 0,
        muted: false,
      };
      audioClips.push(clip);
      audioTrackCount = Math.max(audioTrackCount, track + 1);
    }
    if (audioDurations.has(fileIndex)) return;
    const peaksTask = computeAudioPeaks(file);
    audioPeakTasks.set(fileIndex, peaksTask);
    void peaksTask
      .then(({ duration, peaks }) => {
        if (destroyed) return;
        audioDurations.set(fileIndex, duration);
        audioPeaks.set(fileIndex, peaks);
        const waveform = preview.querySelector<HTMLElement>('.studio-waveform');
        if (activeIndex === fileIndex && waveform) renderAudioWaveform(waveform, peaks);
        const audioClip = audioClips.find((item) => item.fileIndex === fileIndex);
        if (audioClip && expandToSource) audioClip.sourceEnd = duration;
        renderAudioTimeline();
        renderInspector();
        scheduleAutosave(false);
      })
      .catch(() => {
        if (destroyed) return;
        audioDurations.set(fileIndex, 1);
        renderAudioTimeline();
      })
      .finally(() => {
        if (audioPeakTasks.get(fileIndex) === peaksTask) audioPeakTasks.delete(fileIndex);
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
        start: videoClips
          .filter((item) => item.track !== 'overlay')
          .reduce((end, item) => Math.max(end, item.start + videoClipTimelineDuration(item)), 0),
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
          const trackClips = videoClips.filter(
            (item) =>
              (item.track === 'overlay' ? 'overlay' : 'main') === (videoClip.track === 'overlay' ? 'overlay' : 'main'),
          );
          const clipIndex = trackClips.indexOf(videoClip);
          for (let index = clipIndex + 1; index < trackClips.length; index++) {
            const previous = trackClips[index - 1];
            const following = trackClips[index];
            if (!manuallyPlacedVideoClips.has(following.id)) {
              following.start = previous.start + videoClipTimelineDuration(previous);
            }
          }
        }
        rippleOverlappingVideoClips(videoClips);
        renderVideoTimeline();
        renderInspector();
        scheduleAutosave(false);
      })
      .catch(() => {
        if (!destroyed) videoDurations.set(fileIndex, 1);
      });
  };

  const clearUrl = (): void => {
    closeSandboxPreviews();
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

  const updateHistoryControls = (): void => {
    undoButton.disabled = undoHistory.length === 0;
    redoButton.disabled = redoHistory.length === 0;
  };

  const updatePendingEditorDraftFile = (): void => {
    const currentFile = files[activeIndex];
    if (!currentFile) return;
    pendingEditorDraftFile = {
      index: activeIndex,
      file: new File([editorText], currentFile.name, {
        type: currentFile.type || (kindOf(currentFile) === 'game' ? 'text/html' : 'text/plain'),
        lastModified: currentFile.lastModified,
      }),
    };
  };

  const commitActiveEditorDraft = (): void => {
    if (!codeDirty) return;
    const currentFile = files[activeIndex];
    if (!currentFile) return;
    const draft = pendingEditorDraftFile?.index === activeIndex ? pendingEditorDraftFile.file : null;
    files[activeIndex] =
      draft ??
      new File([editorText], currentFile.name, {
        type: currentFile.type || (kindOf(currentFile) === 'game' ? 'text/html' : 'text/plain'),
        lastModified: currentFile.lastModified,
      });
    pendingEditorDraftFile = null;
    codeDirty = false;
  };

  const recordHistoryChange = (): void => {
    if (codeHistoryTimer) clearTimeout(codeHistoryTimer);
    codeHistoryTimer = null;
    if (restoringHistory || !restoreFinished) return;
    const next = captureEditHistory();
    if (sameStudioFileHistoryState(next, editHistoryBaseline)) return;
    undoHistory.push(editHistoryBaseline);
    if (undoHistory.length > 100) undoHistory.shift();
    editHistoryBaseline = next;
    redoHistory.length = 0;
    updateHistoryControls();
  };

  const scheduleCodeHistoryCheckpoint = (): void => {
    if (codeHistoryTimer) clearTimeout(codeHistoryTimer);
    codeHistoryTimer = setTimeout(() => {
      codeHistoryTimer = null;
      recordHistoryChange();
    }, 500);
  };

  const scheduleAutosave = (recordHistory = true): void => {
    if (recordHistory) recordHistoryChange();
    audioRenderRevision++;
    if (videoSequencePlayer) stopVideoSequence();
    if (mixPreview || mixPreviewUrl) clearMixPreview();
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
        projectFiles[activeIndex] =
          pendingEditorDraftFile?.index === activeIndex
            ? pendingEditorDraftFile.file
            : new File([editorText], currentFile.name, {
                type: currentFile.type || (kindOf(currentFile) === 'game' ? 'text/html' : 'text/plain'),
                lastModified: currentFile.lastModified,
              });
      }
      const projectVideoFormat = videoFormat;
      saveChain = saveChain
        .catch(() => undefined)
        .then(async () => {
          if (revision !== saveRevision) return;
          try {
            await saveStudioProject(projectFiles, audioClips, videoClips, imageLayers, vaultKey, projectVideoFormat);
            if (!destroyed && revision === saveRevision) saveState.textContent = 'Saved on this device';
          } catch (error) {
            if (!destroyed && revision === saveRevision) {
              saveState.textContent = error instanceof Error ? error.message : 'Could not save encrypted project';
            }
          }
        });
    }, 700);
  };

  const snapTimelineTime = (time: number, ignoredId?: string): number => {
    const anchors = [0, timelinePlayheadTime];
    for (const clip of videoClips) {
      if (clip.id === ignoredId) continue;
      anchors.push(clip.start, clip.start + videoClipTimelineDuration(clip));
    }
    for (const clip of audioClips) {
      if (clip.id === ignoredId) continue;
      anchors.push(clip.start, clip.start + audioClipTimelineDuration(clip));
    }
    for (const layer of imageLayers) {
      if (layer.id === ignoredId) continue;
      anchors.push(layer.start ?? 0);
      if (layer.end !== undefined) anchors.push(layer.end);
    }
    const nearest = anchors.reduce(
      (best, anchor) => (Math.abs(anchor - time) < Math.abs(best - time) ? anchor : best),
      Number.POSITIVE_INFINITY,
    );
    if (Math.abs(nearest - time) <= 8 / timelinePixelsPerSecond) return nearest;
    return Math.max(0, Math.round(time * 10) / 10);
  };

  const videoClipCssFilter = (clip: StudioVideoClip): string =>
    `brightness(${clip.brightness ?? 100}%) contrast(${clip.contrast ?? 100}%) saturate(${clip.saturation ?? 100}%) hue-rotate(${clip.hueDeg ?? 0}deg) blur(${clip.blurPx ?? 0}px)`;

  const createVideoFilmstrip = async (file: File, sourceStart: number, sourceEnd: number): Promise<string> => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    try {
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadeddata', () => resolve(), { once: true });
        video.addEventListener('error', () => reject(new Error('Could not decode video thumbnail')), { once: true });
      });
      const canvas = document.createElement('canvas');
      const frameWidth = 80;
      const frameHeight = 45;
      canvas.width = frameWidth * 3;
      canvas.height = frameHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not draw video thumbnails');
      const duration = Math.max(0, sourceEnd - sourceStart);
      const times = [sourceStart, sourceStart + duration / 2, Math.max(sourceStart, sourceEnd - 0.05)];
      for (const [index, time] of times.entries()) {
        const target = Math.max(0, Math.min(time, Math.max(0, video.duration - 0.01)));
        if (Math.abs(video.currentTime - target) > 0.01) {
          await new Promise<void>((resolve, reject) => {
            video.addEventListener('seeked', () => resolve(), { once: true });
            video.addEventListener('error', () => reject(new Error('Could not seek video thumbnail')), { once: true });
            video.currentTime = target;
          });
        }
        context.drawImage(video, index * frameWidth, 0, frameWidth, frameHeight);
      }
      return canvas.toDataURL('image/jpeg', 0.68);
    } finally {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    }
  };

  const renderVideoTimeline = (): void => {
    videoTimeline.innerHTML = '';
    videoPlayheadElement = null;
    const sequenceEnd = Math.max(0, ...videoClips.map((clip) => clip.start + videoClipTimelineDuration(clip)));
    const end = Math.max(
      30,
      sequenceEnd + 5,
      ...videoClips.map((clip) => clip.start + videoClipTimelineDuration(clip) + 5),
      ...imageLayers.map((layer) => Math.max(layer.start ?? 0, layer.end ?? 0) + 5),
    );
    const contentWidth = Math.max(1200, end * timelinePixelsPerSecond);
    const ruler = document.createElement('div');
    ruler.className = 'studio-video-ruler';
    ruler.style.width = `${contentWidth}px`;
    ruler.style.backgroundSize = `${timelinePixelsPerSecond * 5}px 100%`;
    for (let second = 0; second <= end; second += 5) {
      const tick = document.createElement('span');
      tick.style.left = `${second * timelinePixelsPerSecond}px`;
      tick.textContent = `${Math.floor(second / 60)}:${String(second % 60).padStart(2, '0')}`;
      ruler.appendChild(tick);
    }
    ruler.addEventListener('click', (event) => {
      const rect = ruler.getBoundingClientRect();
      requestVideoSeek(Math.max(0, (event.clientX - rect.left) / timelinePixelsPerSecond));
    });
    videoTimeline.appendChild(ruler);
    const lane = document.createElement('div');
    lane.className = 'studio-video-lane';
    const label = document.createElement('div');
    label.className = 'studio-video-track-label';
    label.textContent = 'V1';
    const canvas = document.createElement('div');
    canvas.className = 'studio-video-lane-canvas';
    canvas.style.width = `${contentWidth}px`;
    canvas.style.backgroundSize = `${timelinePixelsPerSecond}px 100%`;
    const mainVideoClips = videoClips
      .filter((clip) => clip.track !== 'overlay')
      .sort((left, right) => left.start - right.start);
    for (const clip of mainVideoClips) {
      const file = files[clip.fileIndex];
      if (!file) continue;
      const block = document.createElement('button');
      block.type = 'button';
      block.draggable = true;
      block.className = `studio-video-clip ${clip.id === selectedVideoClipId ? 'active' : ''} ${clip.muted ? 'muted' : ''}`;
      block.dataset.clipId = clip.id;
      block.style.left = `${clip.start * timelinePixelsPerSecond}px`;
      block.style.width = `${Math.max(54, videoClipTimelineDuration(clip) * timelinePixelsPerSecond)}px`;
      const duration = videoDurations.get(clip.fileIndex);
      const leftHandle = document.createElement('span');
      leftHandle.className = 'studio-video-trim studio-video-trim-left';
      leftHandle.setAttribute('aria-label', 'Trim start');
      const labelText = document.createElement('span');
      labelText.className = 'studio-video-clip-label';
      labelText.textContent = `${file.name} · ${duration ? `${videoClipTimelineDuration(clip).toFixed(1)}s${videoClipSpeed(clip) === 1 ? '' : ` · ${videoClipSpeed(clip)}×`}` : '…'}`;
      const rightHandle = document.createElement('span');
      rightHandle.className = 'studio-video-trim studio-video-trim-right';
      rightHandle.setAttribute('aria-label', 'Trim end');
      const clipIndex = mainVideoClips.findIndex((item) => item.id === clip.id);
      const nextClip = mainVideoClips[clipIndex + 1];
      const transitionDuration = nextClip
        ? Math.max(
            0,
            Math.min(
              videoClipTransitionDuration(clip, nextClip),
              clip.start + videoClipTimelineDuration(clip) - nextClip.start,
            ),
          )
        : 0;
      if (transitionDuration > 0) {
        const transitionMark = document.createElement('span');
        transitionMark.className = 'studio-video-transition-mark';
        transitionMark.style.width = `${transitionDuration * timelinePixelsPerSecond}px`;
        transitionMark.title = `${transitionDuration.toFixed(1)}s ${clip.transitionType ?? 'fade'}`;
        block.appendChild(transitionMark);
      }
      block.appendChild(leftHandle);
      block.appendChild(labelText);
      block.appendChild(rightHandle);
      block.title = file.name;
      block.addEventListener('click', () => {
        select(clip.fileIndex);
        selectedVideoClipId = clip.id;
        selectedAudioClipId = null;
        selectedImageLayerId = null;
        renderVideoTimeline();
        renderInspector();
      });
      const attachVideoTrim = (handle: HTMLElement, edge: 'start' | 'end'): void => {
        handle.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const pointerStart = event.clientX;
          const zoomAtDrag = timelinePixelsPerSecond;
          const initialStart = clip.start;
          const initialSourceStart = clip.sourceStart;
          const initialSourceEnd = clip.sourceEnd;
          const speed = videoClipSpeed(clip);
          const sourceDuration = videoDurations.get(clip.fileIndex) ?? clip.sourceEnd;
          handle.setPointerCapture(event.pointerId);
          const updateClip = (moveEvent: PointerEvent): void => {
            const delta = (moveEvent.clientX - pointerStart) / zoomAtDrag;
            if (edge === 'start') {
              const minDelta = -Math.min(initialSourceStart / speed, initialStart);
              const maxDelta = (initialSourceEnd - initialSourceStart - 0.1) / speed;
              const snappedStart = snapTimelineTime(initialStart + delta, clip.id);
              const appliedTimeline = Math.max(minDelta, Math.min(maxDelta, snappedStart - initialStart));
              clip.sourceStart = initialSourceStart + appliedTimeline * speed;
              clip.start = initialStart + appliedTimeline;
            } else {
              const initialTimelineEnd = initialStart + (initialSourceEnd - initialSourceStart) / speed;
              const snappedEnd = snapTimelineTime(initialTimelineEnd + delta, clip.id);
              const appliedTimeline = snappedEnd - initialTimelineEnd;
              clip.sourceEnd = Math.max(
                initialSourceStart + 0.1,
                Math.min(sourceDuration, initialSourceEnd + appliedTimeline * speed),
              );
            }
            block.style.left = `${clip.start * timelinePixelsPerSecond}px`;
            block.style.width = `${Math.max(54, videoClipTimelineDuration(clip) * timelinePixelsPerSecond)}px`;
            labelText.textContent = `${file.name} · ${videoClipTimelineDuration(clip).toFixed(1)}s${videoClipSpeed(clip) === 1 ? '' : ` · ${videoClipSpeed(clip)}×`}`;
            const startField = inspectorBody.querySelector<HTMLInputElement>('.studio-video-in');
            const endField = inspectorBody.querySelector<HTMLInputElement>('.studio-video-out');
            const positionField = inspectorBody.querySelector<HTMLInputElement>('.studio-video-position');
            if (startField) startField.value = clip.sourceStart.toFixed(1);
            if (endField) endField.value = clip.sourceEnd.toFixed(1);
            if (positionField) positionField.value = clip.start.toFixed(1);
          };
          const finish = (): void => {
            handle.removeEventListener('pointermove', updateClip);
            manuallyPlacedVideoClips.add(clip.id);
            rippleOverlappingVideoClips(videoClips);
            select(clip.fileIndex);
            selectedVideoClipId = clip.id;
            selectedAudioClipId = null;
            selectedImageLayerId = null;
            renderVideoTimeline();
            renderInspector();
            scheduleAutosave();
          };
          handle.addEventListener('pointermove', updateClip);
          handle.addEventListener('pointerup', finish, { once: true });
          handle.addEventListener('pointercancel', finish, { once: true });
        });
      };
      attachVideoTrim(leftHandle, 'start');
      attachVideoTrim(rightHandle, 'end');
      block.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('application/x-flaxia-video-clip', clip.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      canvas.appendChild(block);
      const filmstripKey = `${clip.fileIndex}:${clip.sourceStart.toFixed(3)}:${clip.sourceEnd.toFixed(3)}`;
      let filmstrip = videoFilmstrips.get(filmstripKey);
      if (!filmstrip) {
        filmstrip = createVideoFilmstrip(file, clip.sourceStart, clip.sourceEnd);
        videoFilmstrips.set(filmstripKey, filmstrip);
        void filmstrip.catch(() => videoFilmstrips.delete(filmstripKey));
        if (videoFilmstrips.size > 48) {
          const oldestKey = videoFilmstrips.keys().next().value;
          if (oldestKey) videoFilmstrips.delete(oldestKey);
        }
      }
      void filmstrip
        .then((image) => {
          if (!block.isConnected || destroyed) return;
          block.style.backgroundImage = `linear-gradient(#0006,#0006),url("${image}")`;
          block.style.backgroundRepeat = 'no-repeat,repeat-x';
          block.style.backgroundPosition = '0 0,0 0';
          block.style.backgroundSize = 'auto,240px 35px';
        })
        .catch(() => undefined);
    }
    videoPlayheadElement = document.createElement('div');
    videoPlayheadElement.className = 'studio-timeline-playhead';
    videoPlayheadElement.setAttribute('aria-hidden', 'true');
    canvas.appendChild(videoPlayheadElement);
    lane.appendChild(label);
    lane.appendChild(canvas);
    lane.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes('application/x-flaxia-video-clip')) event.preventDefault();
    });
    lane.addEventListener('drop', (event) => {
      const clipId = event.dataTransfer?.getData('application/x-flaxia-video-clip');
      const clip = videoClips.find((item) => item.id === clipId);
      if (!clip) return;
      if (clip.track !== 'overlay' && videoClips.filter((item) => item.track !== 'overlay').length <= 1) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      clip.track = 'main';
      clip.start = snapTimelineTime((event.clientX - rect.left) / timelinePixelsPerSecond, clip.id);
      rippleOverlappingVideoClips(videoClips);
      manuallyPlacedVideoClips.add(clip.id);
      select(clip.fileIndex);
      selectedVideoClipId = clip.id;
      selectedAudioClipId = null;
      selectedImageLayerId = null;
      renderVideoTimeline();
      renderInspector();
      scheduleAutosave();
    });
    videoTimeline.appendChild(lane);
    const pictureLane = document.createElement('div');
    pictureLane.className = 'studio-video-lane studio-picture-track-lane';
    const pictureLabel = document.createElement('div');
    pictureLabel.className = 'studio-video-track-label';
    pictureLabel.textContent = 'V2';
    pictureLabel.title = 'Picture-in-picture overlay track';
    const pictureCanvas = document.createElement('div');
    pictureCanvas.className = 'studio-video-lane-canvas';
    pictureCanvas.style.width = `${contentWidth}px`;
    pictureCanvas.style.backgroundSize = `${timelinePixelsPerSecond}px 100%`;
    for (const clip of videoClips
      .filter((item) => item.track === 'overlay')
      .sort((left, right) => left.start - right.start)) {
      const file = files[clip.fileIndex];
      if (!file) continue;
      const block = document.createElement('button');
      block.type = 'button';
      block.draggable = true;
      block.className = `studio-video-clip studio-picture-clip ${clip.id === selectedVideoClipId ? 'active' : ''} ${clip.muted ? 'muted' : ''}`;
      block.dataset.clipId = clip.id;
      block.style.left = `${clip.start * timelinePixelsPerSecond}px`;
      block.style.width = `${Math.max(54, videoClipTimelineDuration(clip) * timelinePixelsPerSecond)}px`;
      block.textContent = `${file.name} · ${videoClipTimelineDuration(clip).toFixed(1)}s`;
      block.title = `${file.name} · picture-in-picture`;
      block.addEventListener('click', () => {
        select(clip.fileIndex);
        selectedVideoClipId = clip.id;
        selectedAudioClipId = null;
        selectedImageLayerId = null;
        renderVideoTimeline();
        renderInspector();
      });
      block.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('application/x-flaxia-video-clip', clip.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      pictureCanvas.appendChild(block);
      const filmstripKey = `${clip.fileIndex}:${clip.sourceStart.toFixed(3)}:${clip.sourceEnd.toFixed(3)}`;
      let filmstrip = videoFilmstrips.get(filmstripKey);
      if (!filmstrip) {
        filmstrip = createVideoFilmstrip(file, clip.sourceStart, clip.sourceEnd);
        videoFilmstrips.set(filmstripKey, filmstrip);
        void filmstrip.catch(() => videoFilmstrips.delete(filmstripKey));
      }
      void filmstrip
        .then((image) => {
          if (block.isConnected && !destroyed) {
            block.style.backgroundImage = `linear-gradient(#0006,#0006),url("${image}")`;
            block.style.backgroundRepeat = 'no-repeat,repeat-x';
            block.style.backgroundSize = 'auto,240px 35px';
          }
        })
        .catch(() => undefined);
    }
    pictureLane.appendChild(pictureLabel);
    pictureLane.appendChild(pictureCanvas);
    pictureLane.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes('application/x-flaxia-video-clip')) event.preventDefault();
    });
    pictureLane.addEventListener('drop', (event) => {
      const clipId = event.dataTransfer?.getData('application/x-flaxia-video-clip');
      const clip = videoClips.find((item) => item.id === clipId);
      if (!clip) return;
      if (clip.track !== 'overlay' && videoClips.filter((item) => item.track !== 'overlay').length <= 1) return;
      event.preventDefault();
      const rect = pictureCanvas.getBoundingClientRect();
      clip.track = 'overlay';
      clip.transitionOut = 0;
      clip.start = snapTimelineTime((event.clientX - rect.left) / timelinePixelsPerSecond, clip.id);
      rippleOverlappingVideoClips(videoClips);
      manuallyPlacedVideoClips.add(clip.id);
      select(clip.fileIndex);
      selectedVideoClipId = clip.id;
      selectedAudioClipId = null;
      selectedImageLayerId = null;
      stopVideoSequence();
      renderVideoTimeline();
      renderInspector();
      scheduleAutosave();
    });
    videoTimeline.appendChild(pictureLane);
    const openLayerEnd = sequenceEnd > 0 ? sequenceEnd : Math.max(30, ...imageLayers.map((layer) => layer.start ?? 0));
    imageLayers.forEach((layer, index) => {
      const overlayLane = document.createElement('div');
      overlayLane.className = 'studio-video-lane studio-image-overlay-lane';
      const overlayLabel = document.createElement('div');
      overlayLabel.className = 'studio-video-track-label';
      overlayLabel.textContent = `${layer.kind === 'text' ? 'T' : 'I'}${index + 1}`;
      const overlayCanvas = document.createElement('div');
      overlayCanvas.className = 'studio-video-lane-canvas studio-image-overlay-canvas';
      overlayCanvas.style.width = `${contentWidth}px`;
      overlayCanvas.style.backgroundSize = `${timelinePixelsPerSecond}px 100%`;
      const start = Math.max(0, layer.start ?? 0);
      const visibleEnd = Math.max(start + 0.1, layer.end ?? openLayerEnd);
      const block = document.createElement('button');
      block.type = 'button';
      block.className = `studio-image-overlay-clip ${layer.kind} ${layer.id === selectedImageLayerId ? 'active' : ''} ${layer.visible ? '' : 'hidden'}`;
      block.style.left = `${start * timelinePixelsPerSecond}px`;
      block.style.width = `${Math.max(36, (visibleEnd - start) * timelinePixelsPerSecond)}px`;
      const blockLabel = document.createElement('span');
      blockLabel.className = 'studio-image-overlay-label';
      blockLabel.textContent =
        layer.kind === 'text' ? layer.text || 'Text overlay' : (files[layer.fileIndex]?.name ?? 'Image overlay');
      const leftHandle = document.createElement('span');
      leftHandle.className = 'studio-image-overlay-trim studio-image-overlay-trim-left';
      leftHandle.setAttribute('aria-label', 'Trim overlay start');
      const rightHandle = document.createElement('span');
      rightHandle.className = 'studio-image-overlay-trim studio-image-overlay-trim-right';
      rightHandle.setAttribute('aria-label', 'Trim overlay end');
      block.appendChild(leftHandle);
      block.appendChild(blockLabel);
      block.appendChild(rightHandle);
      block.title = `${blockLabel.textContent} · ${start.toFixed(1)}–${layer.end === undefined ? 'end' : layer.end.toFixed(1)}s`;
      let moved = false;
      block.addEventListener('click', () => {
        if (moved) return;
        selectedImageLayerId = layer.id;
        selectedVideoClipId = null;
        selectedAudioClipId = null;
        updateSplitButton();
        void openImageComposer(layer.fileIndex);
      });
      const attachOverlayDrag = (target: HTMLElement, mode: 'move' | 'start' | 'end'): void => {
        target.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const pointerStart = event.clientX;
          const zoomAtDrag = timelinePixelsPerSecond;
          const initialStart = start;
          const initialEnd = visibleEnd;
          const storedEnd = layer.end;
          let didMove = false;
          target.setPointerCapture(event.pointerId);
          const update = (moveEvent: PointerEvent): void => {
            const delta = (moveEvent.clientX - pointerStart) / zoomAtDrag;
            if (Math.abs(delta) > 1 / zoomAtDrag) didMove = true;
            if (mode === 'move') {
              const nextStart = snapTimelineTime(Math.max(0, initialStart + delta), layer.id);
              layer.start = nextStart;
              if (storedEnd !== undefined)
                layer.end = Math.max(nextStart + 0.1, storedEnd + (nextStart - initialStart));
            } else if (mode === 'start') {
              layer.start = Math.max(0, Math.min(initialEnd - 0.1, snapTimelineTime(initialStart + delta, layer.id)));
            } else {
              layer.end = Math.max(initialStart + 0.1, snapTimelineTime(initialEnd + delta, layer.id));
            }
            const nextStart = layer.start ?? 0;
            const nextEnd = Math.max(nextStart + 0.1, layer.end ?? openLayerEnd);
            block.style.left = `${nextStart * timelinePixelsPerSecond}px`;
            block.style.width = `${Math.max(36, (nextEnd - nextStart) * timelinePixelsPerSecond)}px`;
            block.title = `${blockLabel.textContent} · ${nextStart.toFixed(1)}–${layer.end === undefined ? 'end' : layer.end.toFixed(1)}s`;
          };
          const finish = (): void => {
            target.removeEventListener('pointermove', update);
            if (didMove) {
              moved = true;
              window.setTimeout(() => {
                moved = false;
              }, 0);
              selectedImageLayerId = layer.id;
              selectedVideoClipId = null;
              selectedAudioClipId = null;
              renderVideoTimeline();
              updateSplitButton();
              scheduleAutosave();
            }
          };
          target.addEventListener('pointermove', update);
          target.addEventListener('pointerup', finish, { once: true });
          target.addEventListener('pointercancel', finish, { once: true });
        });
      };
      attachOverlayDrag(block, 'move');
      attachOverlayDrag(leftHandle, 'start');
      attachOverlayDrag(rightHandle, 'end');
      overlayCanvas.appendChild(block);
      overlayLane.appendChild(overlayLabel);
      overlayLane.appendChild(overlayCanvas);
      videoTimeline.appendChild(overlayLane);
    });
    const hasMainVideo = videoClips.some((clip) => clip.track !== 'overlay');
    videoPlayButton.disabled = !hasMainVideo;
    videoExportButton.disabled = !hasMainVideo;
    updateSplitButton();
    updateTimelinePlayhead(timelinePlayheadTime);
  };

  const renderAudioTimeline = (): void => {
    audioTimeline.innerHTML = '';
    audioPlayheadElements = [];
    const soloedTracks = new Set(audioClips.filter((clip) => clip.trackSolo).map((clip) => clip.track));
    const ruler = document.createElement('div');
    ruler.className = 'studio-audio-ruler';
    const end = Math.max(30, ...audioClips.map((clip) => clip.start + audioClipTimelineDuration(clip) + 5));
    const contentWidth = Math.max(1200, end * timelinePixelsPerSecond);
    ruler.style.width = `${contentWidth}px`;
    ruler.style.backgroundSize = `${timelinePixelsPerSecond * 5}px 100%`;
    for (let second = 0; second <= end; second += 5) {
      const tick = document.createElement('span');
      tick.style.left = `${second * timelinePixelsPerSecond}px`;
      tick.textContent = `${Math.floor(second / 60)}:${String(second % 60).padStart(2, '0')}`;
      ruler.appendChild(tick);
    }
    ruler.addEventListener('click', (event) => {
      const rect = ruler.getBoundingClientRect();
      requestVideoSeek(Math.max(0, (event.clientX - rect.left) / timelinePixelsPerSecond));
    });
    audioTimeline.appendChild(ruler);
    for (let track = 0; track < audioTrackCount; track++) {
      const lane = document.createElement('div');
      lane.className = 'studio-audio-lane';
      lane.dataset.track = String(track);
      const trackClips = audioClips.filter((clip) => clip.track === track);
      const trackMuted = trackClips.length > 0 && trackClips.every((clip) => clip.trackMuted);
      const trackSolo = trackClips.length > 0 && trackClips.every((clip) => clip.trackSolo);
      const trackMix = audioTrackMixSettings(trackClips[0] ?? {});
      lane.innerHTML = `<div class="studio-audio-track-label"><div class="studio-audio-track-heading"><span>A${track + 1}</span><div class="studio-audio-track-controls"><button type="button" data-action="mute" aria-pressed="${trackMuted}" title="${trackMuted ? 'Unmute' : 'Mute'} track">M</button><button type="button" data-action="solo" aria-pressed="${trackSolo}" title="${trackSolo ? 'Unsolo' : 'Solo'} track">S</button></div></div><label class="studio-audio-mixer-control" title="Track gain"><span>G</span><input class="studio-track-gain" type="range" min="0" max="2" step="0.01" value="${trackMix.gain}" aria-label="Track ${track + 1} gain"><output>${Math.round(trackMix.gain * 100)}%</output></label><label class="studio-audio-mixer-control" title="Track pan"><span>P</span><input class="studio-track-pan" type="range" min="-1" max="1" step="0.01" value="${trackMix.pan}" aria-label="Track ${track + 1} pan"><output>${trackMix.pan === 0 ? 'C' : `${Math.round(Math.abs(trackMix.pan) * 100)}%${trackMix.pan < 0 ? 'L' : 'R'}`}</output></label></div><div class="studio-audio-lane-canvas" style="width:${contentWidth}px"></div>`;
      const canvas = lane.querySelector<HTMLElement>('.studio-audio-lane-canvas')!;
      canvas.style.backgroundSize = `${timelinePixelsPerSecond}px 100%`;
      lane.querySelectorAll<HTMLInputElement>('.studio-audio-mixer-control input').forEach((input) => {
        input.disabled = trackClips.length === 0;
      });
      const updateTrackMix = (input: HTMLInputElement, setting: 'trackGain' | 'trackPan'): void => {
        const value = Number(input.value);
        for (const clip of trackClips) clip[setting] = value;
        const output = input.parentElement?.querySelector('output');
        if (output) {
          output.textContent =
            setting === 'trackGain'
              ? `${Math.round(value * 100)}%`
              : value === 0
                ? 'C'
                : `${Math.round(Math.abs(value) * 100)}%${value < 0 ? 'L' : 'R'}`;
        }
        scheduleAutosave();
      };
      lane.querySelector<HTMLInputElement>('.studio-track-gain')?.addEventListener('input', (event) => {
        updateTrackMix(event.currentTarget as HTMLInputElement, 'trackGain');
      });
      lane.querySelector<HTMLInputElement>('.studio-track-pan')?.addEventListener('input', (event) => {
        updateTrackMix(event.currentTarget as HTMLInputElement, 'trackPan');
      });
      lane.querySelectorAll<HTMLButtonElement>('.studio-audio-track-controls button').forEach((button) => {
        button.disabled = trackClips.length === 0;
        button.classList.toggle('active', button.dataset.action === 'mute' ? trackMuted : trackSolo);
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const shouldEnable = button.dataset.action === 'mute' ? !trackMuted : !trackSolo;
          for (const clip of trackClips) {
            if (button.dataset.action === 'mute') clip.trackMuted = shouldEnable;
            else clip.trackSolo = shouldEnable;
          }
          renderAudioTimeline();
          scheduleAutosave();
        });
      });
      for (const clip of trackClips) {
        const file = files[clip.fileIndex];
        if (!file) continue;
        const duration = Math.max(0.1, audioClipTimelineDuration(clip));
        const block = document.createElement('button');
        block.type = 'button';
        block.draggable = true;
        block.className = `studio-audio-clip ${clip.id === selectedAudioClipId ? 'active' : ''} ${clip.muted || clip.trackMuted || (soloedTracks.size > 0 && !soloedTracks.has(clip.track)) ? 'muted' : ''}`;
        block.dataset.clipId = clip.id;
        block.style.left = `${clip.start * timelinePixelsPerSecond}px`;
        block.style.width = `${Math.max(48, duration * timelinePixelsPerSecond)}px`;
        const peaks = audioPeaks.get(clip.fileIndex);
        const bars = peaks
          ? Array.from(peaks)
              .filter((_, index) => index % Math.max(1, Math.floor(peaks.length / 48)) === 0)
              .slice(0, 48)
          : [];
        const envelopePoints = audioClipGainEnvelopePoints(clip);
        const envelopeY = (value: number): number => 18 - value * 8;
        const speed = audioClipSpeed(clip);
        const envelopePolyline = (points: typeof envelopePoints): string =>
          points.map((point) => `${point.position * 100},${envelopeY(point.gain)}`).join(' ');
        block.innerHTML = `<span class="studio-audio-trim studio-audio-trim-left" aria-label="Trim start"></span><span class="studio-audio-clip-name">${escapeHtml(file.name)}${speed === 1 ? '' : ` · ${speed}×`}</span><span class="studio-audio-clip-wave">${bars.map((peak) => `<i style="height:${Math.max(8, Math.min(100, peak * 100))}%"></i>`).join('')}</span><svg class="studio-audio-envelope" viewBox="0 0 100 20" preserveAspectRatio="none" aria-label="Volume automation; double-click the clip to add points and right-click a point to remove it"><polyline points="${envelopePolyline(envelopePoints)}"></polyline>${envelopePoints.map((point, index) => `<circle class="studio-audio-envelope-point" data-point-index="${index}" cx="${point.position * 100}" cy="${envelopeY(point.gain)}" r="2.2" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="200" aria-valuenow="${Math.round(point.gain * 100)}" aria-label="Volume automation point ${index + 1}"></circle>`).join('')}</svg><span class="studio-audio-trim studio-audio-trim-right" aria-label="Trim end"></span>`;
        const envelopeSvg = block.querySelector<SVGSVGElement>('.studio-audio-envelope')!;
        const renderEnvelope = (): void => {
          const points = audioClipGainEnvelopePoints(clip);
          envelopeSvg.querySelector('polyline')?.setAttribute('points', envelopePolyline(points));
          envelopeSvg
            .querySelectorAll<SVGCircleElement>('.studio-audio-envelope-point')
            .forEach((pointElement, index) => {
              const point = points[index];
              if (!point) return;
              pointElement.setAttribute('cx', String(point.position * 100));
              pointElement.setAttribute('cy', String(envelopeY(point.gain)));
              pointElement.setAttribute('aria-valuenow', String(Math.round(point.gain * 100)));
            });
        };
        envelopeSvg.querySelectorAll<SVGCircleElement>('.studio-audio-envelope-point').forEach((pointElement) => {
          pointElement.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            if (selectedAudioClipId !== clip.id) {
              select(clip.fileIndex);
              selectedAudioClipId = clip.id;
              selectedVideoClipId = null;
              selectedImageLayerId = null;
              audioTimeline.querySelectorAll('.studio-audio-clip.active').forEach((activeClip) => {
                activeClip.classList.remove('active');
              });
              block.classList.add('active');
              renderInspector();
            }
            const pointIndex = Number(pointElement.dataset.pointIndex);
            pointElement.setPointerCapture(event.pointerId);
            const updateGain = (moveEvent: PointerEvent): void => {
              const bounds = envelopeSvg.getBoundingClientRect();
              if (bounds.height <= 0 || bounds.width <= 0) return;
              const points = audioClipGainEnvelopePoints(clip);
              const previous = points[pointIndex - 1];
              const next = points[pointIndex + 1];
              const rawPosition = (moveEvent.clientX - bounds.left) / bounds.width;
              const position =
                pointIndex === 0
                  ? 0
                  : pointIndex === points.length - 1
                    ? 1
                    : Math.max(previous.position + 0.0005, Math.min(next.position - 0.0005, rawPosition));
              const y = Math.max(2, Math.min(18, ((moveEvent.clientY - bounds.top) / bounds.height) * 20));
              const value = Math.round(((18 - y) / 8) * 100) / 100;
              clip.gainEnvelope = moveAudioClipGainEnvelopePoint(clip, pointIndex, position, value);
              renderEnvelope();
              const currentEnvelope = audioClipGainEnvelope(clip);
              inspectorBody.querySelectorAll<HTMLInputElement>('.studio-clip-envelope').forEach((input) => {
                const point = input.dataset.point as 'start' | 'middle' | 'end';
                input.value = String(Math.round(currentEnvelope[point] * 100));
                input.parentElement?.querySelector('small')?.replaceChildren(`${input.value}%`);
              });
            };
            const finish = (): void => {
              pointElement.removeEventListener('pointermove', updateGain);
              scheduleAutosave();
            };
            pointElement.addEventListener('pointermove', updateGain);
            pointElement.addEventListener('pointerup', finish, { once: true });
            pointElement.addEventListener('pointercancel', finish, { once: true });
          });
          pointElement.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const pointIndex = Number(pointElement.dataset.pointIndex);
            const pointCount = audioClipGainEnvelopePoints(clip).length;
            if (pointIndex === 0 || pointIndex === pointCount - 1) return;
            clip.gainEnvelope = removeAudioClipGainEnvelopePoint(clip, pointIndex);
            select(clip.fileIndex);
            selectedAudioClipId = clip.id;
            selectedVideoClipId = null;
            selectedImageLayerId = null;
            renderAudioTimeline();
            renderInspector();
            scheduleAutosave();
          });
        });
        block.addEventListener('dblclick', (event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('.studio-audio-trim, .studio-audio-envelope-point')
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = envelopeSvg.getBoundingClientRect();
          if (bounds.width <= 0 || bounds.height <= 0) return;
          const position = Math.max(0.005, Math.min(0.995, (event.clientX - bounds.left) / bounds.width));
          const y = Math.max(2, Math.min(18, ((event.clientY - bounds.top) / bounds.height) * 20));
          const gain = Math.round(((18 - y) / 8) * 100) / 100;
          const points = audioClipGainEnvelopePoints(clip);
          if (points.length >= 64 && !points.some((point) => Math.abs(point.position - position) < 0.001)) {
            mixStatus.textContent = 'An audio clip can have up to 64 volume points';
            return;
          }
          clip.gainEnvelope = setAudioClipGainEnvelopePoint(clip, position, gain);
          select(clip.fileIndex);
          selectedAudioClipId = clip.id;
          selectedVideoClipId = null;
          selectedImageLayerId = null;
          renderAudioTimeline();
          renderInspector();
          scheduleAutosave();
        });
        block.addEventListener('click', () => {
          select(clip.fileIndex);
          selectedAudioClipId = clip.id;
          selectedVideoClipId = null;
          selectedImageLayerId = null;
          renderAudioTimeline();
          renderInspector();
        });
        const attachAudioTrim = (handle: HTMLElement, edge: 'start' | 'end'): void => {
          handle.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const pointerStart = event.clientX;
            const zoomAtDrag = timelinePixelsPerSecond;
            const initialStart = clip.start;
            const initialSourceStart = clip.sourceStart;
            const initialSourceEnd = clip.sourceEnd;
            const sourceDuration = audioDurations.get(clip.fileIndex) ?? clip.sourceEnd;
            handle.setPointerCapture(event.pointerId);
            const updateClip = (moveEvent: PointerEvent): void => {
              const delta = (moveEvent.clientX - pointerStart) / zoomAtDrag;
              if (edge === 'start') {
                const speed = audioClipSpeed(clip);
                const minDelta = -Math.min(initialSourceStart / speed, initialStart);
                const maxDelta = (initialSourceEnd - initialSourceStart - 0.1) / speed;
                const snappedStart = snapTimelineTime(initialStart + delta, clip.id);
                const applied = Math.max(minDelta, Math.min(maxDelta, snappedStart - initialStart));
                clip.sourceStart = initialSourceStart + applied * speed;
                clip.start = initialStart + applied;
              } else {
                const speed = audioClipSpeed(clip);
                const initialTimelineEnd = initialStart + audioClipTimelineDuration(clip);
                const snappedEnd = snapTimelineTime(initialTimelineEnd + delta, clip.id);
                const applied = snappedEnd - initialTimelineEnd;
                clip.sourceEnd = Math.max(
                  initialSourceStart + 0.1,
                  Math.min(sourceDuration, initialSourceEnd + applied * speed),
                );
              }
              block.style.left = `${clip.start * timelinePixelsPerSecond}px`;
              block.style.width = `${Math.max(48, audioClipTimelineDuration(clip) * timelinePixelsPerSecond)}px`;
              const startField = inspectorBody.querySelector<HTMLInputElement>('.studio-clip-in');
              const endField = inspectorBody.querySelector<HTMLInputElement>('.studio-clip-out');
              const positionField = inspectorBody.querySelector<HTMLInputElement>('.studio-clip-position');
              if (startField) startField.value = clip.sourceStart.toFixed(1);
              if (endField) endField.value = clip.sourceEnd.toFixed(1);
              if (positionField) positionField.value = clip.start.toFixed(1);
            };
            const finish = (): void => {
              handle.removeEventListener('pointermove', updateClip);
              select(clip.fileIndex);
              selectedAudioClipId = clip.id;
              selectedVideoClipId = null;
              selectedImageLayerId = null;
              renderAudioTimeline();
              renderInspector();
              scheduleAutosave();
            };
            handle.addEventListener('pointermove', updateClip);
            handle.addEventListener('pointerup', finish, { once: true });
            handle.addEventListener('pointercancel', finish, { once: true });
          });
        };
        attachAudioTrim(block.querySelector<HTMLElement>('.studio-audio-trim-left')!, 'start');
        attachAudioTrim(block.querySelector<HTMLElement>('.studio-audio-trim-right')!, 'end');
        block.addEventListener('dragstart', (event) => {
          event.dataTransfer?.setData('application/x-flaxia-audio-clip', clip.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });
        canvas.appendChild(block);
      }
      const playhead = document.createElement('div');
      playhead.className = 'studio-timeline-playhead';
      playhead.setAttribute('aria-hidden', 'true');
      audioPlayheadElements.push(playhead);
      canvas.appendChild(playhead);
      lane.addEventListener('dragover', (event) => {
        if (event.dataTransfer?.types.includes('application/x-flaxia-audio-clip')) event.preventDefault();
      });
      lane.addEventListener('drop', (event) => {
        const id = event.dataTransfer?.getData('application/x-flaxia-audio-clip');
        const clip = audioClips.find((item) => item.id === id);
        if (!clip) return;
        event.preventDefault();
        const canvasRect = canvas.getBoundingClientRect();
        clip.start = snapTimelineTime((event.clientX - canvasRect.left) / timelinePixelsPerSecond, clip.id);
        if (clip.track !== track) {
          const destination = audioClips.find((item) => item.id !== clip.id && item.track === track);
          if (destination) {
            const trackMix = audioTrackMixSettings(destination);
            clip.trackGain = trackMix.gain;
            clip.trackPan = trackMix.pan;
            clip.trackMuted = destination.trackMuted === true;
            clip.trackSolo = destination.trackSolo === true;
          }
        }
        clip.track = track;
        audioTrackCount = Math.max(audioTrackCount, track + 1);
        select(clip.fileIndex);
        selectedAudioClipId = clip.id;
        selectedVideoClipId = null;
        selectedImageLayerId = null;
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
    mixPlayButton.disabled = audibleAudioTimelineClips(audioClips).length === 0;
    mixExportButton.disabled = audibleAudioTimelineClips(audioClips).length === 0;
    soloAudioButton.disabled = !audioClips.some((clip) => clip.id === selectedAudioClipId);
    updateTimelinePlayhead(timelinePlayheadTime);
  };

  const applyEditHistorySnapshot = (snapshot: StudioEditHistorySnapshot): void => {
    restoringHistory = true;
    if (codeHistoryTimer) clearTimeout(codeHistoryTimer);
    codeHistoryTimer = null;
    pendingEditorDraftFile = null;
    codeDirty = false;
    files = [...snapshot.files];
    activeIndex = snapshot.activeIndex;
    openTabs = openTabs.filter((index) => index < files.length);
    audioClips = snapshot.audioClips.map((clip) => ({ ...clip }));
    videoClips = snapshot.videoClips.map((clip) => ({ ...clip }));
    videoFormat = snapshot.videoFormat;
    videoFormatInput.value = videoFormat;
    imageLayers = snapshot.imageLayers.map((layer) => ({ ...layer }));
    audioTrackCount = snapshot.audioTrackCount;
    selectedAudioClipId = snapshot.selectedAudioClipId;
    selectedVideoClipId = snapshot.selectedVideoClipId;
    selectedImageLayerId = snapshot.selectedImageLayerId;
    stopVideoSequence();
    if (activeIndex >= 0 && activeIndex < files.length) select(activeIndex);
    else {
      activeIndex = -1;
      render();
    }
    selectedAudioClipId = snapshot.selectedAudioClipId;
    selectedVideoClipId = snapshot.selectedVideoClipId;
    selectedImageLayerId = snapshot.selectedImageLayerId;
    editHistoryBaseline = captureEditHistory();
    renderVideoTimeline();
    renderAudioTimeline();
    renderInspector();
    scheduleAutosave();
    restoringHistory = false;
    updateHistoryControls();
  };

  undoButton.addEventListener('click', () => {
    if (codeHistoryTimer) recordHistoryChange();
    const snapshot = undoHistory.pop();
    if (!snapshot) return;
    redoHistory.push(captureEditHistory());
    if (redoHistory.length > 100) redoHistory.shift();
    applyEditHistorySnapshot(snapshot);
  });
  redoButton.addEventListener('click', () => {
    if (codeHistoryTimer) recordHistoryChange();
    const snapshot = redoHistory.pop();
    if (!snapshot) return;
    undoHistory.push(captureEditHistory());
    if (undoHistory.length > 100) undoHistory.shift();
    applyEditHistorySnapshot(snapshot);
  });

  zoomInput.addEventListener('input', () => {
    const oldZoom = timelinePixelsPerSecond;
    const videoViewport = videoTimeline.parentElement;
    const audioViewport = audioTimeline.parentElement;
    const videoTime = videoViewport ? videoViewport.scrollLeft / oldZoom : 0;
    const audioTime = audioViewport ? audioViewport.scrollLeft / oldZoom : 0;
    timelinePixelsPerSecond = Number(zoomInput.value);
    zoomOutput.textContent = `${timelinePixelsPerSecond} px/s`;
    renderVideoTimeline();
    renderAudioTimeline();
    if (videoViewport) videoViewport.scrollLeft = videoTime * timelinePixelsPerSecond;
    if (audioViewport) audioViewport.scrollLeft = audioTime * timelinePixelsPerSecond;
  });

  const renderInspector = (): void => {
    const videoClip =
      videoClips.find((item) => item.id === selectedVideoClipId) ??
      videoClips.find((item) => item.fileIndex === activeIndex);
    const videoFile = videoClip ? files[videoClip.fileIndex] : null;
    if (videoClip && videoFile) {
      const duration = videoDurations.get(videoClip.fileIndex) ?? videoClip.sourceEnd;
      const colorControl = (
        name: 'brightness' | 'contrast' | 'saturation' | 'hueDeg' | 'blurPx',
        label: string,
      ): string => {
        const special = name === 'hueDeg' || name === 'blurPx';
        const value = videoClip[name] ?? (special ? 0 : 100);
        const min = name === 'hueDeg' ? -180 : 0;
        const max = name === 'hueDeg' ? 180 : name === 'blurPx' ? 24 : 200;
        const step = name === 'blurPx' ? 0.5 : 1;
        const suffix = name === 'hueDeg' ? '°' : name === 'blurPx' ? ' px' : '%';
        const display = name === 'blurPx' ? value.toFixed(1) : String(Math.round(value));
        return `<label class="studio-property studio-gain-property"><span>${label}</span><input class="studio-video-color" data-color="${name}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"><small>${display}${suffix}</small></label>`;
      };
      const colorControls = `${colorControl('brightness', 'Brightness')}${colorControl('contrast', 'Contrast')}${colorControl('saturation', 'Saturation')}${colorControl('hueDeg', 'Hue')}${colorControl('blurPx', 'Blur')}`;
      const clipDuration = videoClipTimelineDuration(videoClip);
      const orderedVideoClips = videoClips
        .filter((item) => item.track !== 'overlay')
        .sort((left, right) => left.start - right.start);
      const nextVideoClip = orderedVideoClips[orderedVideoClips.findIndex((item) => item.id === videoClip.id) + 1];
      const trackControl = `<label class="studio-property"><span>Video track</span><select class="studio-video-track-select"><option value="main" ${videoClip.track !== 'overlay' ? 'selected' : ''}>V1 · Main</option><option value="overlay" ${videoClip.track === 'overlay' ? 'selected' : ''}>V2 · Picture-in-picture</option></select></label>`;
      const transitionControl = `<label class="studio-property"><span>Transition out</span><select class="studio-video-transition" ${nextVideoClip ? '' : 'disabled'}>${[
        [0, 'Off'],
        [0.5, 'Cross-dissolve · 0.5s'],
        [1, 'Cross-dissolve · 1s'],
        [1.5, 'Cross-dissolve · 1.5s'],
        [2, 'Cross-dissolve · 2s'],
      ]
        .map(
          ([value, label]) =>
            `<option value="${value}" ${(videoClip.transitionOut ?? 0) === value ? 'selected' : ''}>${label}</option>`,
        )
        .join('')}</select></label>`;
      const transitionStyleControl = `<label class="studio-property"><span>Style</span><select class="studio-video-transition-style" ${nextVideoClip ? '' : 'disabled'}>${[
        ['fade', 'Cross-dissolve'],
        ['wipeleft', 'Wipe left'],
        ['wiperight', 'Wipe right'],
      ]
        .map(
          ([value, label]) =>
            `<option value="${value}" ${(videoClip.transitionType ?? 'fade') === value ? 'selected' : ''}>${label}</option>`,
        )
        .join('')}</select></label>`;
      inspectorBody.innerHTML = `<div class="studio-inspector-icon">▶</div><h2>${escapeHtml(videoFile.name)}</h2><p>Video clip · ${duration.toFixed(1)}s source</p><div class="studio-inspector-divider"></div><label class="studio-property"><span>Position</span><input class="studio-video-position" type="number" min="0" step="0.1" value="${videoClip.start.toFixed(1)}"><small>s</small></label>${trackControl}<label class="studio-property"><span>Framing</span><select class="studio-video-fit"><option value="contain" ${videoClip.fit !== 'cover' ? 'selected' : ''}>Fit · show whole frame</option><option value="cover" ${videoClip.fit === 'cover' ? 'selected' : ''}>Fill · crop to frame</option></select></label><label class="studio-property"><span>Speed</span><select class="studio-video-speed">${[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => `<option value="${speed}" ${videoClipSpeed(videoClip) === speed ? 'selected' : ''}>${speed}×</option>`).join('')}</select></label>${transitionControl}${transitionStyleControl}${colorControls}<label class="studio-property"><span>Trim in</span><input class="studio-video-in" type="number" min="0" max="${duration.toFixed(2)}" step="0.1" value="${videoClip.sourceStart.toFixed(1)}"><small>s</small></label><label class="studio-property"><span>Trim out</span><input class="studio-video-out" type="number" min="0.1" max="${duration.toFixed(2)}" step="0.1" value="${videoClip.sourceEnd.toFixed(1)}"><small>s</small></label><label class="studio-property"><span>Fade in</span><input class="studio-video-fade-in" type="number" min="0" max="${clipDuration.toFixed(1)}" step="0.1" value="${(videoClip.fadeIn ?? 0).toFixed(1)}"><small>s</small></label><label class="studio-property"><span>Fade out</span><input class="studio-video-fade-out" type="number" min="0" max="${clipDuration.toFixed(1)}" step="0.1" value="${(videoClip.fadeOut ?? 0).toFixed(1)}"><small>s</small></label><label class="studio-property studio-gain-property"><span>Clip audio</span><input class="studio-video-gain" type="range" min="0" max="100" value="${Math.round((videoClip.gain ?? 1) * 100)}"><small class="studio-video-gain-value">${Math.round((videoClip.gain ?? 1) * 100)}%</small></label><label class="studio-property studio-mute-property"><input class="studio-video-muted" type="checkbox" ${videoClip.muted ? 'checked' : ''}><span>Mute source audio</span></label><p class="studio-video-hint">V2 overlays the clip as picture-in-picture; its source audio is mixed into the export unless muted.</p><button class="studio-button studio-remove-video" type="button">Remove from timeline</button>`;
      const update = (selector: string, set: (value: number) => void): void => {
        inspectorBody.querySelector<HTMLInputElement>(selector)!.addEventListener('change', (event) => {
          const input = event.currentTarget as HTMLInputElement;
          const value = Number(input.value);
          if (!Number.isFinite(value)) return;
          set(value);
          rippleOverlappingVideoClips(videoClips);
          renderVideoTimeline();
          renderInspector();
          scheduleAutosave();
        });
      };
      update('.studio-video-position', (value) => {
        manuallyPlacedVideoClips.add(videoClip.id);
        videoClip.start = Math.max(0, Math.min(value, 14_400));
      });
      (inspectorBody.querySelector('.studio-video-track-select') as unknown as HTMLSelectElement).addEventListener(
        'change',
        (event) => {
          const track = (event.currentTarget as HTMLSelectElement).value;
          if (track !== 'main' && track !== 'overlay') return;
          if (
            track === 'overlay' &&
            videoClip.track !== 'overlay' &&
            videoClips.filter((item) => item.track !== 'overlay').length <= 1
          ) {
            (event.currentTarget as HTMLSelectElement).value = 'main';
            return;
          }
          videoClip.track = track;
          if (track === 'overlay') videoClip.transitionOut = 0;
          rippleOverlappingVideoClips(videoClips);
          stopVideoSequence();
          renderVideoTimeline();
          renderInspector();
          scheduleAutosave();
        },
      );
      inspectorBody.querySelector('select.studio-video-fit')!.addEventListener('change', (event) => {
        videoClip.fit = (event.currentTarget as HTMLSelectElement).value === 'cover' ? 'cover' : 'contain';
        if (videoSequencePlayer?.dataset.clipId === videoClip.id) {
          videoSequencePlayer.style.objectFit = videoClip.fit;
        }
        if (videoSequenceTransitionPlayer?.dataset.clipId === videoClip.id) {
          videoSequenceTransitionPlayer.style.objectFit = videoClip.fit;
        }
        if (videoSequencePipPlayer?.dataset.clipId === videoClip.id) {
          videoSequencePipPlayer.style.objectFit = videoClip.fit;
        }
        scheduleAutosave();
      });
      inspectorBody.querySelector('select.studio-video-speed')!.addEventListener('change', (event) => {
        const speed = Number((event.currentTarget as HTMLSelectElement).value);
        if (![0.5, 0.75, 1, 1.25, 1.5, 2].includes(speed)) return;
        videoClip.speed = speed;
        rippleOverlappingVideoClips(videoClips);
        stopVideoSequence();
        renderVideoTimeline();
        renderInspector();
        scheduleAutosave();
      });
      inspectorBody.querySelectorAll<HTMLInputElement>('.studio-video-color').forEach((input) => {
        input.addEventListener('input', () => {
          const color = input.dataset.color as 'brightness' | 'contrast' | 'saturation' | 'hueDeg' | 'blurPx';
          const value = Number(input.value);
          videoClip[color] = value;
          const output = input.parentElement?.querySelector('small');
          if (output) {
            output.textContent = `${color === 'blurPx' ? value.toFixed(1) : Math.round(value)}${color === 'hueDeg' ? '°' : color === 'blurPx' ? ' px' : '%'}`;
          }
          if (videoSequencePlayer?.dataset.clipId === videoClip.id) {
            videoSequencePlayer.style.filter = videoClipCssFilter(videoClip);
          }
          if (videoSequenceTransitionPlayer?.dataset.clipId === videoClip.id) {
            videoSequenceTransitionPlayer.style.filter = videoClipCssFilter(videoClip);
          }
          if (videoSequencePipPlayer?.dataset.clipId === videoClip.id) {
            videoSequencePipPlayer.style.filter = videoClipCssFilter(videoClip);
          }
        });
        input.addEventListener('change', () => scheduleAutosave());
      });
      update('.studio-video-in', (value) => {
        videoClip.sourceStart = Math.max(0, Math.min(value, videoClip.sourceEnd - 0.1));
      });
      update('.studio-video-out', (value) => {
        videoClip.sourceEnd = Math.max(videoClip.sourceStart + 0.1, Math.min(value, duration));
      });
      update('.studio-video-fade-in', (value) => {
        videoClip.fadeIn = Math.min(videoClipTimelineDuration(videoClip), Math.max(0, value));
      });
      update('.studio-video-fade-out', (value) => {
        videoClip.fadeOut = Math.min(videoClipTimelineDuration(videoClip), Math.max(0, value));
      });
      inspectorBody.querySelector('select.studio-video-transition')!.addEventListener('change', (event) => {
        const transition = Number((event.currentTarget as HTMLSelectElement).value);
        if (![0, 0.5, 1, 1.5, 2].includes(transition)) return;
        videoClip.transitionOut = transition;
        const ordered = videoClips
          .filter((item) => item.track !== 'overlay')
          .sort((left, right) => left.start - right.start);
        const next = ordered[ordered.findIndex((item) => item.id === videoClip.id) + 1];
        if (next && transition > 0) next.start = videoClip.start + videoClipTimelineDuration(videoClip);
        rippleOverlappingVideoClips(videoClips);
        stopVideoSequence();
        renderVideoTimeline();
        renderInspector();
        scheduleAutosave();
      });
      inspectorBody.querySelector('select.studio-video-transition-style')!.addEventListener('change', (event) => {
        const transitionType = (event.currentTarget as HTMLSelectElement).value;
        if (transitionType !== 'fade' && transitionType !== 'wipeleft' && transitionType !== 'wiperight') return;
        videoClip.transitionType = transitionType;
        stopVideoSequence();
        renderVideoTimeline();
        renderInspector();
        scheduleAutosave();
      });
      const videoGain = inspectorBody.querySelector<HTMLInputElement>('.studio-video-gain')!;
      videoGain.addEventListener('input', () => {
        videoClip.gain = Number(videoGain.value) / 100;
        inspectorBody.querySelector('.studio-video-gain-value')!.textContent = `${videoGain.value}%`;
        if (videoSequencePlayer?.dataset.clipId === videoClip.id) {
          videoSequencePlayer.volume = videoClip.gain;
        }
        if (videoSequenceTransitionPlayer?.dataset.clipId === videoClip.id) {
          videoSequenceTransitionPlayer.volume = videoClip.gain;
        }
        if (videoSequencePipPlayer?.dataset.clipId === videoClip.id) {
          videoSequencePipPlayer.volume = videoClip.gain;
        }
      });
      videoGain.addEventListener('change', () => scheduleAutosave());
      inspectorBody.querySelector<HTMLInputElement>('.studio-video-muted')!.addEventListener('change', (event) => {
        videoClip.muted = (event.currentTarget as HTMLInputElement).checked;
        if (videoSequencePlayer?.dataset.clipId === videoClip.id) {
          videoSequencePlayer.muted = videoClip.muted;
        }
        if (videoSequenceTransitionPlayer?.dataset.clipId === videoClip.id) {
          videoSequenceTransitionPlayer.muted = videoClip.muted;
        }
        if (videoSequencePipPlayer?.dataset.clipId === videoClip.id) {
          videoSequencePipPlayer.muted = videoClip.muted;
        }
        scheduleAutosave();
      });
      inspectorBody.querySelector<HTMLButtonElement>('.studio-remove-video')!.addEventListener('click', () => {
        videoClips = videoClips.filter((item) => item.id !== videoClip.id);
        selectedVideoClipId = null;
        renderVideoTimeline();
        renderInspector();
        scheduleAutosave();
      });
      return;
    }
    const clip =
      audioClips.find((item) => item.id === selectedAudioClipId) ??
      audioClips.find((item) => item.fileIndex === activeIndex);
    const file = clip ? files[clip.fileIndex] : null;
    if (!clip || !file) {
      inspectorBody.innerHTML = defaultInspector;
      return;
    }
    const duration = audioDurations.get(clip.fileIndex) ?? clip.sourceEnd;
    const timelineDuration = audioClipTimelineDuration(clip);
    const eqSettings = audioClipEqSettings(clip);
    const gainEnvelope = audioClipGainEnvelope(clip);
    const eqControls = (
      [
        ['lowEqDb', 'Low · 120 Hz'],
        ['midEqDb', 'Mid · 1 kHz'],
        ['highEqDb', 'High · 8 kHz'],
      ] as const
    )
      .map(
        ([band, label]) =>
          `<label class="studio-property studio-gain-property"><span>${label}</span><input class="studio-clip-eq" data-eq="${band}" type="range" min="-18" max="18" step="1" value="${eqSettings[band]}"><small>${eqSettings[band]} dB</small></label>`,
      )
      .join('');
    inspectorBody.innerHTML = `<div class="studio-inspector-icon">♫</div><h2>${escapeHtml(file.name)}</h2><p>Audio clip · ${duration.toFixed(1)}s source</p><div class="studio-inspector-divider"></div><label class="studio-property"><span>Position</span><input class="studio-clip-position" type="number" min="0" step="0.1" value="${clip.start.toFixed(1)}"><small>s</small></label><label class="studio-property"><span>Trim in</span><input class="studio-clip-in" type="number" min="0" max="${duration.toFixed(2)}" step="0.1" value="${clip.sourceStart.toFixed(1)}"><small>s</small></label><label class="studio-property"><span>Trim out</span><input class="studio-clip-out" type="number" min="0.1" max="${duration.toFixed(2)}" step="0.1" value="${clip.sourceEnd.toFixed(1)}"><small>s</small></label><label class="studio-property studio-gain-property"><span>Gain</span><input class="studio-clip-gain" type="range" min="0" max="200" value="${Math.round(clip.gain * 100)}"><small class="studio-gain-value">${Math.round(clip.gain * 100)}%</small></label><label class="studio-property studio-gain-property"><span>Pan</span><input class="studio-clip-pan" type="range" min="-100" max="100" value="${Math.round(clip.pan * 100)}"><small class="studio-pan-value">${clip.pan === 0 ? 'Center' : `${Math.abs(Math.round(clip.pan * 100))}% ${clip.pan < 0 ? 'L' : 'R'}`}</small></label><div class="studio-inspector-divider"></div><div class="studio-format-title">VOLUME AUTOMATION</div><label class="studio-property studio-gain-property"><span>Start</span><input class="studio-clip-envelope" data-point="start" type="range" min="0" max="200" value="${Math.round(gainEnvelope.start * 100)}"><small>${Math.round(gainEnvelope.start * 100)}%</small></label><label class="studio-property studio-gain-property"><span>Middle</span><input class="studio-clip-envelope" data-point="middle" type="range" min="0" max="200" value="${Math.round(gainEnvelope.middle * 100)}"><small>${Math.round(gainEnvelope.middle * 100)}%</small></label><label class="studio-property studio-gain-property"><span>End</span><input class="studio-clip-envelope" data-point="end" type="range" min="0" max="200" value="${Math.round(gainEnvelope.end * 100)}"><small>${Math.round(gainEnvelope.end * 100)}%</small></label><p class="studio-eq-hint">Double-click the clip to add a point; drag points on the waveform to shape the curve; right-click a point to remove it.</p><div class="studio-inspector-divider"></div><div class="studio-format-title">3-BAND EQ</div>${eqControls}<p class="studio-eq-hint">EQ is applied when previewing or exporting the mix.</p><label class="studio-property"><span>Fade in</span><input class="studio-clip-fade-in" type="number" min="0" max="${(clip.sourceEnd - clip.sourceStart).toFixed(1)}" step="0.1" value="${clip.fadeIn.toFixed(1)}"><small>s</small></label><label class="studio-property"><span>Fade out</span><input class="studio-clip-fade-out" type="number" min="0" max="${(clip.sourceEnd - clip.sourceStart).toFixed(1)}" step="0.1" value="${clip.fadeOut.toFixed(1)}"><small>s</small></label><label class="studio-property studio-mute-property"><input class="studio-clip-muted" type="checkbox" ${clip.muted ? 'checked' : ''}><span>Mute clip</span></label><div class="studio-inspector-divider"></div><button class="studio-button studio-remove-audio" type="button">Remove from timeline</button>`;
    const automationHeading = inspectorBody.querySelector<HTMLElement>('.studio-format-title')!;
    const addEnvelopePointButton = document.createElement('button');
    addEnvelopePointButton.type = 'button';
    addEnvelopePointButton.className = 'studio-add-envelope-point';
    addEnvelopePointButton.textContent = '＋ Add point at playhead';
    addEnvelopePointButton.title = 'Add a volume automation point at the timeline playhead';
    automationHeading.appendChild(addEnvelopePointButton);
    inspectorBody.querySelector('.studio-eq-hint')!.textContent =
      'Add points at the playhead, drag them to shape the curve, and right-click an interior point to remove it.';
    addEnvelopePointButton.addEventListener('click', () => {
      const position = (timelinePlayheadTime - clip.start) / audioClipTimelineDuration(clip);
      if (!Number.isFinite(position) || position <= 0.005 || position >= 0.995) {
        mixStatus.textContent = 'Move the playhead inside this clip to add a volume point';
        return;
      }
      const points = audioClipGainEnvelopePoints(clip);
      if (points.length >= 64 && !points.some((point) => Math.abs(point.position - position) < 0.001)) {
        mixStatus.textContent = 'An audio clip can have up to 64 volume points';
        return;
      }
      clip.gainEnvelope = setAudioClipGainEnvelopePoint(clip, position, audioClipGainEnvelopeAt(clip, position));
      mixStatus.textContent = '';
      renderAudioTimeline();
      renderInspector();
      scheduleAutosave();
    });
    inspectorBody.querySelector('h2 + p')!.textContent =
      `Audio clip · ${(clip.sourceEnd - clip.sourceStart).toFixed(1)}s source → ${timelineDuration.toFixed(1)}s timeline`;
    inspectorBody.querySelectorAll<HTMLInputElement>('.studio-clip-fade-in, .studio-clip-fade-out').forEach((input) => {
      input.max = timelineDuration.toFixed(1);
    });
    const speedField = document.createElement('label');
    speedField.className = 'studio-property';
    const speedLabel = document.createElement('span');
    speedLabel.textContent = 'Speed · pitch';
    const speedSelect = document.createElement('select');
    speedSelect.className = 'studio-clip-speed';
    speedSelect.setAttribute('aria-label', 'Audio playback speed');
    for (const rate of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
      const option = document.createElement('option');
      option.value = String(rate);
      option.textContent = `${rate}×`;
      option.selected = audioClipSpeed(clip) === rate;
      speedSelect.appendChild(option);
    }
    speedField.appendChild(speedLabel);
    speedField.appendChild(speedSelect);
    inspectorBody
      .querySelector<HTMLInputElement>('.studio-clip-position')
      ?.parentElement?.insertAdjacentElement('beforebegin', speedField);
    speedSelect.addEventListener('change', (event) => {
      clip.speed = audioClipSpeed({ speed: Number((event.currentTarget as HTMLSelectElement).value) });
      const nextDuration = audioClipTimelineDuration(clip);
      clip.fadeIn = Math.min(clip.fadeIn, nextDuration);
      clip.fadeOut = Math.min(clip.fadeOut, nextDuration);
      renderAudioTimeline();
      renderInspector();
      scheduleAutosave();
    });
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
    inspectorBody.querySelectorAll<HTMLInputElement>('.studio-clip-envelope').forEach((input) => {
      input.addEventListener('input', () => {
        const point = input.dataset.point as 'start' | 'middle' | 'end';
        const position = point === 'start' ? 0 : point === 'middle' ? 0.5 : 1;
        clip.gainEnvelope = setAudioClipGainEnvelopePoint(clip, position, Number(input.value) / 100);
        input.parentElement?.querySelector('small')?.replaceChildren(`${input.value}%`);
        const svg = audioTimeline.querySelector<SVGSVGElement>('.studio-audio-clip.active .studio-audio-envelope');
        if (!svg) return;
        const points = audioClipGainEnvelopePoints(clip);
        const envelopeY = (gain: number): number => 18 - gain * 8;
        svg
          .querySelector('polyline')
          ?.setAttribute('points', points.map((item) => `${item.position * 100},${envelopeY(item.gain)}`).join(' '));
        svg.querySelectorAll<SVGCircleElement>('.studio-audio-envelope-point').forEach((pointElement, index) => {
          const item = points[index];
          if (!item) return;
          pointElement.setAttribute('cx', String(item.position * 100));
          pointElement.setAttribute('cy', String(envelopeY(item.gain)));
          pointElement.setAttribute('aria-valuenow', String(Math.round(item.gain * 100)));
        });
      });
      input.addEventListener('change', () => scheduleAutosave());
    });
    inspectorBody.querySelectorAll<HTMLInputElement>('.studio-clip-eq').forEach((input) => {
      input.addEventListener('input', () => {
        const band = input.dataset.eq as 'lowEqDb' | 'midEqDb' | 'highEqDb';
        const value = Math.max(-18, Math.min(18, Number(input.value)));
        clip[band] = value;
        const output = input.parentElement?.querySelector('small');
        if (output) output.textContent = `${value} dB`;
      });
      input.addEventListener('change', () => scheduleAutosave());
    });
    numeric('.studio-clip-fade-in', (value) => {
      clip.fadeIn = Math.max(0, Math.min(value, audioClipTimelineDuration(clip)));
    });
    numeric('.studio-clip-fade-out', (value) => {
      clip.fadeOut = Math.max(0, Math.min(value, audioClipTimelineDuration(clip)));
    });
    inspectorBody.querySelector<HTMLInputElement>('.studio-clip-muted')!.addEventListener('change', (event) => {
      clip.muted = (event.currentTarget as HTMLInputElement).checked;
      renderAudioTimeline();
      scheduleAutosave();
    });
    inspectorBody.querySelector<HTMLButtonElement>('.studio-remove-audio')!.addEventListener('click', () => {
      audioClips = audioClips.filter((item) => item.id !== clip.id);
      selectedAudioClipId = null;
      renderAudioTimeline();
      renderInspector();
      scheduleAutosave();
    });
  };

  const render = (): void => {
    if (destroyed) return;
    renderDocumentTabs();
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

  const createCodeEditor = (
    text: string,
    fileName: string,
    onChange: () => void,
    tracksProjectFile = true,
    initialSearch?: string,
  ): HTMLElement => {
    const workbench = document.createElement('div');
    workbench.className = 'studio-code-workbench';
    const initialSearchQuery = initialSearch?.trim() ?? '';
    const toolbar = document.createElement('div');
    toolbar.className = 'studio-code-toolbar';
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Find';
    search.setAttribute('aria-label', 'Find in file');
    search.value = initialSearchQuery;
    const replacement = document.createElement('input');
    replacement.type = 'text';
    replacement.placeholder = 'Replace';
    replacement.setAttribute('aria-label', 'Replace with');
    const replaceButton = document.createElement('button');
    replaceButton.type = 'button';
    replaceButton.textContent = 'Replace';
    const replaceAllButton = document.createElement('button');
    replaceAllButton.type = 'button';
    replaceAllButton.textContent = 'Replace all';
    const replaceStatus = document.createElement('span');
    replaceStatus.className = 'studio-code-find-status';
    replaceStatus.style.cssText = 'color:var(--studio-muted);font-size:10px';
    replaceStatus.setAttribute('aria-live', 'polite');
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
    toolbar.appendChild(replaceAllButton);
    toolbar.appendChild(replaceStatus);
    toolbar.appendChild(lineInput);
    toolbar.appendChild(goButton);

    const editorRow = document.createElement('div');
    editorRow.className = 'studio-code-row';
    const gutter = document.createElement('div');
    gutter.className = 'studio-code-gutter';
    gutter.setAttribute('aria-hidden', 'true');
    const surface = document.createElement('div');
    surface.className = 'studio-code-surface';
    const highlight = document.createElement('pre');
    highlight.className = 'studio-code-highlight';
    highlight.setAttribute('aria-hidden', 'true');
    const area = document.createElement('textarea');
    area.className = 'studio-code-editor';
    area.spellcheck = false;
    area.wrap = 'off';
    area.setAttribute('aria-label', `Edit ${fileName}`);
    area.value = text;
    if (initialSearchQuery) {
      const match = area.value.toLowerCase().indexOf(initialSearchQuery.toLowerCase());
      if (match >= 0) area.setSelectionRange(match, match + initialSearchQuery.length);
    }
    let monacoEditor: Monaco.editor.IStandaloneCodeEditor | null = null;
    const currentValue = (): string => monacoEditor?.getValue() ?? area.value;
    const findNextMatch = (query: string): boolean => {
      if (!query) return false;
      if (!monacoEditor) {
        const from = area.selectionEnd;
        const found = area.value.indexOf(query, from);
        const start = found >= 0 ? found : area.value.indexOf(query);
        if (start < 0) return false;
        area.focus();
        area.setSelectionRange(start, start + query.length);
        return true;
      }
      const model = monacoEditor.getModel();
      if (!model) return false;
      const position = monacoEditor.getPosition();
      const from = position ? model.getOffsetAt(position) : 0;
      const value = monacoEditor.getValue();
      const found = value.indexOf(query, from);
      const start = found >= 0 ? found : value.indexOf(query);
      if (start < 0) return false;
      const first = model.getPositionAt(start);
      const last = model.getPositionAt(start + query.length);
      monacoEditor.setSelection({
        startLineNumber: first.lineNumber,
        startColumn: first.column,
        endLineNumber: last.lineNumber,
        endColumn: last.column,
      });
      monacoEditor.revealLineInCenter(first.lineNumber);
      monacoEditor.focus();
      return true;
    };
    const updateGutter = (): void => {
      const lines = area.value.split('\n').length;
      gutter.textContent = Array.from({ length: lines }, (_, index) => String(index + 1)).join('\n');
      gutter.scrollTop = area.scrollTop;
      lineInput.max = String(lines);
      highlight.innerHTML = highlightCode(area.value, fileName);
      highlight.style.transform = `translate(${-area.scrollLeft}px, ${-area.scrollTop}px)`;
    };
    area.addEventListener('input', () => {
      editorText = area.value;
      if (tracksProjectFile) {
        codeDirty = true;
        updatePendingEditorDraftFile();
        scheduleCodeHistoryCheckpoint();
        saveState.textContent = 'Unsaved changes';
        exportButton.textContent = 'Save file';
        renderDocumentTabs();
      }
      updateGutter();
      onChange();
    });
    area.addEventListener('scroll', updateGutter);
    search.addEventListener('input', () => {
      replaceStatus.textContent = '';
    });
    replaceAllButton.addEventListener('click', () => {
      const query = search.value;
      if (!query) return;
      const parts = currentValue().split(query);
      const count = parts.length - 1;
      if (count === 0) {
        replaceStatus.textContent = 'No matches';
        return;
      }
      const nextValue = parts.join(replacement.value);
      if (monacoEditor) {
        const model = monacoEditor.getModel();
        if (!model) return;
        const cursor = model.getOffsetAt(monacoEditor.getPosition() ?? { lineNumber: 1, column: 1 });
        monacoEditor.executeEdits('studio.replaceAll', [{ range: model.getFullModelRange(), text: nextValue }]);
        monacoEditor.setPosition(model.getPositionAt(Math.min(cursor, nextValue.length)));
        monacoEditor.focus();
      } else {
        const cursor = area.selectionStart;
        area.value = nextValue;
        const nextCursor = Math.min(cursor, area.value.length);
        area.setSelectionRange(nextCursor, nextCursor);
        area.dispatchEvent(new Event('input'));
      }
      replaceStatus.textContent = `${count} replaced`;
    });
    area.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (tracksProjectFile) {
          if (codeDirty) exportButton.click();
        } else workbench.parentElement?.querySelector<HTMLButtonElement>('.studio-zip-save')?.click();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        const runButton = workbench.parentElement?.querySelector<HTMLButtonElement>('.studio-code-run');
        if (runButton) {
          event.preventDefault();
          runButton.click();
        }
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
        area.dispatchEvent(new Event('input'));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const start = area.selectionStart;
        const end = area.selectionEnd;
        const lineStart = area.value.lastIndexOf('\n', start - 1) + 1;
        const indent = area.value.slice(lineStart, start).match(/^[\t ]*/)?.[0] ?? '';
        if (area.value[start - 1] === '{' && area.value[end] === '}') {
          const inserted = `\n${indent}  \n${indent}`;
          area.setRangeText(inserted, start, end, 'end');
          const caret = start + indent.length + 3;
          area.setSelectionRange(caret, caret);
        } else {
          area.setRangeText(`\n${indent}`, start, end, 'end');
        }
        area.dispatchEvent(new Event('input'));
        return;
      }
      if (event.key === '}' && area.selectionStart === area.selectionEnd) {
        const cursor = area.selectionStart;
        const lineStart = area.value.lastIndexOf('\n', cursor - 1) + 1;
        const indent = area.value.slice(lineStart, cursor);
        const remaining = area.value.slice(cursor).match(/^\n[\t ]*\}/);
        if (/^[\t ]+$/.test(indent) && remaining && indent.endsWith('  ')) {
          const baseIndent = indent.slice(0, -2);
          const replaceEnd = cursor + remaining[0].length;
          area.setRangeText(`${baseIndent}}`, lineStart, replaceEnd, 'end');
          const caret = lineStart + baseIndent.length + 1;
          area.setSelectionRange(caret, caret);
          event.preventDefault();
          area.dispatchEvent(new Event('input'));
          return;
        }
      }
      if ([')', ']', '}', '"', "'", '`'].includes(event.key) && area.selectionStart === area.selectionEnd) {
        const cursor = area.selectionStart;
        if (area.value[cursor] === event.key) {
          event.preventDefault();
          area.setSelectionRange(cursor + 1, cursor + 1);
          return;
        }
      }
      const closingPairs: Record<string, string> = {
        '(': ')',
        '[': ']',
        '{': '}',
        '"': '"',
        "'": "'",
        '`': '`',
      };
      const closing = closingPairs[event.key];
      if (closing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const start = area.selectionStart;
        const end = area.selectionEnd;
        if (!(event.key === "'" || event.key === '"' || event.key === '`') || area.value[start - 1] !== '\\') {
          event.preventDefault();
          const selected = area.value.slice(start, end);
          area.setRangeText(`${event.key}${selected}${closing}`, start, end, 'end');
          area.setSelectionRange(start + 1, start + 1 + selected.length);
          area.dispatchEvent(new Event('input'));
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        search.focus();
      }
    });
    goButton.addEventListener('click', () => {
      const lines = monacoEditor?.getModel()?.getLineCount() ?? currentValue().split('\n').length;
      const line = Math.max(1, Math.min(Number(lineInput.value) || 1, lines));
      if (monacoEditor) {
        monacoEditor.revealLineInCenter(line);
        monacoEditor.setPosition({ lineNumber: line, column: 1 });
        monacoEditor.focus();
        return;
      }
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
      if (!findNextMatch(search.value)) replaceStatus.textContent = 'No matches';
    });
    replaceButton.addEventListener('click', () => {
      if (!search.value) return;
      if (monacoEditor) {
        const selection = monacoEditor.getSelection();
        const model = monacoEditor.getModel();
        if (!selection || !model) return;
        if (model.getValueInRange(selection) === search.value) {
          monacoEditor.executeEdits('studio.replace', [{ range: selection, text: replacement.value }]);
        } else if (!findNextMatch(search.value)) replaceStatus.textContent = 'No matches';
        return;
      }
      const start = area.selectionStart;
      const end = area.selectionEnd;
      if (area.value.slice(start, end) === search.value) {
        area.setRangeText(replacement.value, start, end, 'end');
        area.dispatchEvent(new Event('input'));
      } else {
        search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
    });
    surface.appendChild(highlight);
    surface.appendChild(area);
    editorRow.appendChild(gutter);
    editorRow.appendChild(surface);
    workbench.appendChild(toolbar);
    workbench.appendChild(editorRow);
    updateGutter();
    const monacoHost = document.createElement('div');
    monacoHost.className = 'studio-code-monaco';
    monacoHost.style.cssText = 'width:100%;height:100%;min-height:260px';
    void Promise.resolve()
      .then(async () => {
        const { loadStudioMonaco } = await import('../lib/editor/monaco-editor.ts');
        return loadStudioMonaco(studioMonacoLanguage(fileName));
      })
      .then((monaco) => {
        if (!workbench.isConnected || destroyed) return;
        editorRow.replaceChildren(monacoHost);
        try {
          monacoEditor = monaco.editor.create(monacoHost, {
            value: area.value,
            language: studioMonacoLanguage(fileName),
            theme: 'vs-dark',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 12,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            tabSize: 2,
            insertSpaces: true,
            renderLineHighlight: 'line',
            bracketPairColorization: { enabled: true },
            guides: { bracketPairs: true, indentation: true },
            padding: { top: 12, bottom: 12 },
          });
        } catch (error) {
          editorRow.replaceChildren(gutter, surface);
          throw error;
        }
        const activeEditor = monacoEditor;
        if (initialSearchQuery) {
          const model = activeEditor.getModel();
          const match = activeEditor.getValue().toLowerCase().indexOf(initialSearchQuery.toLowerCase());
          if (model && match >= 0) {
            const start = model.getPositionAt(match);
            const end = model.getPositionAt(match + initialSearchQuery.length);
            activeEditor.setSelection({
              startLineNumber: start.lineNumber,
              startColumn: start.column,
              endLineNumber: end.lineNumber,
              endColumn: end.column,
            });
            activeEditor.revealLineInCenter(start.lineNumber);
            activeEditor.focus();
          }
        }
        const modelChanges = activeEditor.onDidChangeModelContent(() => {
          editorText = activeEditor.getValue();
          if (tracksProjectFile) {
            codeDirty = true;
            updatePendingEditorDraftFile();
            scheduleCodeHistoryCheckpoint();
            saveState.textContent = 'Unsaved changes';
            exportButton.textContent = 'Save file';
            renderDocumentTabs();
          }
          onChange();
        });
        activeEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          if (tracksProjectFile) {
            if (codeDirty) exportButton.click();
          } else workbench.parentElement?.querySelector<HTMLButtonElement>('.studio-zip-save')?.click();
        });
        activeEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
          workbench.parentElement?.querySelector<HTMLButtonElement>('.studio-code-run')?.click();
        });
        activeEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => search.focus());
        codeEditorCleanup = () => {
          modelChanges.dispose();
          activeEditor.dispose();
          if (monacoEditor === activeEditor) monacoEditor = null;
        };
        activeEditor.layout();
      })
      .catch(() => {
        replaceStatus.textContent = 'Monaco could not load; using the basic editor';
        if (!editorRow.contains(area)) editorRow.replaceChildren(gutter, surface);
        updateGutter();
      });
    return workbench;
  };

  const openZipGameEditor = async (index: number): Promise<void> => {
    const gameFile = files[index];
    if (!gameFile || !/\.zip$/i.test(gameFile.name)) return;
    const overlay = document.createElement('section');
    overlay.className = 'studio-composer-overlay studio-zip-editor-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', `Edit ${gameFile.name}`);
    overlay.innerHTML = `
      <header class="studio-composer-header">
        <div><b>Edit game source</b><small>${escapeHtml(gameFile.name)} · files remain in the isolated game sandbox</small></div>
        <div>
          <div class="studio-zip-new-source">
            <button class="studio-zip-new-file" type="button">＋ New file</button>
            <form class="studio-zip-new-source-form" hidden>
              <input class="studio-zip-new-source-path" type="text" aria-label="New source path" placeholder="scripts/new-file.js" autocomplete="off" spellcheck="false" required>
              <button type="submit">Create</button>
              <button class="studio-zip-new-source-cancel" type="button">Cancel</button>
            </form>
          </div>
          <button class="studio-zip-save" type="button" disabled>Save &amp; preview</button>
          <button class="studio-composer-close" type="button" aria-label="Close">×</button>
        </div>
      </header>
      <div class="studio-zip-editor-body">
        <div class="studio-zip-editor-status" aria-live="polite">Reading game files…</div>
        <div class="studio-zip-workbench">
          <nav class="studio-zip-source-explorer" aria-label="Game source files">
            <div class="studio-zip-source-tools">
              <div class="studio-zip-source-heading">EXPLORER</div>
              <button class="studio-zip-search-toggle" type="button" aria-label="Find in project" aria-expanded="false" title="Find in project">⌕</button>
            </div>
            <div class="studio-zip-search-panel" hidden>
              <div class="studio-zip-search-row">
                <input class="studio-zip-search-input" type="search" aria-label="Search project files" placeholder="Find in files" autocomplete="off" spellcheck="false">
                <button class="studio-zip-search-clear" type="button" aria-label="Clear file search">×</button>
              </div>
              <div class="studio-zip-search-status" aria-live="polite"></div>
            </div>
            <div class="studio-zip-source-list"></div>
          </nav>
          <div class="studio-zip-editor-host"></div>
        </div>
      </div>`;
    root.appendChild(overlay);
    const sourceList = overlay.querySelector<HTMLElement>('.studio-zip-source-list')!;
    const searchToggle = overlay.querySelector<HTMLButtonElement>('.studio-zip-search-toggle')!;
    const searchPanel = overlay.querySelector<HTMLElement>('.studio-zip-search-panel')!;
    const searchInput = overlay.querySelector<HTMLInputElement>('.studio-zip-search-input')!;
    const searchStatus = overlay.querySelector<HTMLElement>('.studio-zip-search-status')!;
    const editorHost = overlay.querySelector<HTMLElement>('.studio-zip-editor-host')!;
    const status = overlay.querySelector<HTMLElement>('.studio-zip-editor-status')!;
    const saveButton = overlay.querySelector<HTMLButtonElement>('.studio-zip-save')!;
    const addSourceButton = overlay.querySelector<HTMLButtonElement>('.studio-zip-new-file')!;
    const addSourceForm = overlay.querySelector<HTMLFormElement>('.studio-zip-new-source-form')!;
    const newSourcePathInput = overlay.querySelector<HTMLInputElement>('.studio-zip-new-source-path')!;
    const closeButton = overlay.querySelector<HTMLButtonElement>('.studio-composer-close')!;
    const drafts = new Map<string, string>();
    const createdPaths = new Set<string>();
    const collapsedDirectories = new Set<string>();
    let editorPaths = new Map<string, string>();
    let activeSourcePath: string | null = null;
    let dirty = false;
    let closed = false;
    const close = (): void => {
      if (dirty && !window.confirm('Discard unsaved game source edits?')) return;
      closed = true;
      codeEditorCleanup?.();
      codeEditorCleanup = null;
      overlay.remove();
    };
    closeButton.addEventListener('click', close);
    try {
      const {
        listEditableGameSources,
        searchEditableGameSources,
        updateEditableGameSources,
        validateEditableGameSourcePath,
      } = await import('../lib/editor/game-project.ts');
      const sources = await listEditableGameSources(gameFile);
      if (closed || destroyed || activeIndex !== index) return;
      if (sources.length === 0) {
        status.textContent = 'No editable HTML, CSS, JavaScript, JSON, or text source files were found.';
        overlay.querySelector<HTMLElement>('.studio-zip-workbench')!.hidden = true;
        return;
      }
      editorPaths = new Map(sources.map(({ path, source }) => [path, source]));
      for (const { path, source } of sources) {
        drafts.set(path, source);
      }

      type SourceTreeNode = { directories: Map<string, SourceTreeNode>; files: string[] };
      const renderSourceExplorer = (): void => {
        const query = searchInput.value.trim();
        sourceList.replaceChildren();
        if (query) {
          const matches = searchEditableGameSources(
            [...editorPaths].map(([path, source]) => ({ path, source: drafts.get(path) ?? source })),
            query,
          );
          searchStatus.textContent =
            matches.length === 200
              ? 'Showing up to 200 results'
              : `${matches.length} result${matches.length === 1 ? '' : 's'}`;
          for (const match of matches) {
            const result = document.createElement('button');
            result.type = 'button';
            result.className = 'studio-zip-search-result';
            result.dataset.path = match.path;
            result.dataset.line = String(match.line);
            result.setAttribute('aria-label', `${match.path}, line ${match.line}: ${match.preview}`);
            const location = document.createElement('span');
            location.className = 'studio-zip-search-location';
            location.textContent = `${match.path}:${match.line}`;
            const preview = document.createElement('span');
            preview.className = 'studio-zip-search-preview';
            preview.textContent = match.preview;
            result.appendChild(location);
            result.appendChild(preview);
            result.addEventListener('click', () => mountEditor(match.path, query));
            sourceList.appendChild(result);
          }
          return;
        }
        searchStatus.textContent = '';
        const tree: SourceTreeNode = { directories: new Map(), files: [] };
        for (const path of editorPaths.keys()) {
          const segments = path.split('/');
          let node = tree;
          for (const segment of segments.slice(0, -1)) {
            let child = node.directories.get(segment);
            if (!child) {
              child = { directories: new Map(), files: [] };
              node.directories.set(segment, child);
            }
            node = child;
          }
          node.files.push(path);
        }

        const appendNode = (container: HTMLElement, node: SourceTreeNode, prefix: string, depth: number): void => {
          for (const [name, child] of [...node.directories.entries()].sort(([left], [right]) =>
            left.localeCompare(right),
          )) {
            const path = prefix ? `${prefix}/${name}` : name;
            const expanded = !collapsedDirectories.has(path);
            const folder = document.createElement('button');
            folder.type = 'button';
            folder.className = 'studio-zip-source-folder';
            folder.dataset.path = path;
            folder.style.paddingInlineStart = `${10 + depth * 13}px`;
            folder.setAttribute('aria-expanded', String(expanded));
            folder.textContent = `${expanded ? '▾' : '▸'} ${name}`;
            folder.addEventListener('click', () => {
              if (expanded) collapsedDirectories.add(path);
              else collapsedDirectories.delete(path);
              renderSourceExplorer();
            });
            container.appendChild(folder);
            if (expanded) appendNode(container, child, path, depth + 1);
          }
          for (const path of node.files.sort((left, right) => left.localeCompare(right))) {
            const file = document.createElement('button');
            file.type = 'button';
            file.className = 'studio-zip-source-file';
            file.dataset.path = path;
            file.style.paddingInlineStart = `${10 + depth * 13}px`;
            file.textContent = `▤ ${path.split('/').at(-1) ?? path}`;
            file.title = path;
            file.setAttribute('aria-current', String(path === activeSourcePath));
            file.addEventListener('click', () => mountEditor(path));
            container.appendChild(file);
          }
        };

        appendNode(sourceList, tree, '', 0);
      };

      function mountEditor(path: string, initialSearch?: string): void {
        if (!editorPaths.has(path)) return;
        codeEditorCleanup?.();
        codeEditorCleanup = null;
        activeSourcePath = path;
        editorText = drafts.get(path) ?? editorPaths.get(path) ?? '';
        editorHost.replaceChildren();
        const editor = createCodeEditor(
          editorText,
          path,
          () => {
            drafts.set(path, editorText);
            dirty = true;
            saveButton.disabled = !dirty;
            status.textContent = `Unsaved · ${path}`;
            if (searchInput.value.trim()) renderSourceExplorer();
          },
          false,
          initialSearch,
        );
        editorHost.appendChild(editor);
        status.textContent = path;
        renderSourceExplorer();
      }

      searchToggle.addEventListener('click', () => {
        const opening = searchPanel.hidden;
        searchPanel.hidden = !opening;
        searchToggle.setAttribute('aria-expanded', String(opening));
        if (opening) searchInput.focus();
        else searchInput.value = '';
        renderSourceExplorer();
      });
      searchInput.addEventListener('input', renderSourceExplorer);
      overlay.querySelector<HTMLButtonElement>('.studio-zip-search-clear')!.addEventListener('click', () => {
        searchInput.value = '';
        renderSourceExplorer();
        searchInput.focus();
      });
      searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') searchToggle.click();
      });

      addSourceButton.addEventListener('click', () => {
        addSourceForm.hidden = false;
        newSourcePathInput.focus();
      });
      overlay.querySelector<HTMLButtonElement>('.studio-zip-new-source-cancel')!.addEventListener('click', () => {
        addSourceForm.hidden = true;
        newSourcePathInput.value = '';
      });
      addSourceForm.addEventListener('submit', (event) => {
        event.preventDefault();
        try {
          const path = validateEditableGameSourcePath(newSourcePathInput.value);
          if ([...editorPaths.keys()].some((existingPath) => existingPath.toLowerCase() === path.toLowerCase())) {
            status.textContent = `A source file named ${path} already exists.`;
            return;
          }
          createdPaths.add(path);
          editorPaths.set(path, '');
          drafts.set(path, '');
          renderSourceExplorer();
          mountEditor(path);
          addSourceForm.hidden = true;
          newSourcePathInput.value = '';
          dirty = true;
          saveButton.disabled = false;
          status.textContent = `New file · ${path}`;
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : 'Could not create this source file';
        }
      });
      mountEditor(sources[0].path);
      saveButton.addEventListener('click', async () => {
        if (!dirty || saveButton.disabled) return;
        saveButton.disabled = true;
        status.textContent = 'Updating game package…';
        try {
          const updated = await updateEditableGameSources(gameFile, drafts, createdPaths);
          if (closed || destroyed || activeIndex !== index) return;
          files[index] = updated;
          dirty = false;
          codeEditorCleanup?.();
          codeEditorCleanup = null;
          closed = true;
          overlay.remove();
          saveState.textContent = 'Game source saved locally';
          interacted = true;
          scheduleAutosave();
          render();
          select(index);
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : 'Could not update game package';
          saveButton.disabled = false;
        }
      });
    } catch (error) {
      if (!closed) status.textContent = error instanceof Error ? error.message : 'Could not read game package';
    }
  };

  const createStudioConsolePanel = (): { element: HTMLDetailsElement; write: (entry: StudioConsoleEntry) => void } => {
    const consolePanel = document.createElement('details');
    consolePanel.className = 'studio-code-console';
    consolePanel.open = true;
    consolePanel.style.cssText =
      'width:100%;box-sizing:border-box;border:1px solid var(--studio-border);border-radius:5px;background:#101116;color:var(--studio-text);font:11px ui-monospace,SFMono-Regular,Menlo,monospace';
    const summary = document.createElement('summary');
    summary.style.cssText = 'padding:7px 9px;color:var(--studio-muted);cursor:pointer';
    const count = document.createElement('span');
    count.textContent = 'Console · 0';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Clear';
    clear.style.cssText =
      'float:right;border:0;background:transparent;color:var(--studio-muted);font:inherit;cursor:pointer';
    const lines = document.createElement('div');
    lines.className = 'studio-code-console-lines';
    lines.setAttribute('aria-live', 'polite');
    lines.style.cssText = 'max-height:130px;overflow:auto;border-top:1px solid var(--studio-border)';
    summary.appendChild(count);
    summary.appendChild(clear);
    consolePanel.appendChild(summary);
    consolePanel.appendChild(lines);
    let entryCount = 0;
    clear.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      entryCount = 0;
      count.textContent = 'Console · 0';
      lines.replaceChildren();
    });
    const write = (entry: StudioConsoleEntry): void => {
      if (entryCount >= 100) return;
      entryCount++;
      count.textContent = `Console · ${entryCount}`;
      const line = document.createElement('div');
      const level = entry.level;
      line.textContent = `${level === 'error' ? '✕' : level === 'warn' ? '⚠' : '›'} ${entry.text}`;
      line.style.cssText = `padding:4px 9px;border-bottom:1px solid #25272e;white-space:pre-wrap;overflow-wrap:anywhere;color:${level === 'error' ? '#ff8e8e' : level === 'warn' ? '#f3ce76' : '#c9ced8'}`;
      lines.appendChild(line);
    };
    return { element: consolePanel, write };
  };

  const createSandboxPreview = (fileName: string, page: string, frameClass = 'studio-code-preview'): HTMLElement => {
    const output = document.createElement('div');
    output.className = 'studio-code-run-output';
    output.style.cssText = 'display:flex;flex-direction:column;gap:8px;width:100%';
    const frame = document.createElement('iframe');
    frame.className = frameClass;
    frame.title = `${fileName} sandbox preview`;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    const consolePanel = createStudioConsolePanel();
    output.appendChild(frame);
    output.appendChild(consolePanel.element);
    const channel = new MessageChannel();
    const dispose = (): void => {
      channel.port1.onmessage = null;
      channel.port1.close();
      activeSandboxPreviewDisposers.delete(dispose);
    };
    activeSandboxPreviewDisposers.add(dispose);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const message = parseStudioConsoleEntry(event.data);
      if (message) consolePanel.write(message);
    };
    channel.port1.start();
    frame.addEventListener(
      'load',
      () => frame.contentWindow?.postMessage(STUDIO_CONSOLE_CONNECT_MESSAGE, '*', [channel.port2]),
      { once: true },
    );
    frame.srcdoc = injectStudioConsoleBridge(page);
    return output;
  };

  const createCodePreview = (fileName: string, source: string): HTMLElement => {
    const extension = fileName.toLowerCase().split('.').pop();
    const page =
      extension === 'css'
        ? `<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;padding:24px;color:#222}.preview-card{padding:24px;border:1px solid #aaa;border-radius:12px;max-width:480px}</style><style>${source.replace(/<\/style/gi, '<\\/style')}</style><main class="preview-card"><h1>CSS preview</h1><p>Edit this stylesheet and run again.</p><button>Sample button</button></main>`
        : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body><main id="app"></main><script>${source.replace(/<\/script/gi, '<\\/script')}</script></body>`;
    return createSandboxPreview(fileName, page);
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
    overlay.innerHTML = `<header class="studio-composer-header"><div><b>Image composition</b><small>Drag to move · drag lower-right handle to resize · Shift keeps ratio · Arrow keys nudge</small></div><div><button class="studio-composer-export" type="button">Export PNG</button><button class="studio-composer-close" type="button" aria-label="Close">×</button></div></header><div class="studio-composer-preview-controls"><label><input class="studio-composer-preview-timing" type="checkbox"> Preview video timing</label><label>Time <input class="studio-composer-preview-time" type="range" min="0" max="180" step="0.1" value="${Math.min(180, timelinePlayheadTime).toFixed(1)}"><output>${Math.min(180, timelinePlayheadTime).toFixed(1)}s</output></label></div><div class="studio-composer-layout"><div class="studio-composer-board"><div class="studio-composer-tools" role="toolbar" aria-label="Image drawing tools"><button class="studio-composer-tool active" data-tool="select" type="button" aria-pressed="true">↖ Select</button><button class="studio-composer-tool" data-tool="brush" type="button" aria-pressed="false">✎ Brush</button><button class="studio-composer-tool" data-tool="eraser" type="button" aria-pressed="false">⌫ Eraser</button><label>Color <input class="studio-composer-brush-color" type="color" value="#ff4f81"></label><label>Size <input class="studio-composer-brush-size" type="range" min="1" max="120" value="24"><output>24 px</output></label></div><div class="studio-composer-canvas-wrap"><canvas class="studio-composer-canvas" width="1080" height="1080" tabindex="0" aria-label="Layer composition canvas"></canvas></div><div class="studio-composer-status" aria-live="polite"></div></div><aside class="studio-composer-panel"><div class="studio-composer-section"><div class="studio-composer-title">IMAGE ASSETS</div><div class="studio-composer-assets"></div></div><div class="studio-composer-section"><div class="studio-composer-title">LAYERS <span class="studio-composer-title-actions"><button class="studio-composer-add-paint" type="button">＋ Paint</button><button class="studio-composer-add-text" type="button">＋ Text</button></span><span class="studio-composer-count"></span></div><div class="studio-composer-layers"></div></div><div class="studio-composer-properties"></div></aside></div>`;
    root.appendChild(overlay);
    imageComposerOverlay = overlay;
    const canvas = overlay.querySelector<HTMLCanvasElement>('.studio-composer-canvas')!;
    const context = canvas.getContext('2d');
    const layerList = overlay.querySelector<HTMLElement>('.studio-composer-layers')!;
    const assetList = overlay.querySelector<HTMLElement>('.studio-composer-assets')!;
    const properties = overlay.querySelector<HTMLElement>('.studio-composer-properties')!;
    const status = overlay.querySelector<HTMLElement>('.studio-composer-status')!;
    const timingPreviewToggle = overlay.querySelector<HTMLInputElement>('.studio-composer-preview-timing')!;
    const timingPreviewInput = overlay.querySelector<HTMLInputElement>('.studio-composer-preview-time')!;
    const timingPreviewOutput = overlay.querySelector<HTMLOutputElement>('.studio-composer-preview-controls output')!;
    const brushColorInput = overlay.querySelector<HTMLInputElement>('.studio-composer-brush-color')!;
    const brushSizeInput = overlay.querySelector<HTMLInputElement>('.studio-composer-brush-size')!;
    const paintSurfaces = new Map<string, HTMLCanvasElement>();
    const paintSaveRevisions = new Map<string, number>();
    const bitmaps = new Map<number, Promise<ImageBitmap>>();
    let activeTool: 'select' | 'brush' | 'eraser' = 'select';
    let paintStroke: { pointerId: number; layerId: string; lastPoint: { x: number; y: number } } | null = null;
    let drag: {
      id: string;
      mode: 'move' | 'resize';
      dx: number;
      dy: number;
      startX: number;
      startY: number;
      startWidth: number;
      startHeight: number;
    } | null = null;
    const close = (): void => {
      imageDrawRevision++;
      for (const bitmapPromise of bitmaps.values()) {
        void bitmapPromise.then((bitmap) => bitmap.close()).catch(() => undefined);
      }
      bitmaps.clear();
      paintSurfaces.clear();
      overlay.remove();
      imageComposerOverlay = null;
      renderVideoTimeline();
    };
    overlay.querySelector<HTMLButtonElement>('.studio-composer-close')!.addEventListener('click', close);
    overlay.addEventListener('keydown', (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target) return;
      const editingField = target.closest('input, textarea, select, [contenteditable="true"]');
      if (event.key === 'Escape' && !editingField) {
        event.preventDefault();
        close();
        return;
      }
      if (editingField) return;
      const keyboardSurface =
        target === overlay || target === canvas || target.closest('.studio-composer-layer-select');
      if (!keyboardSurface) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const removeButton = properties.querySelector<HTMLButtonElement>('.studio-composer-remove');
        if (removeButton) {
          event.preventDefault();
          removeButton.click();
        }
        return;
      }
      if (activeTool !== 'select') return;
      const offsets: Record<string, { x: number; y: number }> = {
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
      };
      const offset = offsets[event.key];
      if (!offset) return;
      event.preventDefault();
      const layer = imageLayers.find((item) => item.id === selectedImageLayerId);
      if (!layer || layer.positionLocked) return;
      if (!nudgeImageLayerPosition(layer, offset.x, offset.y, event.shiftKey ? 10 : 1)) return;
      const x = properties.querySelector<HTMLInputElement>('[data-prop="x"]');
      const y = properties.querySelector<HTMLInputElement>('[data-prop="y"]');
      if (x) x.value = String(Math.round(layer.x));
      if (y) y.value = String(Math.round(layer.y));
      void draw();
      scheduleAutosave();
    });
    canvas.focus({ preventScroll: true });

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
    const setComposerTool = (tool: 'select' | 'brush' | 'eraser'): void => {
      activeTool = tool;
      overlay.querySelectorAll<HTMLButtonElement>('.studio-composer-tool').forEach((button) => {
        const selected = button.dataset.tool === tool;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      canvas.style.cursor = tool === 'select' ? 'move' : 'crosshair';
      void draw(tool === 'select');
    };
    const getPaintSurface = async (layer: StudioImageLayer): Promise<HTMLCanvasElement> => {
      const existing = paintSurfaces.get(layer.id);
      if (existing) return existing;
      if (layer.kind !== 'image' || layer.paintLayer !== true) throw new Error('Select a paint layer first');
      const bitmap = await getBitmap(layer.fileIndex);
      const surface = document.createElement('canvas');
      surface.width = canvas.width;
      surface.height = canvas.height;
      const paintContext = surface.getContext('2d');
      if (!paintContext) throw new Error('Could not open this paint layer');
      paintContext.drawImage(bitmap, 0, 0, surface.width, surface.height);
      paintSurfaces.set(layer.id, surface);
      return surface;
    };
    const canvasToPngFile = (surface: HTMLCanvasElement, name: string): Promise<File> =>
      new Promise((resolve, reject) => {
        surface.toBlob((blob) => {
          if (!blob) {
            reject(new Error('Could not save this paint layer'));
            return;
          }
          resolve(new File([blob], name, { type: 'image/png', lastModified: Date.now() }));
        }, 'image/png');
      });
    const persistPaintSurface = async (layer: StudioImageLayer): Promise<void> => {
      const surface = paintSurfaces.get(layer.id);
      const file = files[layer.fileIndex];
      if (!surface || !file) return;
      const revision = (paintSaveRevisions.get(layer.id) ?? 0) + 1;
      paintSaveRevisions.set(layer.id, revision);
      try {
        const savedFile = await canvasToPngFile(surface, file.name);
        if (paintSaveRevisions.get(layer.id) !== revision) return;
        files[layer.fileIndex] = savedFile;
        const staleBitmap = bitmaps.get(layer.fileIndex);
        if (staleBitmap) void staleBitmap.then((bitmap) => bitmap.close()).catch(() => undefined);
        bitmaps.delete(layer.fileIndex);
        renderLayers();
        scheduleAutosave();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Could not save this paint layer';
      }
    };
    const paintAt = (
      layer: StudioImageLayer,
      from: { x: number; y: number },
      to: { x: number; y: number },
      tool: 'brush' | 'eraser',
    ): void => {
      const surface = paintSurfaces.get(layer.id);
      const paintContext = surface?.getContext('2d');
      if (!surface || !paintContext) return;
      const sourcePosition = (point: { x: number; y: number }): { x: number; y: number } => {
        const dx = point.x - (layer.x + layer.width / 2);
        const dy = point.y - (layer.y + layer.height / 2);
        const angle = (-layer.rotation * Math.PI) / 180;
        const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
        const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
        const cropX = layer.cropX ?? 0;
        const cropY = layer.cropY ?? 0;
        const cropWidth = layer.cropWidth ?? 1;
        const cropHeight = layer.cropHeight ?? 1;
        return {
          x: (cropX + (localX / layer.width + 0.5) * cropWidth) * surface.width,
          y: (cropY + (localY / layer.height + 0.5) * cropHeight) * surface.height,
        };
      };
      const sourceFrom = sourcePosition(from);
      const sourceTo = sourcePosition(to);
      paintContext.save();
      paintContext.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
      paintContext.strokeStyle = brushColorInput.value;
      paintContext.fillStyle = brushColorInput.value;
      paintContext.lineWidth = (Number(brushSizeInput.value) * surface.width * (layer.cropWidth ?? 1)) / layer.width;
      paintContext.lineCap = 'round';
      paintContext.lineJoin = 'round';
      paintContext.beginPath();
      paintContext.moveTo(sourceFrom.x, sourceFrom.y);
      paintContext.lineTo(sourceTo.x, sourceTo.y);
      paintContext.stroke();
      if (sourceFrom.x === sourceTo.x && sourceFrom.y === sourceTo.y) {
        paintContext.beginPath();
        paintContext.arc(sourceTo.x, sourceTo.y, paintContext.lineWidth / 2, 0, Math.PI * 2);
        paintContext.fill();
      }
      paintContext.restore();
    };
    const currentPreviewTime = (): number | null =>
      timingPreviewToggle.checked ? Number(timingPreviewInput.value) : null;
    const previewDuration = (): number =>
      Math.max(
        0,
        ...videoClips.map((clip) => clip.start + videoClipTimelineDuration(clip)),
        ...imageLayers.map((layer) => layer.end ?? 0),
      ) || 180;
    const isLayerVisibleAt = (layer: StudioImageLayer, time: number | null): boolean =>
      layer.visible && (time === null || (time >= (layer.start ?? 0) && time < (layer.end ?? Infinity)));
    const draw = async (withSelection = true, previewTime: number | null = currentPreviewTime()): Promise<void> => {
      const revision = ++imageDrawRevision;
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      status.textContent = '';
      try {
        for (const layer of imageLayers) {
          if (!isLayerVisibleAt(layer, previewTime)) continue;
          const layerOpacity =
            previewTime === null ? layer.opacity : imageLayerOpacityAt(layer, previewTime, previewDuration());
          const bitmap =
            layer.kind === 'image' ? (paintSurfaces.get(layer.id) ?? (await getBitmap(layer.fileIndex))) : null;
          if (revision !== imageDrawRevision) return;
          drawStudioImageLayer(context, layer, bitmap, { opacity: layerOpacity });
        }
        const selected =
          withSelection &&
          imageLayers.find((layer) => layer.id === selectedImageLayerId && isLayerVisibleAt(layer, previewTime));
        if (selected) {
          context.save();
          context.translate(selected.x + selected.width / 2, selected.y + selected.height / 2);
          context.rotate((selected.rotation * Math.PI) / 180);
          context.strokeStyle = '#b8ef6a';
          context.lineWidth = 2;
          context.setLineDash([8, 5]);
          context.strokeRect(-selected.width / 2, -selected.height / 2, selected.width, selected.height);
          context.setLineDash([]);
          if (!selected.positionLocked) {
            context.fillStyle = '#b8ef6a';
            context.fillRect(selected.width / 2 - 7, selected.height / 2 - 7, 14, 14);
          }
          context.restore();
        }
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Could not load this image';
      }
    };
    timingPreviewInput.addEventListener('input', () => {
      const time = Math.max(0, Math.min(180, Number(timingPreviewInput.value) || 0));
      timingPreviewOutput.textContent = `${time.toFixed(1)}s`;
      updateTimelinePlayhead(time);
      if (timingPreviewToggle.checked) void draw();
    });
    timingPreviewToggle.addEventListener('change', () => {
      if (timingPreviewToggle.checked) updateTimelinePlayhead(Number(timingPreviewInput.value));
      void draw();
    });
    const selectLayer = (layerId: string): void => {
      if (activeTool !== 'select') setComposerTool('select');
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
      const paintControls = layer.paintLayer
        ? '<p>Choose Brush or Eraser above the canvas to draw on this transparent layer.</p>'
        : '';
      const textControls =
        layer.kind === 'text'
          ? `<label class="studio-composer-text-label">Text<textarea data-prop="text" maxlength="2000">${escapeHtml(layer.text ?? '')}</textarea></label><label class="studio-composer-field">Color<input data-prop="color" type="color" value="${layer.color ?? '#ffffff'}"></label><label class="studio-composer-field">Font size<input data-prop="fontSize" type="number" min="8" max="256" value="${layer.fontSize ?? 72}"></label><label class="studio-composer-field">Font<select data-prop="fontFamily"><option value="sans-serif" ${(layer.fontFamily ?? 'sans-serif') === 'sans-serif' ? 'selected' : ''}>Sans serif</option><option value="serif" ${layer.fontFamily === 'serif' ? 'selected' : ''}>Serif</option><option value="monospace" ${layer.fontFamily === 'monospace' ? 'selected' : ''}>Monospace</option></select></label>`
          : '';
      const adjustmentControls =
        layer.kind === 'image'
          ? `<div class="studio-composer-title">IMAGE ADJUSTMENTS</div><label class="studio-composer-range">Brightness <output data-value="brightness">${Math.round(layer.brightness ?? 100)}%</output><input data-prop="brightness" type="range" min="0" max="200" value="${Math.round(layer.brightness ?? 100)}"></label><label class="studio-composer-range">Contrast <output data-value="contrast">${Math.round(layer.contrast ?? 100)}%</output><input data-prop="contrast" type="range" min="0" max="200" value="${Math.round(layer.contrast ?? 100)}"></label><label class="studio-composer-range">Saturation <output data-value="saturation">${Math.round(layer.saturation ?? 100)}%</output><input data-prop="saturation" type="range" min="0" max="200" value="${Math.round(layer.saturation ?? 100)}"></label><label class="studio-composer-range">Hue <output data-value="hueDeg">${Math.round(layer.hueDeg ?? 0)}°</output><input data-prop="hueDeg" type="range" min="-180" max="180" value="${Math.round(layer.hueDeg ?? 0)}"></label><label class="studio-composer-range">Blur <output data-value="blurPx">${(layer.blurPx ?? 0).toFixed(1)} px</output><input data-prop="blurPx" type="range" min="0" max="30" step="0.5" value="${(layer.blurPx ?? 0).toFixed(1)}"></label>`
          : '';
      const cropControls =
        layer.kind === 'image'
          ? `<div class="studio-composer-title">SOURCE CROP</div><label class="studio-composer-range">Left <output data-value="cropX">${Math.round((layer.cropX ?? 0) * 100)}%</output><input data-prop="cropX" type="range" min="0" max="99" value="${Math.round((layer.cropX ?? 0) * 100)}"></label><label class="studio-composer-range">Top <output data-value="cropY">${Math.round((layer.cropY ?? 0) * 100)}%</output><input data-prop="cropY" type="range" min="0" max="99" value="${Math.round((layer.cropY ?? 0) * 100)}"></label><label class="studio-composer-range">Width <output data-value="cropWidth">${Math.round((layer.cropWidth ?? 1) * 100)}%</output><input data-prop="cropWidth" type="range" min="1" max="100" value="${Math.round((layer.cropWidth ?? 1) * 100)}"></label><label class="studio-composer-range">Height <output data-value="cropHeight">${Math.round((layer.cropHeight ?? 1) * 100)}%</output><input data-prop="cropHeight" type="range" min="1" max="100" value="${Math.round((layer.cropHeight ?? 1) * 100)}"></label>`
          : '';
      const timingControls = `<div class="studio-composer-title">VIDEO TIMING</div><label class="studio-composer-field">Start (s)<input data-prop="startTime" type="number" min="0" max="14399.9" step="0.1" value="${(layer.start ?? 0).toFixed(1)}"></label><label class="studio-composer-field">End (s)<input data-prop="endTime" type="number" min="0.1" max="14400" step="0.1" placeholder="Video end" value="${layer.end === undefined ? '' : layer.end.toFixed(1)}"></label><label class="studio-composer-field">Fade in (s)<input data-prop="fadeIn" type="number" min="0" max="30" step="0.1" value="${(layer.fadeIn ?? 0).toFixed(1)}"></label><label class="studio-composer-field">Fade out (s)<input data-prop="fadeOut" type="number" min="0" max="30" step="0.1" value="${(layer.fadeOut ?? 0).toFixed(1)}"></label><div class="studio-composer-order"><button class="studio-composer-start-playhead" type="button">Start at playhead</button><button class="studio-composer-end-playhead" type="button">End at playhead</button></div>`;
      properties.innerHTML = `${paintControls}<div class="studio-composer-title">TRANSFORM</div><div class="studio-composer-layer-name">${escapeHtml(layerName)}</div>${textControls}${adjustmentControls}${cropControls}${timingControls}<div class="studio-composer-grid"><label>X<input data-prop="x" type="number" value="${Math.round(layer.x)}"></label><label>Y<input data-prop="y" type="number" value="${Math.round(layer.y)}"></label><label>Width<input data-prop="width" type="number" min="1" max="4096" value="${Math.round(layer.width)}"></label><label>Height<input data-prop="height" type="number" min="1" max="4096" value="${Math.round(layer.height)}"></label></div><label class="studio-composer-range">Opacity <output data-value="opacity">${Math.round(layer.opacity * 100)}%</output><input data-prop="opacity" type="range" min="0" max="100" value="${Math.round(layer.opacity * 100)}"></label><label class="studio-composer-field">Rotation<input data-prop="rotation" type="number" min="-360" max="360" value="${Math.round(layer.rotation)}">°</label><label class="studio-composer-field">Blend mode<select data-prop="blend">${STUDIO_IMAGE_BLEND_MODES.map((mode) => `<option value="${mode}" ${layer.blend === mode ? 'selected' : ''}>${mode === 'normal' ? 'Normal' : mode.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())}</option>`).join('')}</select></label><div class="studio-composer-order"><button class="studio-composer-down" type="button">Send backward</button><button class="studio-composer-up" type="button">Bring forward</button></div><button class="studio-composer-remove" type="button">Remove layer</button>`;
      if (layer.positionLocked) {
        properties
          .querySelectorAll<HTMLInputElement>(
            'input[data-prop="x"],input[data-prop="y"],input[data-prop="width"],input[data-prop="height"],input[data-prop="rotation"]',
          )
          .forEach((input) => {
            input.disabled = true;
          });
      }
      const updateProperty = (property: string, value: string): void => {
        if (layer.positionLocked && ['x', 'y', 'width', 'height', 'rotation'].includes(property)) return;
        if (property === 'blend') layer.blend = value as StudioImageLayer['blend'];
        else if (property === 'opacity') {
          layer.opacity = Number(value) / 100;
          properties.querySelector('[data-value="opacity"]')!.textContent = `${value}%`;
        } else if (property === 'brightness' || property === 'contrast' || property === 'saturation') {
          const adjustment = Math.max(0, Math.min(200, Number(value) || 0));
          layer[property] = adjustment;
          properties.querySelector(`[data-value="${property}"]`)!.textContent = `${adjustment}%`;
        } else if (property === 'hueDeg') {
          layer.hueDeg = Math.max(-180, Math.min(180, Number(value) || 0));
          properties.querySelector('[data-value="hueDeg"]')!.textContent = `${Math.round(layer.hueDeg)}°`;
        } else if (property === 'blurPx') {
          layer.blurPx = Math.max(0, Math.min(30, Number(value) || 0));
          properties.querySelector('[data-value="blurPx"]')!.textContent = `${layer.blurPx.toFixed(1)} px`;
        } else if (property === 'cropX' || property === 'cropY') {
          const crop = Math.max(0, Math.min(0.99, (Number(value) || 0) / 100));
          if (property === 'cropX') {
            layer.cropX = crop;
            layer.cropWidth = Math.max(0.01, Math.min(layer.cropWidth ?? 1, 1 - crop));
          } else {
            layer.cropY = crop;
            layer.cropHeight = Math.max(0.01, Math.min(layer.cropHeight ?? 1, 1 - crop));
          }
        } else if (property === 'cropWidth' || property === 'cropHeight') {
          const offset = property === 'cropWidth' ? (layer.cropX ?? 0) : (layer.cropY ?? 0);
          const crop = Math.max(0.01, Math.min(1 - offset, (Number(value) || 1) / 100));
          layer[property] = crop;
        } else if (property === 'startTime') {
          layer.start = Math.max(0, Math.min(14_399.9, Number(value) || 0));
          if (layer.end !== undefined && layer.end <= layer.start) layer.end = Math.min(14_400, layer.start + 0.1);
        } else if (property === 'endTime') {
          if (value.trim() === '') delete layer.end;
          else layer.end = Math.max((layer.start ?? 0) + 0.1, Math.min(14_400, Number(value) || 0));
        } else if (property === 'fadeIn' || property === 'fadeOut') {
          layer[property] = Math.max(0, Math.min(30, Number(value) || 0));
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
        for (const cropProperty of ['cropX', 'cropY', 'cropWidth', 'cropHeight'] as const) {
          const control = properties.querySelector<HTMLInputElement>(`input[data-prop="${cropProperty}"]`);
          if (!control) continue;
          const cropValue =
            layer[cropProperty] ?? (cropProperty === 'cropWidth' || cropProperty === 'cropHeight' ? 1 : 0);
          const offset =
            cropProperty === 'cropWidth' ? (layer.cropX ?? 0) : cropProperty === 'cropHeight' ? (layer.cropY ?? 0) : 0;
          control.max =
            cropProperty === 'cropX' || cropProperty === 'cropY' ? '99' : String(Math.round((1 - offset) * 100));
          control.value = String(Math.round(cropValue * 100));
          properties.querySelector(`[data-value="${cropProperty}"]`)!.textContent = `${control.value}%`;
        }
        const startControl = properties.querySelector<HTMLInputElement>('input[data-prop="startTime"]')!;
        const endControl = properties.querySelector<HTMLInputElement>('input[data-prop="endTime"]')!;
        startControl.value = (layer.start ?? 0).toFixed(1);
        endControl.value = layer.end === undefined ? '' : layer.end.toFixed(1);
        properties.querySelector<HTMLInputElement>('input[data-prop="fadeIn"]')!.value = (layer.fadeIn ?? 0).toFixed(1);
        properties.querySelector<HTMLInputElement>('input[data-prop="fadeOut"]')!.value = (layer.fadeOut ?? 0).toFixed(
          1,
        );
        renderLayers();
        void draw();
        scheduleAutosave();
      };
      properties.querySelectorAll<HTMLInputElement>('input[data-prop]').forEach((control) => {
        control.addEventListener('input', () => updateProperty(control.dataset.prop ?? '', control.value));
      });
      properties.querySelector<HTMLButtonElement>('.studio-composer-start-playhead')!.addEventListener('click', () => {
        updateProperty('startTime', String(Math.round(timelinePlayheadTime * 10) / 10));
      });
      properties.querySelector<HTMLButtonElement>('.studio-composer-end-playhead')!.addEventListener('click', () => {
        if (timelinePlayheadTime <= (layer.start ?? 0)) {
          status.textContent = 'Move the playhead after this layer’s start to set its end.';
          return;
        }
        status.textContent = '';
        updateProperty('endTime', String(Math.round(timelinePlayheadTime * 10) / 10));
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
            : `${layer.paintLayer ? 'Paint: ' : ''}${files[layer.fileIndex]?.name ?? 'Image layer'}`;
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
        const positionLock = document.createElement('button');
        positionLock.type = 'button';
        positionLock.className = 'studio-composer-position-lock';
        positionLock.textContent = layer.positionLocked ? '🔒' : '🔓';
        positionLock.title = layer.positionLocked ? 'Unlock position' : 'Lock position';
        positionLock.setAttribute('aria-label', positionLock.title);
        positionLock.setAttribute('aria-pressed', String(layer.positionLocked === true));
        positionLock.addEventListener('click', () => {
          layer.positionLocked = !layer.positionLocked;
          renderLayers();
          renderProperties();
          void draw();
          scheduleAutosave();
        });
        row.appendChild(name);
        row.appendChild(visibility);
        row.appendChild(positionLock);
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
          brightness: 100,
          contrast: 100,
          saturation: 100,
          hueDeg: 0,
          blurPx: 0,
          cropX: 0,
          cropY: 0,
          cropWidth: 1,
          cropHeight: 1,
          start: 0,
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
    overlay.querySelector<HTMLButtonElement>('.studio-composer-add-paint')!.addEventListener('click', async () => {
      if (imageLayers.length >= 32) {
        status.textContent = 'A composition can have up to 32 layers';
        return;
      }
      const surface = document.createElement('canvas');
      surface.width = canvas.width;
      surface.height = canvas.height;
      const paintNumber = imageLayers.filter((layer) => layer.paintLayer).length + 1;
      const file = await canvasToPngFile(surface, `Paint layer ${paintNumber}.png`).catch((error: unknown) => {
        status.textContent = error instanceof Error ? error.message : 'Could not create a paint layer';
        return null;
      });
      if (!file) return;
      const fileIndex = files.push(file) - 1;
      const layer: StudioImageLayer = {
        id: crypto.randomUUID(),
        kind: 'image',
        fileIndex,
        x: 0,
        y: 0,
        width: canvas.width,
        height: canvas.height,
        rotation: 0,
        opacity: 1,
        brightness: 100,
        contrast: 100,
        saturation: 100,
        hueDeg: 0,
        blurPx: 0,
        cropX: 0,
        cropY: 0,
        cropWidth: 1,
        cropHeight: 1,
        start: 0,
        visible: true,
        blend: 'normal',
        paintLayer: true,
      };
      imageLayers.push(layer);
      paintSurfaces.set(layer.id, surface);
      selectedImageLayerId = layer.id;
      renderLayers();
      renderProperties();
      setComposerTool('brush');
      scheduleAutosave();
    });
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
        start: 0,
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
    const localPosition = (layer: StudioImageLayer, point: { x: number; y: number }): { x: number; y: number } => {
      const dx = point.x - (layer.x + layer.width / 2);
      const dy = point.y - (layer.y + layer.height / 2);
      const angle = (-layer.rotation * Math.PI) / 180;
      return { x: dx * Math.cos(angle) - dy * Math.sin(angle), y: dx * Math.sin(angle) + dy * Math.cos(angle) };
    };
    overlay.querySelectorAll<HTMLButtonElement>('.studio-composer-tool').forEach((button) => {
      button.addEventListener('click', () => {
        const tool = button.dataset.tool;
        if (tool === 'select') {
          setComposerTool('select');
          status.textContent = '';
          return;
        }
        if (tool !== 'brush' && tool !== 'eraser') return;
        const selected = imageLayers.find((layer) => layer.id === selectedImageLayerId);
        if (!selected || selected.kind !== 'image' || selected.paintLayer !== true) {
          status.textContent = 'Select or add a paint layer before drawing.';
          return;
        }
        status.textContent = 'Loading paint layer…';
        void getPaintSurface(selected)
          .then(() => {
            status.textContent = '';
            setComposerTool(tool);
          })
          .catch((error: unknown) => {
            status.textContent = error instanceof Error ? error.message : 'Could not open this paint layer';
          });
      });
    });
    brushSizeInput.addEventListener('input', () => {
      overlay.querySelector<HTMLOutputElement>('.studio-composer-tools output')!.textContent =
        `${brushSizeInput.value} px`;
    });
    canvas.addEventListener('pointerdown', (event) => {
      const point = pointerPosition(event);
      const previewTime = currentPreviewTime();
      if (activeTool !== 'select') {
        const selected = imageLayers.find(
          (layer) => layer.id === selectedImageLayerId && isLayerVisibleAt(layer, previewTime),
        );
        if (!selected || selected.kind !== 'image' || selected.paintLayer !== true || !paintSurfaces.has(selected.id)) {
          status.textContent = 'Select or add a visible paint layer before drawing.';
          return;
        }
        paintStroke = { pointerId: event.pointerId, layerId: selected.id, lastPoint: point };
        canvas.setPointerCapture(event.pointerId);
        paintAt(selected, point, point, activeTool);
        void draw(false, previewTime);
        event.preventDefault();
        return;
      }
      const selected = imageLayers.find(
        (layer) => layer.id === selectedImageLayerId && isLayerVisibleAt(layer, previewTime),
      );
      if (selected && !selected.positionLocked) {
        const local = localPosition(selected, point);
        if (Math.abs(local.x - selected.width / 2) <= 20 && Math.abs(local.y - selected.height / 2) <= 20) {
          drag = {
            id: selected.id,
            mode: 'resize',
            dx: point.x,
            dy: point.y,
            startX: selected.x,
            startY: selected.y,
            startWidth: selected.width,
            startHeight: selected.height,
          };
          canvas.setPointerCapture(event.pointerId);
          event.preventDefault();
          return;
        }
      }
      const hit = [...imageLayers].reverse().find((layer) => {
        const local = localPosition(layer, point);
        return (
          isLayerVisibleAt(layer, previewTime) &&
          Math.abs(local.x) <= layer.width / 2 &&
          Math.abs(local.y) <= layer.height / 2
        );
      });
      if (!hit) return;
      selectLayer(hit.id);
      if (hit.positionLocked) return;
      drag = {
        id: hit.id,
        mode: 'move',
        dx: point.x - hit.x,
        dy: point.y - hit.y,
        startX: hit.x,
        startY: hit.y,
        startWidth: hit.width,
        startHeight: hit.height,
      };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (paintStroke?.pointerId === event.pointerId) {
        const layer = imageLayers.find((item) => item.id === paintStroke?.layerId);
        if (!layer) return;
        const point = pointerPosition(event);
        paintAt(layer, paintStroke.lastPoint, point, activeTool === 'eraser' ? 'eraser' : 'brush');
        paintStroke.lastPoint = point;
        void draw(false);
        event.preventDefault();
        return;
      }
      if (!drag) {
        if (activeTool !== 'select') {
          canvas.style.cursor = 'crosshair';
          return;
        }
        const selected = imageLayers.find((layer) => layer.id === selectedImageLayerId && layer.visible);
        if (selected) {
          const local = localPosition(selected, pointerPosition(event));
          canvas.style.cursor = selected.positionLocked
            ? 'default'
            : Math.abs(local.x - selected.width / 2) <= 20 && Math.abs(local.y - selected.height / 2) <= 20
              ? 'nwse-resize'
              : 'move';
        }
        return;
      }
      const layer = imageLayers.find((item) => item.id === drag?.id);
      if (!layer) return;
      const point = pointerPosition(event);
      if (drag.mode === 'move') {
        layer.x = Math.round(point.x - drag.dx);
        layer.y = Math.round(point.y - drag.dy);
      } else {
        const local = localPosition(layer, point);
        const startLocal = localPosition(layer, { x: drag.dx, y: drag.dy });
        let width = Math.max(8, Math.min(4096, drag.startWidth + local.x - startLocal.x));
        let height = Math.max(8, Math.min(4096, drag.startHeight + local.y - startLocal.y));
        if (event.shiftKey) {
          const ratio = drag.startWidth / drag.startHeight;
          if (Math.abs(width - drag.startWidth) >= Math.abs(height - drag.startHeight))
            height = Math.max(8, Math.min(4096, width / ratio));
          else width = Math.max(8, Math.min(4096, height * ratio));
        }
        const radians = (layer.rotation * Math.PI) / 180;
        const fixedX =
          drag.startX +
          drag.startWidth / 2 -
          (Math.cos(radians) * drag.startWidth) / 2 +
          (Math.sin(radians) * drag.startHeight) / 2;
        const fixedY =
          drag.startY +
          drag.startHeight / 2 -
          (Math.sin(radians) * drag.startWidth) / 2 -
          (Math.cos(radians) * drag.startHeight) / 2;
        layer.width = Math.round(width);
        layer.height = Math.round(height);
        layer.x = Math.round(
          fixedX - layer.width / 2 + (Math.cos(radians) * layer.width) / 2 - (Math.sin(radians) * layer.height) / 2,
        );
        layer.y = Math.round(
          fixedY - layer.height / 2 + (Math.sin(radians) * layer.width) / 2 + (Math.cos(radians) * layer.height) / 2,
        );
      }
      const x = properties.querySelector<HTMLInputElement>('[data-prop="x"]');
      const y = properties.querySelector<HTMLInputElement>('[data-prop="y"]');
      const width = properties.querySelector<HTMLInputElement>('[data-prop="width"]');
      const height = properties.querySelector<HTMLInputElement>('[data-prop="height"]');
      if (x) x.value = String(layer.x);
      if (y) y.value = String(layer.y);
      if (width) width.value = String(Math.round(layer.width));
      if (height) height.value = String(Math.round(layer.height));
      void draw();
    });
    const finishPointer = (event: PointerEvent): void => {
      if (paintStroke?.pointerId === event.pointerId) {
        const layer = imageLayers.find((item) => item.id === paintStroke?.layerId);
        paintStroke = null;
        if (layer) void persistPaintSurface(layer);
      }
      if (!drag) return;
      drag = null;
      scheduleAutosave();
    };
    canvas.addEventListener('pointerup', finishPointer);
    canvas.addEventListener('pointercancel', finishPointer);
    const exportButton = overlay.querySelector<HTMLButtonElement>('.studio-composer-export')!;
    exportButton.addEventListener('click', async () => {
      if (imageLayers.length === 0) return;
      exportButton.disabled = true;
      await draw(false, null);
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
    audioRenderRevision++;
    selectedVideoClipId = null;
    selectedAudioClipId = null;
    soloAudioButton.disabled = true;
    const editingFile = files[activeIndex];
    if (
      codeDirty &&
      editingFile &&
      (kindOf(editingFile) === 'code' || (kindOf(editingFile) === 'game' && /\.html?$/i.test(editingFile.name)))
    ) {
      commitActiveEditorDraft();
      interacted = true;
      scheduleAutosave();
    }
    codeEditorCleanup?.();
    codeEditorCleanup = null;
    stopVideoSequence();
    clearUrl();
    htmlEditing = false;
    activeIndex = index;
    if (index >= 0 && index < files.length && !openTabs.includes(index)) openTabs.push(index);
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
      const peaks = audioPeaks.get(index);
      if (peaks) renderAudioWaveform(wave, peaks);
      else {
        wave.dataset.state = audioPeakTasks.has(index) ? 'loading' : 'unavailable';
        wave.setAttribute('aria-label', 'Audio waveform is being decoded');
        const task = audioPeakTasks.get(index);
        if (task) {
          void task
            .then(({ peaks: decodedPeaks }) => {
              if (activeIndex === index && wave.isConnected) renderAudioWaveform(wave, decodedPeaks);
            })
            .catch(() => {
              if (wave.isConnected) {
                wave.dataset.state = 'unavailable';
                wave.setAttribute('aria-label', 'Audio waveform unavailable');
              }
            });
        }
      }
      content.appendChild(wave);
      const audioName = document.createElement('div');
      audioName.className = 'studio-audio-name';
      audioName.textContent = file.name;
      content.appendChild(audioName);
    } else if (kind === 'code') {
      void file.text().then((text) => {
        if (destroyed || activeIndex !== index) return;
        editorText = text;
        const editor = createCodeEditor(text, file.name, () => scheduleAutosave(false));
        content.appendChild(editor);
        if (/\.(?:js|mjs|css)$/i.test(file.name)) {
          const run = document.createElement('button');
          run.type = 'button';
          run.className = 'studio-code-run';
          run.textContent = '▶ Run sandbox preview';
          const output = document.createElement('div');
          output.className = 'studio-code-output';
          run.addEventListener('click', () => {
            closeSandboxPreviews();
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
          content.appendChild(createSandboxPreview(file.name, html, 'studio-game-frame'));
        });
      } else if (/\.zip$/i.test(file.name)) {
        const zipStage = document.createElement('div');
        zipStage.style.cssText = 'position:relative;width:100%;height:46vh;min-height:250px';
        const status = document.createElement('div');
        status.className = 'studio-file-notice';
        status.textContent = 'Checking game package…';
        zipStage.appendChild(status);
        const consolePanel = createStudioConsolePanel();
        content.appendChild(zipStage);
        content.appendChild(consolePanel.element);
        void import('../lib/zip-executor.js')
          .then(({ previewZipFile }) =>
            previewZipFile(file, zipStage, { onConsoleEntry: (entry) => consolePanel.write(entry) }),
          )
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
      } else if (kind === 'game' && /\.zip$/i.test(file.name)) {
        void openZipGameEditor(index);
      } else if (kind === 'game' && /\.html?$/i.test(file.name)) {
        if (htmlEditing) {
          commitActiveEditorDraft();
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
          content.appendChild(createCodeEditor(html, file.name, () => scheduleAutosave(false)));
          preview.querySelector<HTMLButtonElement>('.studio-edit-button')!.textContent = 'Preview';
        });
      } else {
        button.disabled = true;
      }
    });
    preview.querySelector<HTMLButtonElement>('.studio-edit-button')!.textContent =
      kind === 'code' ? 'Save edits' : kind === 'game' && /\.zip$/i.test(file.name) ? 'Edit game source' : 'Edit';
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

  const openNewFileDialog = (): void => {
    if (!restoreFinished || destroyed) return;
    const overlay = document.createElement('div');
    overlay.className = 'studio-starter-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'studio-starter-title');
    overlay.innerHTML = `
      <form class="studio-starter-dialog">
        <header><div><h2 id="studio-starter-title">Create a source file</h2><p>Start a game or code file in this project.</p></div><button class="studio-starter-close" type="button" aria-label="Close">×</button></header>
        <label>Template<select class="studio-starter-template" name="template">${STUDIO_STARTER_TEMPLATES.map((template) => `<option value="${template.id}">${template.label} (${template.extension})</option>`).join('')}</select></label>
        <label>File name<input class="studio-starter-name" name="name" type="text" autocomplete="off" spellcheck="false" required></label>
        <p class="studio-starter-help">The selected extension is added automatically. HTML games open in Flaxia’s isolated preview.</p>
        <p class="studio-starter-error" role="alert" aria-live="polite"></p>
        <footer><button class="studio-starter-cancel" type="button">Cancel</button><button class="studio-starter-create" type="submit">Create file</button></footer>
      </form>`;
    root.appendChild(overlay);

    const form = overlay.querySelector<HTMLFormElement>('form')!;
    const templateSelect = overlay.querySelector('select')!;
    const nameInput = overlay.querySelector<HTMLInputElement>('.studio-starter-name')!;
    const errorMessage = overlay.querySelector<HTMLElement>('.studio-starter-error')!;
    const initialTemplate = STUDIO_STARTER_TEMPLATES[0];
    nameInput.value = initialTemplate.defaultName;
    let nameEdited = false;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      overlay.remove();
      newFileButton.focus();
    };
    overlay.querySelector<HTMLButtonElement>('.studio-starter-close')!.addEventListener('click', close);
    overlay.querySelector<HTMLButtonElement>('.studio-starter-cancel')!.addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
    nameInput.addEventListener('input', () => {
      nameEdited = true;
      errorMessage.textContent = '';
    });
    templateSelect.addEventListener('change', () => {
      errorMessage.textContent = '';
      if (!nameEdited) {
        const selected = STUDIO_STARTER_TEMPLATES.find((template) => template.id === templateSelect.value);
        if (selected) nameInput.value = selected.defaultName;
      }
    });
    let creating = false;
    const createButton = overlay.querySelector<HTMLButtonElement>('.studio-starter-create')!;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (creating) return;
      creating = true;
      createButton.disabled = true;
      createButton.textContent = 'Creating…';
      try {
        const templateId = templateSelect.value as StudioStarterTemplateId;
        const file = await createStudioStarterFile(templateId, nameInput.value);
        if (closed || destroyed) return;
        if (files.some((existing) => existing.name.toLowerCase() === file.name.toLowerCase())) {
          errorMessage.textContent = `A file named “${file.name}” already exists in this project.`;
          nameInput.focus();
          return;
        }
        close();
        addFiles([file]);
        if (kindOf(file) === 'game') {
          preview.querySelector<HTMLButtonElement>('.studio-edit-button')?.click();
        }
      } catch (error) {
        errorMessage.textContent = error instanceof Error ? error.message : 'Could not create this file';
        nameInput.focus();
      } finally {
        creating = false;
        if (!closed) {
          createButton.disabled = false;
          createButton.textContent = 'Create file';
        }
      }
    });
    nameInput.focus();
    nameInput.select();
  };

  const finishRestore = (project: {
    files: File[];
    audioClips: AudioTimelineClip[];
    videoClips: StudioVideoClip[];
    imageLayers: StudioImageLayer[];
    videoFormat: StudioVideoFormat;
  }): void => {
    if (!interacted && files.length === 0 && project.files.length > 0) {
      files = project.files;
      videoFormat = project.videoFormat;
      videoFormatInput.value = videoFormat;
      audioClips = project.audioClips.filter((clip) => clip.track < 8 && clip.fileIndex < files.length);
      videoClips = project.videoClips.filter((clip) => clip.fileIndex < files.length);
      rippleOverlappingVideoClips(videoClips);
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
    newFileButton.disabled = false;
    undoHistory.length = 0;
    redoHistory.length = 0;
    editHistoryBaseline = captureEditHistory();
    updateHistoryControls();
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
  newFileButton.addEventListener('click', openNewFileDialog);
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
      if (codeHistoryTimer) clearTimeout(codeHistoryTimer);
      codeHistoryTimer = null;
      pendingEditorDraftFile = null;
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
      videoFormat = restored.videoFormat;
      videoFormatInput.value = videoFormat;
      rippleOverlappingVideoClips(videoClips);
      imageLayers = restored.imageLayers;
      openTabs = [];
      selectedImageLayerId = imageLayers.at(-1)?.id ?? null;
      audioTrackCount = Math.max(1, ...audioClips.map((clip) => clip.track + 1));
      activeIndex = -1;
      codeDirty = false;
      interacted = true;
      undoHistory.length = 0;
      redoHistory.length = 0;
      editHistoryBaseline = captureEditHistory();
      updateHistoryControls();
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
        snapshot[activeIndex] =
          pendingEditorDraftFile?.index === activeIndex
            ? pendingEditorDraftFile.file
            : new File([editorText], activeFile.name, {
                type: activeFile.type || (kindOf(activeFile) === 'game' ? 'text/html' : 'text/plain'),
                lastModified: activeFile.lastModified,
              });
      }
      download(await exportStudioProject(snapshot, audioClips, videoClips, imageLayers, passphrase, videoFormat));
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
      commitActiveEditorDraft();
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
  const renderStillImageComposition = async (): Promise<File> => {
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1080;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the image composition');
    const time = timelinePlayheadTime;
    const duration = Math.max(0, ...imageLayers.map((layer) => layer.end ?? 0)) || Infinity;
    const visibleLayers = imageLayers.filter(
      (layer) =>
        layer.visible &&
        time >= (layer.start ?? 0) &&
        time < (layer.end ?? Infinity) &&
        imageLayerOpacityAt(layer, time, duration) > 0,
    );
    if (visibleLayers.length === 0) throw new Error('Move the playhead to a time with visible image layers');
    const bitmaps = new Map<number, ImageBitmap>();
    try {
      for (const layer of visibleLayers) {
        if (layer.kind !== 'image' || bitmaps.has(layer.fileIndex)) continue;
        const file = files[layer.fileIndex];
        if (!file || !file.type.startsWith('image/')) throw new Error('An image layer is missing its source file');
        bitmaps.set(layer.fileIndex, await createImageBitmap(file));
      }
      for (const layer of visibleLayers) {
        drawStudioImageLayer(context, layer, layer.kind === 'image' ? (bitmaps.get(layer.fileIndex) ?? null) : null, {
          opacity: imageLayerOpacityAt(layer, time, duration),
        });
      }
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) => (result ? resolve(result) : reject(new Error('Could not encode image layers'))),
          'image/png',
        );
      });
      return new File([blob], 'flaxia-composition.png', { type: 'image/png' });
    } finally {
      for (const bitmap of bitmaps.values()) bitmap.close();
    }
  };

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
        commitActiveEditorDraft();
      }
      if (autosaveTimer) clearTimeout(autosaveTimer);
      saveRevision++;
      await saveChain.catch(() => undefined);
      const vaultKey = getVaultKey();
      if (vaultKey)
        await saveStudioProject(files, audioClips, videoClips, imageLayers, vaultKey, videoFormat).catch(
          () => undefined,
        );
      const selectedFile = files[activeIndex];
      const selectedExtension = selectedFile?.name.toLowerCase().split('.').pop() ?? '';
      const composerGameExtensions = ['zip', 'swf', 'rsp', 'js', 'wasm'];
      const selectedIsGame = selectedFile !== undefined && composerGameExtensions.includes(selectedExtension);
      const selectedIsPostable =
        selectedFile !== undefined &&
        (selectedIsGame ||
          (kindOf(selectedFile) !== 'code' &&
            !(kindOf(selectedFile) === 'game' && ['html', 'htm'].includes(selectedExtension))));
      const hasVisibleImageLayers = imageLayers.some(
        (layer) =>
          layer.visible &&
          timelinePlayheadTime >= (layer.start ?? 0) &&
          timelinePlayheadTime < (layer.end ?? Infinity) &&
          imageLayerOpacityAt(
            layer,
            timelinePlayheadTime,
            Math.max(0, ...imageLayers.map((item) => item.end ?? 0)) || Infinity,
          ) > 0,
      );
      const mode = resolveStudioPostMode({
        hasVideoClips: videoClips.length > 0,
        selectedIsGame,
        hasAudioClips: audibleAudioTimelineClips(audioClips).length > 0,
        hasVisibleImageLayers,
        selectedIsPostable,
      });
      let postFiles: File[];
      if (mode === 'video') {
        createPostButton.textContent = 'Rendering video…';
        const output = await renderVideoSequence(
          files,
          videoClips,
          audioClips,
          imageLayers,
          (progress) => {
            mixStatus.textContent = `Preparing post · ${Math.round(progress * 100)}%`;
          },
          videoFormat,
        );
        postFiles = [output];
      } else if (mode === 'game') {
        postFiles = selectedFile ? [selectedFile] : [];
      } else if (mode === 'timeline-assets') {
        createPostButton.textContent = 'Rendering assets…';
        postFiles = [];
        if (audibleAudioTimelineClips(audioClips).length > 0) postFiles.push(await renderMixdown());
        if (hasVisibleImageLayers) postFiles.push(await renderStillImageComposition());
      } else if (mode === 'selected-file') {
        postFiles = selectedFile ? [selectedFile] : [];
      } else {
        throw new Error('Select a postable asset or add media to the timeline before creating a post');
      }
      if (postFiles.length === 0) throw new Error('Studio could not prepare a postable export');
      const token = saveStudioHandoff(postFiles);
      window.history.pushState({}, '', `/home?studio_handoff=${encodeURIComponent(token)}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (error) {
      saveState.textContent = error instanceof Error ? error.message : 'Could not prepare post';
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
  audioRecordButton.addEventListener('click', async () => {
    if (audioRecorder) {
      audioRecordButton.disabled = true;
      audioRecordButton.title = 'Finishing microphone recording';
      audioRecorder.stop();
      return;
    }
    if (microphoneRequestPending) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      mixStatus.textContent = 'Microphone recording is not available in this browser';
      return;
    }
    microphoneRequestPending = true;
    audioRecordButton.disabled = true;
    mixStatus.textContent = 'Requesting microphone access…';
    let stream: MediaStream | null = null;
    try {
      clearMixPreview();
      if (videoSequencePlayer) stopVideoSequence();
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (destroyed) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      const mimeType = preferredAudioRecordingMimeType((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      audioRecordingChunks = [];
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) audioRecordingChunks.push(event.data);
      });
      recorder.addEventListener('error', () => {
        mixStatus.textContent = 'Microphone recording stopped after an audio error';
        if (recorder.state === 'recording') recorder.stop();
      });
      recorder.addEventListener(
        'stop',
        () => {
          const chunks = audioRecordingChunks;
          audioRecordingChunks = [];
          if (audioRecordingTimer) clearInterval(audioRecordingTimer);
          audioRecordingTimer = null;
          if (audioRecorder === recorder) audioRecorder = null;
          if (audioRecordingStream === stream) audioRecordingStream = null;
          stream?.getTracks().forEach((track) => {
            track.stop();
          });
          audioRecordButton.disabled = false;
          audioRecordButton.textContent = '● Record audio';
          audioRecordButton.title = 'Record microphone audio at the playhead';
          audioRecordButton.setAttribute('aria-pressed', 'false');
          mixPlayButton.disabled = audibleAudioTimelineClips(audioClips).length === 0;
          mixExportButton.disabled = audibleAudioTimelineClips(audioClips).length === 0;
          soloAudioButton.disabled = !audioClips.some((clip) => clip.id === selectedAudioClipId);
          if (destroyed) return;
          const elapsedSeconds = Math.max(0, Math.floor((Date.now() - audioRecordingStartedAt) / 1000));
          const elapsedLabel = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:${String(elapsedSeconds % 60).padStart(2, '0')}`;
          try {
            const file = createAudioRecordingFile(chunks, recorder.mimeType, Date.now());
            const fileIndex = files.length;
            files = [...files, file];
            ensureAudioClip(fileIndex, true, {
              track: audioRecordingTrack,
              start: audioRecordingTimelineStart,
            });
            const clip = audioClips.find((item) => item.fileIndex === fileIndex);
            if (!clip) throw new Error('Recorded audio could not be added to the timeline');
            audioTrackCount = Math.max(audioTrackCount, clip.track + 1);
            select(fileIndex);
            selectedAudioClipId = clip.id;
            selectedVideoClipId = null;
            selectedImageLayerId = null;
            renderAudioTimeline();
            renderInspector();
            scheduleAutosave();
            audioTimelineViewport.scrollLeft = Math.max(
              0,
              audioRecordingTimelineStart * timelinePixelsPerSecond - audioTimelineViewport.clientWidth / 3,
            );
            const recordedLane = audioTimeline.querySelector<HTMLElement>(
              `.studio-audio-lane[data-track="${clip.track}"]`,
            );
            if (recordedLane) {
              const laneBottom = recordedLane.offsetTop + recordedLane.offsetHeight;
              audioTimelineViewport.scrollTop = Math.max(0, laneBottom - audioTimelineViewport.clientHeight + 4);
            }
            mixStatus.textContent = `Recorded ${file.name} · ${elapsedLabel}`;
          } catch (error) {
            mixStatus.textContent = error instanceof Error ? error.message : 'Could not add microphone recording';
          }
        },
        { once: true },
      );
      audioRecordingTimelineStart = timelinePlayheadTime;
      audioRecordingTrack = Math.min(audioTrackCount, 7);
      recorder.start(250);
      audioRecorder = recorder;
      audioRecordingStream = stream;
      audioRecordingStartedAt = Date.now();
      audioRecordButton.disabled = false;
      audioRecordButton.textContent = '■ Stop recording';
      audioRecordButton.title = 'Stop and add this recording to the audio timeline';
      audioRecordButton.setAttribute('aria-pressed', 'true');
      mixPlayButton.disabled = true;
      mixExportButton.disabled = true;
      soloAudioButton.disabled = true;
      const updateRecordingStatus = (): void => {
        const seconds = Math.floor((Date.now() - audioRecordingStartedAt) / 1000);
        mixStatus.textContent = `Recording · ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      };
      updateRecordingStatus();
      audioRecordingTimer = setInterval(updateRecordingStatus, 250);
    } catch (error) {
      stream?.getTracks().forEach((track) => {
        track.stop();
      });
      audioRecordingStream = null;
      audioRecordingChunks = [];
      audioRecordButton.disabled = false;
      audioRecordButton.textContent = '● Record audio';
      audioRecordButton.title = 'Record microphone audio at the playhead';
      audioRecordButton.setAttribute('aria-pressed', 'false');
      mixPlayButton.disabled = audibleAudioTimelineClips(audioClips).length === 0;
      mixExportButton.disabled = audibleAudioTimelineClips(audioClips).length === 0;
      mixStatus.textContent =
        error instanceof Error ? `Microphone unavailable: ${error.message}` : 'Microphone unavailable';
    } finally {
      microphoneRequestPending = false;
    }
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
      mixPlayButton.disabled = audibleAudioTimelineClips(audioClips).length === 0;
      mixExportButton.disabled = audibleAudioTimelineClips(audioClips).length === 0;
    }
  };
  soloAudioButton.addEventListener('click', async () => {
    const clip = audioClips.find((item) => item.id === selectedAudioClipId);
    if (!clip) return;
    if (videoSequencePlayer) stopVideoSequence();
    if (mixPreview && soloPreviewClipId === clip.id) {
      if (mixPreview.paused) {
        if (mixPreview.ended) mixPreview.currentTime = 0;
        await mixPreview.play().catch(() => undefined);
        soloAudioButton.textContent = 'Ⅱ Pause clip';
        mixStatus.textContent = `Previewing ${files[clip.fileIndex]?.name ?? 'clip'}`;
      } else {
        mixPreview.pause();
        soloAudioButton.textContent = '▶ Resume clip';
        mixStatus.textContent = `Paused · ${mixPreview.currentTime.toFixed(1)}s into clip`;
      }
      return;
    }
    if (mixPreview || mixPreviewUrl) clearMixPreview();
    soloAudioButton.disabled = true;
    soloAudioButton.textContent = 'Rendering clip…';
    mixStatus.textContent = 'Rendering selected clip…';
    const revision = ++audioRenderRevision;
    try {
      const previewFile = await mixAudioTimeline(files, [soloAudioTimelineClip(clip)], 'flaxia-clip-preview.wav');
      if (destroyed) return;
      if (revision !== audioRenderRevision || !audioClips.some((item) => item.id === clip.id)) {
        soloAudioButton.disabled = !audioClips.some((item) => item.id === selectedAudioClipId);
        soloAudioButton.textContent = '▶ Solo clip';
        return;
      }
      mixPreviewTimelineOffset = clip.start;
      soloPreviewClipId = clip.id;
      mixPreviewUrl = URL.createObjectURL(previewFile);
      const player = new Audio(mixPreviewUrl);
      mixPreview = player;
      soloAudioButton.disabled = false;
      player.addEventListener('timeupdate', () => {
        if (mixPreview === player) updateTimelinePlayhead(mixPreviewTimelineOffset + player.currentTime);
      });
      player.addEventListener('ended', () => {
        if (mixPreview !== player) return;
        clearMixPreview();
        soloAudioButton.disabled = !audioClips.some((item) => item.id === selectedAudioClipId);
        mixStatus.textContent = 'Clip preview finished';
      });
      await player.play();
      if (mixPreview === player) {
        soloAudioButton.textContent = 'Ⅱ Pause clip';
        mixStatus.textContent = `Previewing ${files[clip.fileIndex]?.name ?? 'clip'}`;
      }
    } catch (error) {
      if (revision === audioRenderRevision) {
        soloAudioButton.disabled = !audioClips.some((item) => item.id === selectedAudioClipId);
        soloAudioButton.textContent = '▶ Solo clip';
        mixStatus.textContent = error instanceof Error ? error.message : 'Could not preview selected clip';
      }
    }
  });
  mixPlayButton.addEventListener('click', async () => {
    try {
      if (videoSequencePlayer) stopVideoSequence();
      if (soloPreviewClipId) clearMixPreview();
      const revision = ++audioRenderRevision;
      if (mixPreview) {
        if (mixPreview.paused) {
          if (mixPreview.ended) mixPreview.currentTime = 0;
          await mixPreview.play();
          mixPlayButton.textContent = 'Ⅱ Pause mix';
          mixStatus.textContent = 'Playing rendered mix';
        } else {
          mixPreview.pause();
          mixPlayButton.textContent = '▶ Resume mix';
          mixStatus.textContent = `Paused · ${mixPreview.currentTime.toFixed(1)}s`;
        }
        return;
      }
      const output = await renderMixdown();
      if (destroyed || revision !== audioRenderRevision) return;
      mixPreviewUrl = URL.createObjectURL(output);
      mixPreviewTimelineOffset = 0;
      soloPreviewClipId = null;
      const player = new Audio(mixPreviewUrl);
      mixPreview = player;
      player.addEventListener('timeupdate', () => {
        if (mixPreview === player) updateTimelinePlayhead(mixPreviewTimelineOffset + player.currentTime);
      });
      player.addEventListener('ended', () => {
        if (mixPreview !== player) return;
        mixPlayButton.textContent = '▶ Play mix';
        mixStatus.textContent = 'Mix finished';
      });
      await player.play();
      mixPlayButton.textContent = 'Ⅱ Pause mix';
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
  videoPlayButton.addEventListener('click', async () => {
    if (videoSequencePlayer) {
      stopVideoSequence();
      return;
    }
    const sequence = videoClips
      .filter((clip) => clip.track !== 'overlay')
      .map((clip) => ({ ...clip }))
      .sort((left, right) => left.start - right.start);
    const pictureSequence = videoClips
      .filter((clip) => clip.track === 'overlay')
      .map((clip) => ({ ...clip }))
      .sort((left, right) => left.start - right.start);
    rippleOverlappingVideoClips(sequence);
    rippleOverlappingVideoClips(pictureSequence);
    if (sequence.length === 0) return;
    let sequenceAudio: HTMLAudioElement | null = null;
    if (audioClips.some((clip) => !clip.muted && clip.sourceEnd > clip.sourceStart)) {
      try {
        const mix = await mixAudioTimeline(files, audioClips, 'flaxia-sequence-preview.wav');
        if (destroyed) return;
        videoSequenceAudioUrl = URL.createObjectURL(mix);
        sequenceAudio = new Audio(videoSequenceAudioUrl);
        videoSequenceAudio = sequenceAudio;
      } catch {
        // Video and source audio remain previewable if an audio track cannot be mixed.
      }
    }
    mixPreview?.pause();
    if (mixPreview) mixPlayButton.textContent = soloPreviewClipId ? '▶ Play mix' : '▶ Resume mix';
    const startTimes: number[] = [];
    let sequenceEnd = 0;
    for (const clip of sequence) {
      const clipStart = Math.max(0, clip.start);
      startTimes.push(clipStart);
      sequenceEnd = Math.max(sequenceEnd, clipStart + videoClipTimelineDuration(clip));
    }
    for (const clip of pictureSequence) {
      sequenceEnd = Math.max(sequenceEnd, Math.max(0, clip.start) + videoClipTimelineDuration(clip));
    }
    const requestedStartTime = videoSequenceStartTime;
    videoSequenceStartTime = 0;
    const stage = root.querySelector<HTMLElement>('.studio-stage')!;
    const player = document.createElement('video');
    player.className = 'studio-sequence-player';
    player.controls = true;
    player.playsInline = true;
    player.setAttribute('aria-label', 'Video sequence preview');
    stage.appendChild(player);
    const transitionPlayer = document.createElement('video');
    transitionPlayer.className = 'studio-sequence-transition-player';
    transitionPlayer.playsInline = true;
    transitionPlayer.preload = 'auto';
    transitionPlayer.muted = true;
    transitionPlayer.setAttribute('aria-hidden', 'true');
    stage.appendChild(transitionPlayer);
    videoSequenceTransitionPlayer = transitionPlayer;
    const picturePlayer = document.createElement('video');
    picturePlayer.className = 'studio-sequence-pip-player';
    picturePlayer.playsInline = true;
    picturePlayer.preload = 'auto';
    picturePlayer.setAttribute('aria-hidden', 'true');
    picturePlayer.style.visibility = 'hidden';
    stage.appendChild(picturePlayer);
    videoSequencePipPlayer = picturePlayer;
    const overlayStack = document.createElement('div');
    overlayStack.className = 'studio-sequence-overlays';
    overlayStack.setAttribute('aria-hidden', 'true');
    stage.appendChild(overlayStack);
    const frameSize = studioVideoFrameSize(videoFormat);
    const framePlacement = studioVideoLayerPlacement(videoFormat);
    const layoutVideoFrame = (): void => {
      const scale = Math.min(
        (stage.clientWidth * 0.84) / frameSize.width,
        (stage.clientHeight * 0.88) / frameSize.height,
      );
      const width = Math.max(1, Math.round(frameSize.width * scale));
      const height = Math.max(1, Math.round(frameSize.height * scale));
      const left = Math.round((stage.clientWidth - width) / 2);
      const top = Math.round((stage.clientHeight - height) / 2);
      for (const element of [player, transitionPlayer, overlayStack]) {
        element.style.inset = 'auto';
        element.style.left = `${left}px`;
        element.style.top = `${top}px`;
        element.style.width = `${width}px`;
        element.style.height = `${height}px`;
      }
      const pictureWidth = Math.max(1, Math.round(width * 0.38));
      const sourceAspect = picturePlayer.videoWidth > 0 ? picturePlayer.videoWidth / picturePlayer.videoHeight : 16 / 9;
      const pictureHeight = Math.max(1, Math.min(Math.round(height * 0.38), Math.round(pictureWidth / sourceAspect)));
      const margin = Math.max(8, Math.round(Math.min(width, height) * 0.025));
      picturePlayer.style.left = `${left + width - pictureWidth - margin}px`;
      picturePlayer.style.top = `${top + height - pictureHeight - margin}px`;
      picturePlayer.style.width = `${pictureWidth}px`;
      picturePlayer.style.height = `${pictureHeight}px`;
    };
    layoutVideoFrame();
    videoSequenceFrameObserver = new ResizeObserver(layoutVideoFrame);
    videoSequenceFrameObserver.observe(stage);
    videoSequenceOverlayCanvas = overlayStack;
    const overlayCanvases = new Map<string, HTMLCanvasElement>();
    let previewShouldPlay = false;
    const syncPictureInPicture = (time: number, playing: boolean): void => {
      previewShouldPlay = playing;
      const clip = pictureSequence.find(
        (item) => time >= item.start && time < item.start + videoClipTimelineDuration(item),
      );
      if (!clip) {
        picturePlayer.pause();
        picturePlayer.style.visibility = 'hidden';
        return;
      }
      const file = files[clip.fileIndex];
      if (!file) return;
      if (picturePlayer.dataset.clipId !== clip.id) {
        picturePlayer.pause();
        if (videoSequencePipUrl) URL.revokeObjectURL(videoSequencePipUrl);
        videoSequencePipUrl = URL.createObjectURL(file);
        picturePlayer.dataset.clipId = clip.id;
        picturePlayer.playbackRate = videoClipSpeed(clip);
        picturePlayer.style.objectFit = clip.fit === 'cover' ? 'cover' : 'contain';
        picturePlayer.style.filter = videoClipCssFilter(clip);
        picturePlayer.volume = Math.max(0, Math.min(1, clip.gain ?? 1));
        picturePlayer.muted = clip.muted ?? false;
        picturePlayer.src = videoSequencePipUrl;
        picturePlayer.onloadedmetadata = () => syncPictureInPicture(timelinePlayheadTime, previewShouldPlay);
      }
      picturePlayer.style.visibility = 'visible';
      picturePlayer.playbackRate = videoClipSpeed(clip);
      picturePlayer.volume = Math.max(0, Math.min(1, clip.gain ?? 1));
      picturePlayer.muted = clip.muted ?? false;
      if (picturePlayer.readyState >= 1) {
        const expectedTime = Math.min(
          clip.sourceStart + (time - clip.start) * videoClipSpeed(clip),
          picturePlayer.duration || 0,
        );
        if (Math.abs(picturePlayer.currentTime - expectedTime) > 0.15) picturePlayer.currentTime = expectedTime;
        if (playing && picturePlayer.paused) void picturePlayer.play().catch(() => undefined);
        else if (!playing && !picturePlayer.paused) picturePlayer.pause();
      }
      layoutVideoFrame();
    };
    const drawLiveLayers = async (time: number, playing = !player.paused): Promise<void> => {
      if (!videoSequenceOverlayCanvas) return;
      const revision = ++videoSequenceOverlayRevision;
      const activeLayerIds = new Set<string>();
      for (const layer of imageLayers) {
        if (!layer.visible || time < (layer.start ?? 0) || time >= (layer.end ?? sequenceEnd)) continue;
        let bitmap: ImageBitmap | null = null;
        if (layer.kind === 'image') {
          let bitmapPromise = videoSequenceOverlayBitmaps.get(layer.fileIndex);
          if (!bitmapPromise) {
            const file = files[layer.fileIndex];
            if (!file) continue;
            bitmapPromise = createImageBitmap(file);
            videoSequenceOverlayBitmaps.set(layer.fileIndex, bitmapPromise);
            void bitmapPromise.catch(() => videoSequenceOverlayBitmaps.delete(layer.fileIndex));
          }
          try {
            bitmap = await bitmapPromise;
          } catch {
            continue;
          }
        }
        if (revision !== videoSequenceOverlayRevision || !videoSequenceOverlayCanvas) return;
        activeLayerIds.add(layer.id);
        let layerCanvas = overlayCanvases.get(layer.id);
        if (!layerCanvas) {
          layerCanvas = document.createElement('canvas');
          layerCanvas.width = frameSize.width;
          layerCanvas.height = frameSize.height;
          videoSequenceOverlayCanvas.appendChild(layerCanvas);
          overlayCanvases.set(layer.id, layerCanvas);
        }
        videoSequenceOverlayCanvas.appendChild(layerCanvas);
        layerCanvas.style.mixBlendMode = layer.blend === 'normal' ? 'normal' : layer.blend;
        const context = layerCanvas.getContext('2d');
        if (!context) continue;
        context.clearRect(0, 0, layerCanvas.width, layerCanvas.height);
        drawStudioImageLayer(context, layer, bitmap, {
          ...framePlacement,
          opacity: imageLayerOpacityAt(layer, time, sequenceEnd),
        });
      }
      for (const [id, layerCanvas] of overlayCanvases) {
        layerCanvas.hidden = !activeLayerIds.has(id);
      }
      syncPictureInPicture(time, playing);
    };
    videoSequencePlayer = player;
    videoPlayButton.textContent = '■ Stop preview';
    let activeClip: StudioVideoClip | null = null;
    let advancing = false;
    let playAt: (index: number) => void = () => undefined;
    let syncTransition: (time: number, playing: boolean) => void = () => undefined;
    const overlapBefore = (index: number): number =>
      index <= 0 || index >= sequence.length
        ? 0
        : Math.max(
            0,
            Math.min(
              startTimes[index - 1] + videoClipTimelineDuration(sequence[index - 1]) - startTimes[index],
              videoClipTimelineDuration(sequence[index]),
            ),
          );
    const prepareTransition = (index: number): void => {
      if (index <= 0 || index >= sequence.length || !videoSequencePlayer) return;
      if (overlapBefore(index) <= 0.04 || transitionPlayer.dataset.clipId === sequence[index].id) return;
      transitionPlayer.pause();
      transitionPlayer.removeAttribute('src');
      transitionPlayer.load();
      if (videoSequenceTransitionUrl) URL.revokeObjectURL(videoSequenceTransitionUrl);
      videoSequenceTransitionUrl = null;
      transitionPlayer.style.visibility = 'hidden';
      transitionPlayer.style.opacity = '0';
      transitionPlayer.style.clipPath = 'none';
      transitionPlayer.volume = 0;
      transitionPlayer.muted = true;
      const incomingClip = sequence[index];
      const file = files[incomingClip.fileIndex];
      if (!file) return;
      transitionPlayer.dataset.clipId = incomingClip.id;
      transitionPlayer.playbackRate = videoClipSpeed(incomingClip);
      transitionPlayer.style.objectFit = incomingClip.fit === 'cover' ? 'cover' : 'contain';
      transitionPlayer.style.filter = videoClipCssFilter(incomingClip);
      videoSequenceTransitionUrl = URL.createObjectURL(file);
      transitionPlayer.src = videoSequenceTransitionUrl;
      transitionPlayer.onloadedmetadata = () => {
        if (!videoSequencePlayer || transitionPlayer.dataset.clipId !== incomingClip.id) return;
        const offset = Math.max(0, Math.min(overlapBefore(index), timelinePlayheadTime - startTimes[index]));
        transitionPlayer.currentTime = Math.min(
          incomingClip.sourceStart + offset * videoClipSpeed(incomingClip),
          transitionPlayer.duration || 0,
        );
        syncTransition(timelinePlayheadTime, !player.paused);
      };
    };
    syncTransition = (time, playing): void => {
      if (!activeClip || videoSequenceIndex < 0) return;
      const index = videoSequenceIndex + 1;
      const incomingClip = sequence[index];
      const overlap = overlapBefore(index);
      const outgoingEnd = startTimes[videoSequenceIndex] + videoClipTimelineDuration(activeClip);
      if (!incomingClip || overlap <= 0.04 || time < startTimes[index] || time >= outgoingEnd) {
        transitionPlayer.pause();
        transitionPlayer.style.visibility = 'hidden';
        transitionPlayer.style.opacity = '0';
        return;
      }
      prepareTransition(index);
      if (transitionPlayer.dataset.clipId !== incomingClip.id || transitionPlayer.readyState < 1) return;
      const progress = Math.max(0, Math.min(1, (time - startTimes[index]) / overlap));
      const incomingOffset = Math.max(0, time - startTimes[index]);
      const incomingTime = Math.min(
        incomingClip.sourceStart + incomingOffset * videoClipSpeed(incomingClip),
        transitionPlayer.duration || 0,
      );
      if (Math.abs(transitionPlayer.currentTime - incomingTime) > 0.12) transitionPlayer.currentTime = incomingTime;
      transitionPlayer.playbackRate = videoClipSpeed(incomingClip);
      const incomingFade = videoClipOpacityAt(
        incomingOffset,
        videoClipTimelineDuration(incomingClip),
        incomingClip.fadeIn,
        incomingClip.fadeOut,
      );
      const outgoingOffset = Math.max(0, time - startTimes[videoSequenceIndex]);
      const outgoingFade = videoClipOpacityAt(
        outgoingOffset,
        videoClipTimelineDuration(activeClip),
        activeClip.fadeIn,
        activeClip.fadeOut,
      );
      const transitionType = activeClip.transitionType ?? 'fade';
      const isDissolve = transitionType === 'fade';
      player.style.opacity = String((isDissolve ? 1 - progress : 1) * outgoingFade);
      player.volume = Math.max(0, Math.min(1, activeClip.gain ?? 1)) * (1 - progress) * outgoingFade;
      transitionPlayer.style.visibility = 'visible';
      transitionPlayer.style.opacity = String((isDissolve ? progress : 1) * incomingFade);
      transitionPlayer.style.clipPath =
        transitionType === 'wipeleft'
          ? `inset(0 0 0 ${(1 - progress) * 100}%)`
          : transitionType === 'wiperight'
            ? `inset(0 ${(1 - progress) * 100}% 0 0)`
            : 'none';
      transitionPlayer.muted = incomingClip.muted ?? false;
      transitionPlayer.volume = Math.max(0, Math.min(1, incomingClip.gain ?? 1)) * progress * incomingFade;
      if (playing && transitionPlayer.paused) void transitionPlayer.play().catch(() => undefined);
      else if (!playing && !transitionPlayer.paused) transitionPlayer.pause();
    };
    const syncSequenceAudio = (time: number, play: boolean): void => {
      if (!sequenceAudio) return;
      if (Math.abs(sequenceAudio.currentTime - time) > 0.3) sequenceAudio.currentTime = time;
      if (play && sequenceAudio.paused) void sequenceAudio.play().catch(() => undefined);
      else if (!play && !sequenceAudio.paused) sequenceAudio.pause();
    };
    const playClip = (index: number, offset = 0): void => {
      if (index >= sequence.length || !videoSequencePlayer) {
        const mainEnd = Math.max(0, ...sequence.map((clip) => clip.start + videoClipTimelineDuration(clip)));
        if (index >= sequence.length && sequenceEnd > mainEnd + 0.04) {
          activeClip = null;
          waitThroughGap(sequence.length, mainEnd, sequenceEnd - mainEnd);
          return;
        }
        mixStatus.textContent = 'Video sequence finished';
        stopVideoSequence();
        return;
      }
      videoSequenceIndex = index;
      activeClip = sequence[index];
      player.dataset.clipId = activeClip.id;
      player.playbackRate = videoClipSpeed(activeClip);
      player.volume = Math.max(0, Math.min(1, activeClip.gain ?? 1));
      player.muted = activeClip.muted ?? false;
      player.style.objectFit = activeClip.fit === 'cover' ? 'cover' : 'contain';
      player.style.filter = videoClipCssFilter(activeClip);
      player.style.opacity = '1';
      transitionPlayer.pause();
      transitionPlayer.style.visibility = 'hidden';
      transitionPlayer.style.opacity = '0';
      transitionPlayer.style.clipPath = 'none';
      if (overlapBefore(index + 1) > 0.04) prepareTransition(index + 1);
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
        const initialTimelineTime = startTimes[index] + offset;
        updateTimelinePlayhead(initialTimelineTime);
        void drawLiveLayers(initialTimelineTime, true);
        syncSequenceAudio(initialTimelineTime, true);
        player.currentTime = Math.min(
          sequence[index].sourceStart + offset * videoClipSpeed(sequence[index]),
          player.duration || 0,
        );
        void player.play().catch(() => {
          mixStatus.textContent = 'Press play in the video preview to continue';
        });
      };
      mixStatus.textContent = `Video ${index + 1} / ${sequence.length}`;
    };
    const waitThroughGap = (index: number, gapStart: number, gapDuration: number): void => {
      videoSequenceIndex = index;
      player.pause();
      player.removeAttribute('src');
      player.load();
      if (videoSequenceUrl) URL.revokeObjectURL(videoSequenceUrl);
      videoSequenceUrl = null;
      player.style.visibility = 'hidden';
      transitionPlayer.pause();
      transitionPlayer.style.visibility = 'hidden';
      transitionPlayer.style.opacity = '0';
      transitionPlayer.style.clipPath = 'none';
      mixStatus.textContent = `Gap · ${gapDuration.toFixed(1)}s`;
      const gapStartedAt = performance.now();
      const updateGap = (): void => {
        const elapsed = Math.min(gapDuration, (performance.now() - gapStartedAt) / 1000);
        const gapEnd = index < startTimes.length ? startTimes[index] : gapStart + gapDuration;
        const time = Math.min(gapEnd, gapStart + elapsed);
        updateTimelinePlayhead(time);
        void drawLiveLayers(time, true);
        syncSequenceAudio(time, true);
        if (elapsed >= gapDuration) {
          videoSequenceTimer = null;
          if (index >= sequence.length) {
            mixStatus.textContent = 'Video sequence finished';
            stopVideoSequence();
          } else playClip(index);
          return;
        }
        videoSequenceTimer = setTimeout(updateGap, Math.min(50, (gapDuration - elapsed) * 1000));
      };
      videoSequenceTimer = setTimeout(updateGap, Math.min(50, gapDuration * 1000));
    };
    playAt = (index: number): void => {
      if (index >= sequence.length || !videoSequencePlayer) {
        playClip(index);
        return;
      }
      const previousEnd = index > 0 ? startTimes[index - 1] + videoClipTimelineDuration(sequence[index - 1]) : 0;
      const gap = Math.max(0, startTimes[index] - previousEnd);
      if (gap <= 0.04) {
        playClip(index);
        return;
      }
      waitThroughGap(index, previousEnd, gap);
    };
    const advance = (): void => {
      if (videoSequenceIndex >= 0 && !advancing) {
        advancing = true;
        const nextIndex = videoSequenceIndex + 1;
        const overlap = overlapBefore(nextIndex);
        if (overlap > 0.04) playClip(nextIndex, overlap);
        else playAt(nextIndex);
      }
    };
    const startAt = (time: number): void => {
      const index = sequence.findIndex(
        (clip, clipIndex) => time < startTimes[clipIndex] + videoClipTimelineDuration(clip),
      );
      if (index < 0) {
        if (time < sequenceEnd) {
          activeClip = null;
          waitThroughGap(sequence.length, time, sequenceEnd - time);
        } else {
          mixStatus.textContent = 'Video sequence finished';
          stopVideoSequence();
        }
        return;
      }
      videoSequenceIndex = index;
      const timeIntoSegment = time - startTimes[index];
      if (timeIntoSegment < 0) {
        waitThroughGap(index, time, -timeIntoSegment);
        return;
      }
      playClip(index, timeIntoSegment);
    };
    player.addEventListener('timeupdate', () => {
      if (activeClip && videoSequenceIndex >= 0) {
        const timelineTime =
          startTimes[videoSequenceIndex] +
          Math.max(0, player.currentTime - activeClip.sourceStart) / videoClipSpeed(activeClip);
        const clipTime = timelineTime - startTimes[videoSequenceIndex];
        player.volume =
          Math.max(0, Math.min(1, activeClip.gain ?? 1)) *
          videoClipOpacityAt(clipTime, videoClipTimelineDuration(activeClip), activeClip.fadeIn, activeClip.fadeOut);
        player.style.opacity = String(
          videoClipOpacityAt(clipTime, videoClipTimelineDuration(activeClip), activeClip.fadeIn, activeClip.fadeOut),
        );
        updateTimelinePlayhead(timelineTime);
        void drawLiveLayers(timelineTime, !player.paused);
        syncSequenceAudio(timelineTime, !player.paused);
        syncTransition(timelineTime, !player.paused);
      }
      if (activeClip && player.currentTime >= activeClip.sourceEnd - 0.04) advance();
    });
    player.addEventListener('ended', advance);
    player.addEventListener('pause', () => {
      syncSequenceAudio(timelinePlayheadTime, false);
      syncTransition(timelinePlayheadTime, false);
      syncPictureInPicture(timelinePlayheadTime, false);
    });
    player.addEventListener('play', () => {
      syncSequenceAudio(timelinePlayheadTime, true);
      syncTransition(timelinePlayheadTime, true);
      syncPictureInPicture(timelinePlayheadTime, true);
    });
    startAt(requestedStartTime);
  });
  videoExportButton.addEventListener('click', async () => {
    if (!videoClips.some((clip) => clip.track !== 'overlay')) return;
    stopVideoSequence();
    videoExportButton.disabled = true;
    const compositionParts = [
      videoClips.some((clip) => clip.track === 'overlay') ? 'picture-in-picture' : '',
      imageLayers.some((layer) => layer.visible) ? 'visible layers' : '',
    ].filter(Boolean);
    mixStatus.textContent = `Compositing ${compositionParts.length ? `${compositionParts.join(', ')} and ` : ''}encoding MP4 · 0%`;
    try {
      const output = await renderVideoSequence(
        files,
        videoClips,
        audioClips,
        imageLayers,
        (progress) => {
          mixStatus.textContent = `Encoding MP4 · ${Math.round(progress * 100)}%`;
        },
        videoFormat,
      );
      download(output);
      mixStatus.textContent = `MP4 downloaded · ${sizeLabel(output.size)}`;
    } catch (error) {
      mixStatus.textContent = error instanceof Error ? error.message : 'Could not export video sequence';
    } finally {
      videoExportButton.disabled = !videoClips.some((clip) => clip.track !== 'overlay');
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
      return;
    }
    const target = event.target;
    if (!(target instanceof Element) || !root.contains(target)) return;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      (event.shiftKey ? redoButton : undoButton).click();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redoButton.click();
      return;
    }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !target.closest('button, a, video, audio')) {
      event.preventDefault();
      const step = event.shiftKey ? 1 : 0.1;
      const nextTime = Math.max(0, timelinePlayheadTime + (event.key === 'ArrowRight' ? step : -step));
      if (videoSequencePlayer || (!videoClips.some((clip) => clip.track !== 'overlay') && mixPreview)) {
        requestVideoSeek(nextTime);
      } else {
        videoSequenceStartTime = nextTime;
        updateTimelinePlayhead(nextTime);
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd' && !duplicateClipButton.disabled) {
      event.preventDefault();
      duplicateClipButton.click();
      return;
    }
    if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      (selectedVideoClipId || selectedAudioClipId || selectedImageLayerId)
    ) {
      event.preventDefault();
      if (selectedVideoClipId) {
        videoClips = videoClips.filter((clip) => clip.id !== selectedVideoClipId);
        selectedVideoClipId = null;
        stopVideoSequence();
        renderVideoTimeline();
      } else if (selectedAudioClipId) {
        audioClips = audioClips.filter((clip) => clip.id !== selectedAudioClipId);
        selectedAudioClipId = null;
        renderAudioTimeline();
      } else if (selectedImageLayerId) {
        imageLayers = imageLayers.filter((layer) => layer.id !== selectedImageLayerId);
        selectedImageLayerId = null;
        renderVideoTimeline();
      }
      renderInspector();
      scheduleAutosave();
      return;
    }
    if (event.code === 'Space' && !target.closest('button, a, video, audio')) {
      event.preventDefault();
      if (videoClips.some((clip) => clip.track !== 'overlay')) videoPlayButton.click();
      else if (audioClips.length > 0) mixPlayButton.click();
    }
  };
  window.addEventListener('keydown', keyHandler);
  void (async () => {
    if (!getVaultKey()) await tryDeviceUnlock();
    const vaultKey = getVaultKey();
    if (!vaultKey) {
      if (destroyed) return;
      saveState.textContent = 'Unlock Vault to restore saved projects';
      finishRestore({ files: [], audioClips: [], videoClips: [], imageLayers: [], videoFormat: 'landscape' });
      return;
    }
    const project = await loadStudioProject(vaultKey);
    if (!destroyed) finishRestore(project);
  })().catch(() => {
    if (destroyed) return;
    saveState.textContent = 'Could not restore encrypted project';
    finishRestore({ files: [], audioClips: [], videoClips: [], imageLayers: [], videoFormat: 'landscape' });
  });

  return {
    getElement: () => root,
    destroy: () => {
      const currentFile = files[activeIndex];
      if (
        codeDirty &&
        currentFile &&
        (kindOf(currentFile) === 'code' || (kindOf(currentFile) === 'game' && /\.html?$/i.test(currentFile.name)))
      ) {
        commitActiveEditorDraft();
      }
      if (codeHistoryTimer) clearTimeout(codeHistoryTimer);
      codeHistoryTimer = null;
      if (autosaveTimer) clearTimeout(autosaveTimer);
      const vaultKey = getVaultKey();
      if (vaultKey) {
        const projectFiles = [...files];
        const projectAudioClips = [...audioClips];
        const projectVideoClips = [...videoClips];
        const projectImageLayers = [...imageLayers];
        const projectVideoFormat = videoFormat;
        const revision = ++saveRevision;
        saveChain = saveChain
          .catch(() => undefined)
          .then(async () => {
            if (revision !== saveRevision) return;
            try {
              await saveStudioProject(
                projectFiles,
                projectAudioClips,
                projectVideoClips,
                projectImageLayers,
                vaultKey,
                projectVideoFormat,
              );
            } catch {
              // The page is closing; there is no UI left to report a failed final save.
            }
          });
      }
      destroyed = true;
      if (audioRecordingTimer) clearInterval(audioRecordingTimer);
      audioRecordingTimer = null;
      if (audioRecorder?.state === 'recording') audioRecorder.stop();
      audioRecordingStream?.getTracks().forEach((track) => {
        track.stop();
      });
      audioRecordingStream = null;
      codeEditorCleanup?.();
      codeEditorCleanup = null;
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
.studio-zip-source-tools{display:flex;align-items:center;justify-content:space-between;padding-right:6px}.studio-zip-search-toggle,.studio-zip-search-clear{width:25px;height:24px;padding:0;border:1px solid #393d46;border-radius:4px;background:#202228;color:#c9cdd5;font-size:15px;cursor:pointer}.studio-zip-search-toggle[aria-expanded=true]{border-color:#82995f;color:#d8f3c2}.studio-zip-search-panel{padding:0 7px 7px;border-bottom:1px solid #30333a}.studio-zip-search-row{display:flex;gap:4px}.studio-zip-search-input{flex:1;min-width:0;padding:5px 6px;border:1px solid #393d46;border-radius:4px;background:#111216;color:#e9ebef;font:11px system-ui,sans-serif}.studio-zip-search-status{min-height:14px;padding-top:4px;color:#9298a3;font-size:9px}.studio-zip-source-list{flex:1;min-height:0}.studio-zip-search-result{display:flex;flex-direction:column;gap:3px;width:100%;padding:6px 9px;border:0;border-bottom:1px solid #24262c;background:transparent;color:#bfc4ce;text-align:left;cursor:pointer}.studio-zip-search-result:hover{background:#24262c}.studio-zip-search-location{overflow:hidden;color:#d8f3c2;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.studio-zip-search-preview{overflow:hidden;color:#9298a3;font:10px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}
.studio-zip-workbench{display:grid;grid-template-columns:198px minmax(0,1fr);flex:1;min-height:0;border:1px solid #2b2d34;border-radius:5px;overflow:hidden}.studio-zip-source-explorer{display:flex;flex-direction:column;min-width:0;overflow:auto;border-right:1px solid #30333a;background:#17181d}.studio-zip-source-heading{flex:0 0 auto;padding:8px 10px;color:#8e949f;font-size:9px;font-weight:700;letter-spacing:.08em}.studio-zip-source-list{overflow:auto;padding-bottom:8px}.studio-zip-source-folder,.studio-zip-source-file{display:block;width:100%;padding:5px 8px;border:0;background:transparent;color:#bfc4ce;text-align:left;font:11px system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}.studio-zip-source-folder{color:#d4d8df}.studio-zip-source-folder:hover,.studio-zip-source-file:hover{background:#24262c}.studio-zip-source-file[aria-current=true]{background:#30382a;color:#d8f3c2}.studio-zip-editor-host{min-width:0;overflow:hidden;background:#111216}@media(max-width:700px){.studio-zip-workbench{grid-template-columns:minmax(112px,30vw) minmax(0,1fr)}}
.studio-timeline-head{overflow-x:auto;scrollbar-width:thin}.studio-history-undo,.studio-history-redo{min-width:28px;padding:4px 6px!important;font-size:14px!important}
.studio-center>.studio-timeline{min-width:0}.studio-timeline-head{min-width:0;max-width:100%}
.studio-video-format-control{display:flex;align-items:center;gap:4px;white-space:nowrap;color:var(--studio-muted);font-size:9px}.studio-video-format{padding:4px 6px;border:1px solid var(--studio-border);border-radius:4px;background:#202228;color:var(--studio-text);font-size:10px}
.studio-timeline-playhead{position:absolute;z-index:4;top:0;bottom:0;width:2px;background:#f2f687;box-shadow:0 0 6px #f2f687;pointer-events:none}
.studio-sequence-overlays{position:absolute;z-index:6;inset:6% 8%;width:84%;height:88%;pointer-events:none}.studio-sequence-overlays canvas{position:absolute;inset:0;width:100%;height:100%}
.studio-composer-preview-controls{display:flex;align-items:center;gap:16px;min-height:38px;padding:4px 18px;border-bottom:1px solid #30333a;background:#15161b;color:#aeb3bd;font-size:10px}.studio-composer-preview-controls label{display:flex;align-items:center;gap:7px;white-space:nowrap}.studio-composer-preview-controls label:last-child{flex:1}.studio-composer-preview-controls input[type=checkbox]{accent-color:#b8ef6a}.studio-composer-preview-controls input[type=range]{flex:1;min-width:80px;max-width:460px;accent-color:#b8ef6a}.studio-composer-preview-controls output{min-width:40px;color:#e9ebef;font-variant-numeric:tabular-nums}
.studio-video-clip.muted{filter:saturate(.35);border-style:dashed}.studio-video-transition-mark{position:absolute;z-index:4;top:0;right:0;bottom:0;border-left:1px solid #e0c5ff;background:linear-gradient(90deg,#c99aff22,#c99aff99);pointer-events:none}
.studio-clip-speed{max-width:116px;padding:5px 7px;border:1px solid var(--studio-border);border-radius:4px;background:#111216;color:var(--studio-text);font:11px system-ui,sans-serif}
.studio-composer-position-lock{width:23px;flex:0 0 23px;padding:4px 0;border:0;border-radius:4px;background:transparent;color:#9da3ad;font-size:12px;cursor:pointer}.studio-composer-position-lock:hover,.studio-composer-position-lock[aria-pressed=true]{background:#30343c;color:#b8ef6a}.studio-composer-position-lock:focus-visible{outline:1px solid #b8ef6a}
.studio-audio-track-label{box-sizing:border-box;flex:0 0 142px;display:flex;flex-direction:column;justify-content:center;gap:3px;padding:4px 7px}.studio-audio-track-heading{display:flex;align-items:center;justify-content:space-between}.studio-audio-track-controls{display:flex;gap:3px}.studio-audio-track-controls button{width:20px;height:16px;padding:0;border:1px solid #3b3d44;border-radius:3px;background:#24262c;color:#999;font-size:9px}.studio-audio-track-controls button.active,.studio-audio-track-controls button[aria-pressed=true]{background:#327365;color:#d8fff4}.studio-audio-track-controls button[data-action=mute][aria-pressed=true]{background:#805c32;color:#fff0c2}.studio-audio-mixer-control{display:flex;align-items:center;gap:4px;height:12px;color:#888e9a;font-size:8px}.studio-audio-mixer-control input{flex:1;min-width:0;height:10px;margin:0;accent-color:#9bd77b}.studio-audio-mixer-control output{width:28px;color:#b9bec8;text-align:right;font-size:8px;font-variant-numeric:tabular-nums}
.studio-image-overlay-lane{min-height:42px}.studio-image-overlay-canvas{min-height:41px}.studio-image-overlay-clip{position:absolute;top:5px;height:31px;overflow:hidden;border:1px solid #597b48;border-radius:5px;background:#293b27;color:#e2f2d7;text-align:left;cursor:grab;touch-action:none}.studio-image-overlay-clip.text{border-color:#547c91;background:#243844;color:#dceefa}.studio-image-overlay-clip.active{outline:1px solid #b8ef6a}.studio-image-overlay-clip.hidden{opacity:.45;border-style:dashed}.studio-image-overlay-label{display:block;padding:0 11px;overflow:hidden;line-height:29px;text-overflow:ellipsis;white-space:nowrap;pointer-events:none}.studio-image-overlay-trim{position:absolute;z-index:2;top:0;bottom:0;width:8px;background:#d9efac55;cursor:ew-resize;touch-action:none}.studio-image-overlay-trim:hover{background:#b8ef6a}.studio-image-overlay-trim-left{left:0}.studio-image-overlay-trim-right{right:0}
.studio-timeline-zoom-control{display:flex;align-items:center;gap:4px;color:var(--studio-muted);font-size:9px;white-space:nowrap}.studio-timeline-zoom-control input{width:76px;accent-color:var(--studio-accent)}.studio-timeline-zoom-control output{min-width:40px;color:#c8ccd4;font-variant-numeric:tabular-nums}
.studio-video-trim,.studio-audio-trim{position:absolute;z-index:3;top:0;bottom:0;width:9px;background:#d9efac55;cursor:ew-resize;touch-action:none}.studio-video-trim:hover,.studio-audio-trim:hover{background:#b8ef6a}.studio-video-trim-left,.studio-audio-trim-left{left:0;border-radius:4px 0 0 4px}.studio-video-trim-right,.studio-audio-trim-right{right:0;border-radius:0 4px 4px 0}.studio-video-clip-label{display:block;position:relative;z-index:1;padding:0 11px;overflow:hidden;line-height:33px;text-overflow:ellipsis;white-space:nowrap;pointer-events:none}
.studio-code-surface{position:relative;flex:1;min-width:0;min-height:260px;overflow:hidden}.studio-code-highlight{position:absolute;z-index:0;top:0;left:0;width:max-content;min-width:100%;min-height:100%;box-sizing:border-box;margin:0;padding:12px;overflow:visible;color:#dce2ec;font:12px/20px ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:2;white-space:pre;pointer-events:none;will-change:transform}.studio-code-surface>.studio-code-editor{position:absolute;z-index:1;inset:0;width:100%;height:100%;min-height:100%;box-sizing:border-box;resize:none;background:transparent;color:transparent;-webkit-text-fill-color:transparent;overflow:auto}.studio-code-surface>.studio-code-editor::selection{background:#71834c66;color:transparent}.studio-token-comment{color:#76836d}.studio-token-string{color:#d8a878}.studio-token-keyword{color:#c792ea}.studio-token-literal{color:#f78c6c}.studio-token-number{color:#f78c6c}.studio-token-function{color:#82aaff}.studio-token-tag{color:#e06c75}.studio-token-color{color:#c3e88d}.studio-token-property{color:#80cbc4}.studio-token-heading{color:#82aaff;font-weight:700}
.studio-tab{height:100%;padding:0 7px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--studio-muted);font:inherit;white-space:nowrap;cursor:pointer}.studio-tab.active{border-bottom-color:var(--studio-accent);color:var(--studio-text)}.studio-document-tabs{display:flex;align-items:center;gap:3px;min-width:0;height:100%;overflow:auto}.studio-document-tab-wrap{display:flex;align-items:center;max-width:190px;height:27px;border:1px solid transparent;border-radius:4px;background:#191b20}.studio-document-tab-wrap.active{border-color:#3c414c;background:#24262d}.studio-document-tab{min-width:0;padding:5px 7px;overflow:hidden;border:0;background:transparent;color:#aeb3bd;text-align:left;text-overflow:ellipsis;white-space:nowrap;font:10px system-ui,sans-serif;cursor:pointer}.studio-document-tab-wrap.active .studio-document-tab{color:#eceef2}.studio-document-tab-close{width:22px;height:22px;margin-right:3px;border:0;border-radius:3px;background:transparent;color:#888e9a;font-size:15px;cursor:pointer}.studio-document-tab-close:hover{background:#383b43;color:#fff}
.studio-composer-add-text{padding:2px 5px;border:1px solid #393d46;border-radius:4px;background:#24272e;color:#dce0e7;font-size:9px;letter-spacing:0;cursor:pointer}.studio-composer-text-label{display:flex;flex-direction:column;gap:5px;margin:8px 0;color:#aeb3bd;font-size:10px}.studio-composer-text-label textarea{min-height:58px;resize:vertical;padding:6px;border:1px solid #383c46;border-radius:4px;background:#111216;color:#e9ebef;font:11px/1.4 system-ui,sans-serif}.studio-composer-field input[type=color]{width:42px;height:26px;padding:2px}
.studio-composer-tools{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:6px;width:min(100%,1080px);margin:0 auto 10px;color:#aeb3bd;font-size:10px}.studio-composer-tools button,.studio-composer-add-paint{padding:5px 7px;border:1px solid #393d46;border-radius:4px;background:#24272e;color:#dce0e7;font-size:10px;cursor:pointer}.studio-composer-tools button.active{border-color:#82995f;background:#303b29;color:#d8f3c2}.studio-composer-tools label{display:flex;align-items:center;gap:5px}.studio-composer-tools input[type=color]{width:32px;height:25px;padding:2px;border:1px solid #393d46;border-radius:4px;background:#111216}.studio-composer-tools input[type=range]{width:105px;accent-color:#b8ef6a}.studio-composer-tools output{min-width:35px;color:#e9ebef}.studio-composer-title-actions{display:flex;gap:4px}.studio-composer-add-paint{padding:2px 5px;color:#d8f3c2}
.studio-layout{max-width:none}.studio-layout>.right-panel{display:none}.studio-page{--studio-bg:#101114;--studio-panel:#17191e;--studio-border:#282b33;--studio-muted:#888e9a;--studio-text:#eceef2;--studio-accent:#b8ef6a;display:flex;flex:1;flex-direction:column;width:calc(100% - 240px);min-width:0;height:100dvh;min-height:620px;background:var(--studio-bg);color:var(--studio-text);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.studio-topbar{height:56px;flex:0 0 56px;display:flex;align-items:center;gap:22px;padding:0 20px;border-bottom:1px solid var(--studio-border);background:#15171b}.studio-brand{display:flex;align-items:center;gap:7px;color:var(--studio-text);font-weight:750;text-decoration:none;white-space:nowrap}.studio-brand i{color:#626874;font-style:normal}.studio-brand-mark{display:grid;place-items:center;width:23px;height:23px;border-radius:7px;background:var(--studio-accent);color:#182012;font-size:18px}.studio-project-name{display:flex;align-items:center;gap:8px;min-width:0;margin-right:auto;font-size:12px}.studio-project-title{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650}.studio-save-state{color:var(--studio-muted);font-size:11px}.studio-live-dot{width:7px;height:7px;border-radius:50%;background:var(--studio-accent)}.studio-top-actions{display:flex;gap:7px}.studio-button{border:1px solid var(--studio-border);border-radius:6px;padding:8px 11px;background:#202228;color:var(--studio-text);font-size:12px;font-weight:600;cursor:pointer}.studio-button:hover:not(:disabled){border-color:#555b67;background:#272a31}.studio-button:disabled{opacity:.45;cursor:default}.studio-create-post{background:var(--studio-accent);border-color:var(--studio-accent);color:#17200f}.studio-workspace{display:grid;grid-template-columns:58px 235px minmax(320px,1fr) 280px;flex:1;min-height:0}.studio-rail{display:flex;flex-direction:column;align-items:center;gap:7px;padding:14px 6px;border-right:1px solid var(--studio-border);background:#14161a}.studio-tool{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;width:46px;height:49px;border:0;border-radius:6px;background:transparent;color:#9da3ad;font-size:9px;cursor:pointer}.studio-tool b{font-size:17px;font-weight:500}.studio-tool:hover,.studio-tool.active{background:#292c33;color:var(--studio-accent)}.studio-assets,.studio-inspector{min-width:0;overflow:auto;background:var(--studio-panel)}.studio-assets{display:flex;flex-direction:column;border-right:1px solid var(--studio-border)}.studio-panel-heading,.studio-project-label{display:flex;align-items:center;gap:8px;padding:13px 14px;color:var(--studio-muted);font-size:10px;font-weight:700;letter-spacing:.07em}.studio-panel-heading{justify-content:space-between}.studio-add,.studio-tab-open,.studio-shortcut,.studio-timeline-add{border:1px solid transparent;border-radius:5px;background:transparent;color:var(--studio-muted);cursor:pointer}.studio-add{font-size:17px}.studio-add:hover,.studio-tab-open:hover,.studio-shortcut:hover,.studio-timeline-add:hover{border-color:var(--studio-border);color:var(--studio-text)}.studio-project-label{padding-top:5px;padding-bottom:8px;color:#d3d6dc;font-weight:600;letter-spacing:0}.studio-folder{color:var(--studio-accent)}.studio-count{margin-left:auto;color:var(--studio-muted)}.studio-file-list{display:flex;flex-direction:column;gap:2px;padding:0 7px}.studio-asset{display:flex;align-items:center;gap:8px;min-width:0;padding:8px;border:0;border-radius:5px;background:transparent;color:var(--studio-text);text-align:left;cursor:pointer}.studio-asset:hover,.studio-asset.active{background:#272a31}.studio-asset-icon{flex:0 0 24px;color:#abb0ba;text-align:center}.studio-kind-image{color:#7fc8ff}.studio-kind-video{color:#c8a8ff}.studio-kind-audio{color:#9bd77b}.studio-asset-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.studio-asset-size{margin-left:auto;color:var(--studio-muted);font-size:9px;white-space:nowrap}.studio-dropzone{display:flex;flex-direction:column;align-items:center;gap:6px;margin:18px 12px;padding:16px 8px;border:1px dashed #3c404a;border-radius:7px;background:#1b1d22;color:#d8dbe1;cursor:pointer}.studio-dropzone>span{color:var(--studio-accent);font-size:19px}.studio-dropzone small,.studio-sidebar-note{color:var(--studio-muted);font-size:10px}.studio-sidebar-note{margin:auto 13px 14px;line-height:1.6}.studio-sidebar-note a{color:var(--studio-accent);text-decoration:none}.studio-center{display:grid;grid-template-rows:38px minmax(180px,1fr) auto;min-width:0;min-height:0;background:#111216}.studio-tabs{display:flex;align-items:center;gap:9px;padding:0 12px;border-bottom:1px solid var(--studio-border);color:var(--studio-muted);font-size:11px}.studio-tab.active{color:var(--studio-text)}.studio-tab-open{font-size:15px}.studio-center-spacer{flex:1}.studio-shortcut{padding:4px 7px;font-size:10px}.studio-stage{position:relative;display:grid;place-items:center;min-height:0;overflow:auto;padding:22px;background:radial-gradient(ellipse at center,#1d2026 0,#111216 70%)}.studio-empty{display:flex;flex-direction:column;align-items:center;text-align:center}.studio-empty-art{position:relative;display:grid;place-items:center;width:180px;height:130px;margin-bottom:8px}.studio-orbit{position:absolute;width:130px;height:74px;border:1px solid #383d46;border-radius:50%;transform:rotate(-22deg)}.studio-orbit-two{transform:rotate(34deg)}.studio-empty-glyph{color:var(--studio-accent);font-size:46px}.studio-float{position:absolute;display:grid;place-items:center;width:29px;height:29px;border:1px solid #393e47;border-radius:8px;background:#20232a;color:#c8d1bd}.studio-float-image{top:16px;left:22px}.studio-float-audio{right:15px;top:38px}.studio-float-code{bottom:12px;left:38px;font-size:10px}.studio-float-game{right:37px;bottom:11px}.studio-empty h1{margin:8px 0;font-size:19px}.studio-empty p{max-width:360px;margin:0 0 15px;color:var(--studio-muted);font-size:12px}.studio-empty small{margin-top:9px;color:var(--studio-muted);font-size:10px}.studio-primary{background:var(--studio-accent);border-color:var(--studio-accent);color:#17200f}.studio-preview{display:flex;flex-direction:column;width:min(100%,900px);max-height:100%;min-height:0}.studio-preview-chrome{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 10px;border:1px solid var(--studio-border);border-bottom:0;border-radius:7px 7px 0 0;background:#1a1c21;color:#c7cbd2;font-size:10px}.studio-preview-actions{display:flex;gap:5px}.studio-preview-actions button{border:1px solid var(--studio-border);border-radius:4px;background:#252830;color:var(--studio-text);cursor:pointer}.studio-preview-content{display:flex;flex-direction:column;align-items:center;gap:10px;min-height:0;overflow:auto;padding:13px;border:1px solid var(--studio-border);border-radius:0 0 7px 7px;background:#17191e}.studio-image-preview{max-width:100%;max-height:58vh;object-fit:contain}.studio-video-preview{width:min(100%,820px);max-height:58vh;background:#000}.studio-preview-content audio{width:min(100%,620px);margin:24px auto}.studio-waveform{display:flex;align-items:center;gap:3px;width:min(100%,650px);height:75px}.studio-waveform i{flex:1;background:#567c48;border-radius:3px}.studio-audio-name{color:var(--studio-muted);font-size:11px}.studio-file-notice{max-width:560px;margin:auto;text-align:center;color:var(--studio-muted);font-size:12px;line-height:1.6}.studio-file-notice h2{color:var(--studio-text);font-size:16px}.studio-game-frame{width:min(100%,860px);height:min(56vh,600px);border:1px solid var(--studio-border);border-radius:6px;background:#fff}.studio-inspector{border-left:1px solid var(--studio-border)}.studio-inspector-tabs{display:flex;gap:20px;padding:14px;border-bottom:1px solid var(--studio-border);color:var(--studio-muted);font-size:11px}.studio-inspector-tabs .active{color:var(--studio-text)}.studio-inspector-body{padding:17px 15px;color:var(--studio-text)}.studio-inspector-body h2{overflow-wrap:anywhere;font-size:14px}.studio-inspector-body p{color:var(--studio-muted);font-size:11px;line-height:1.5}.studio-inspector-icon{font-size:21px;color:var(--studio-accent)}.studio-inspector-divider{height:1px;margin:14px 0;background:var(--studio-border)}.studio-format-title{margin-bottom:11px;color:var(--studio-muted);font-size:9px;font-weight:700;letter-spacing:.08em}.studio-format-list{display:grid;grid-template-columns:1fr;gap:5px}.studio-format-list span{margin-top:6px;color:#d8dbe1;font-size:9px;font-weight:700}.studio-format-list small{color:var(--studio-muted);font-size:10px}.studio-local-badge{margin-top:20px;padding:8px;border:1px solid #354333;border-radius:5px;color:#a6cf8a;font-size:10px}.studio-timeline{display:flex;flex-direction:column;min-height:0;max-height:290px;border-top:1px solid var(--studio-border);background:#17191e}.studio-timeline-head{display:flex;align-items:center;gap:7px;min-height:39px;padding:0 10px;border-bottom:1px solid var(--studio-border);color:#d9dce2;font-size:10px;font-weight:650}.studio-timeline-hint{margin-right:auto;color:var(--studio-muted);font-size:9px;font-weight:400}.studio-track{display:flex;align-items:stretch;min-height:45px;border-bottom:1px solid var(--studio-border)}.studio-track-label{position:sticky;left:0;z-index:2;display:grid;place-items:center;flex:0 0 54px;background:#1b1d22;color:var(--studio-muted);font-size:9px;font-weight:700}.studio-track-content{display:flex;align-items:center;gap:6px;min-width:0;overflow-x:auto;padding:5px 8px}.studio-track-empty{color:var(--studio-muted);font-size:10px}.studio-clip-list{display:flex;gap:6px}.studio-clip{display:flex;align-items:center;gap:7px;max-width:210px;padding:6px 9px;overflow:hidden;border:1px solid var(--studio-border);border-radius:5px;background:#24262d;color:var(--studio-text);text-overflow:ellipsis;white-space:nowrap;font-size:10px;cursor:pointer}.studio-clip.active{border-color:var(--studio-accent)}.studio-clip span{color:var(--studio-muted);font-size:8px;font-weight:700}
.studio-audio-workarea{overflow:auto;max-height:220px;background:#121318}.studio-audio-timeline{position:relative;min-width:100%;font-size:11px}.studio-audio-ruler{height:22px;position:relative;border-bottom:1px solid var(--studio-border);background:repeating-linear-gradient(90deg,transparent 0,transparent 208px,#292c34 209px,#292c34 210px)}.studio-audio-ruler>span{position:absolute;top:4px;color:var(--studio-muted);font-variant-numeric:tabular-nums}.studio-audio-lane{display:flex;min-height:48px;border-bottom:1px solid var(--studio-border)}.studio-audio-track-label{position:sticky;left:0;z-index:2;flex:0 0 48px;padding:17px 8px;background:#191b20;color:#9ea4af;border-right:1px solid var(--studio-border)}.studio-audio-lane-canvas{position:relative;min-height:47px;background:repeating-linear-gradient(90deg,transparent 0,transparent 41px,#202229 41px,#202229 42px)}.studio-audio-clip{position:absolute;top:5px;height:37px;overflow:hidden;border:1px solid #4e8142;border-radius:5px;background:#233a2a;color:#e7f5dd;text-align:left;cursor:grab}.studio-audio-clip.active{outline:1px solid var(--studio-accent)}.studio-audio-clip.muted{opacity:.48}.studio-audio-clip-name{position:absolute;z-index:1;left:6px;top:3px;max-width:calc(100% - 12px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.studio-audio-clip-wave{position:absolute;inset:17px 5px 2px;display:flex;align-items:center;gap:2px;opacity:.65}.studio-audio-clip-wave i{flex:1;min-width:1px;background:#9bd77b}.studio-audio-empty{padding:10px;color:var(--studio-muted)}.studio-timeline-head>button{border:1px solid var(--studio-border);border-radius:4px;background:#202228;color:var(--studio-text);padding:4px 8px;font-size:11px;cursor:pointer}.studio-timeline-head>button:disabled{opacity:.45;cursor:default}.studio-mix-status{max-width:190px;overflow:hidden;color:var(--studio-muted);text-overflow:ellipsis;white-space:nowrap;font-size:10px}.studio-property{display:flex;align-items:center;gap:8px;margin:12px 0;font-size:12px}.studio-property>span{flex:1}.studio-property input[type=number]{width:76px;padding:5px;border:1px solid var(--studio-border);border-radius:4px;background:#111216;color:var(--studio-text)}.studio-property small{color:var(--studio-muted)}.studio-property input[type=range]{width:105px}.studio-mute-property{justify-content:flex-start}.studio-mute-property input{accent-color:var(--studio-accent)}
.studio-video-workarea{overflow:auto;max-height:100px;background:#121318}.studio-video-timeline{position:relative;min-width:100%;font-size:11px}.studio-video-ruler{height:22px;position:relative;border-bottom:1px solid var(--studio-border);background:repeating-linear-gradient(90deg,transparent 0,transparent 208px,#292c34 209px,#292c34 210px)}.studio-video-ruler>span{position:absolute;top:4px;color:var(--studio-muted);font-variant-numeric:tabular-nums}.studio-video-lane{display:flex;min-height:46px;border-bottom:1px solid var(--studio-border)}.studio-video-track-label{position:sticky;left:0;z-index:2;flex:0 0 48px;padding:16px 8px;background:#191b20;color:#9ea4af;border-right:1px solid var(--studio-border)}.studio-video-lane-canvas{position:relative;min-height:45px;background:repeating-linear-gradient(90deg,transparent 0,transparent 41px,#202229 41px,#202229 42px)}.studio-video-clip{position:absolute;top:5px;height:35px;overflow:hidden;border:1px solid #69519b;border-radius:5px;background:#34294a;color:#eee6ff;text-align:left;text-overflow:ellipsis;white-space:nowrap;cursor:grab}.studio-video-clip.active{outline:1px solid #c8a8ff}.studio-video-hint{color:var(--studio-muted);font-size:11px}
.studio-code-workbench{display:flex;flex-direction:column;min-height:280px;max-height:48vh;border:1px solid var(--studio-border);border-radius:6px;background:#101116;overflow:hidden}.studio-code-toolbar{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:6px;border-bottom:1px solid var(--studio-border)}.studio-code-toolbar input{min-width:70px;width:22%;padding:5px 7px;border:1px solid var(--studio-border);border-radius:4px;background:#191b20;color:var(--studio-text);font:11px system-ui,sans-serif}.studio-code-toolbar input[type=number]{width:54px}.studio-code-toolbar button,.studio-code-run{padding:5px 8px;border:1px solid var(--studio-border);border-radius:4px;background:#202228;color:var(--studio-text);font-size:11px;cursor:pointer}.studio-code-row{display:flex;flex:1;min-height:0;overflow:hidden}.studio-code-gutter{flex:0 0 42px;padding:12px 8px 12px 0;overflow:hidden;background:#15161b;color:#686e7a;text-align:right;white-space:pre;font:12px/20px ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none}.studio-code-editor{flex:1;min-width:0;min-height:260px;padding:12px;border:0;outline:0;resize:vertical;background:#101116;color:#e3e5eb;caret-color:#b8ef6a;font:12px/20px ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:2;white-space:pre;overflow:auto}.studio-code-run{margin:8px 0}.studio-code-output{min-height:80px}.studio-code-preview{width:100%;height:250px;border:1px solid var(--studio-border);border-radius:6px;background:white}
.studio-new-file{border-color:#46563a;color:#d8f3c2}.studio-starter-overlay{position:fixed;z-index:1100;inset:0;display:grid;place-items:center;padding:20px;background:#080a0dcc;color:#eceef2;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.studio-starter-dialog{display:flex;flex-direction:column;gap:14px;width:min(100%,440px);padding:20px;border:1px solid #383c46;border-radius:10px;background:#181a1f;box-shadow:0 20px 80px #000b}.studio-starter-dialog header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.studio-starter-dialog h2{margin:0;font-size:16px}.studio-starter-dialog header p,.studio-starter-help{margin:5px 0 0;color:#9298a3;font-size:11px;line-height:1.5}.studio-starter-dialog label{display:flex;flex-direction:column;gap:6px;color:#c6cbd4;font-size:11px}.studio-starter-dialog select,.studio-starter-dialog input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #393d46;border-radius:5px;background:#111216;color:#e9ebef;font:12px system-ui,sans-serif}.studio-starter-dialog input:focus,.studio-starter-dialog select:focus{outline:1px solid #b8ef6a}.studio-starter-error{min-height:15px;margin:0;color:#ff9c9c;font-size:11px}.studio-starter-dialog footer{display:flex;justify-content:flex-end;gap:8px}.studio-starter-dialog footer button,.studio-starter-close{padding:8px 11px;border:1px solid #393d46;border-radius:5px;background:#24272e;color:#e7e9ee;font:11px system-ui,sans-serif;cursor:pointer}.studio-starter-dialog footer .studio-starter-create{border-color:#b8ef6a;background:#b8ef6a;color:#17200f;font-weight:700}.studio-starter-close{width:32px;padding:2px;font-size:20px!important}.studio-starter-dialog button:focus-visible{outline:2px solid #b8ef6a;outline-offset:2px}
.studio-zip-editor-overlay{inset:3vh 4vw;overflow:hidden;border:1px solid #383c46;border-radius:9px;box-shadow:0 20px 80px #000b}.studio-zip-editor-overlay .studio-composer-header>div:last-child{align-items:center}.studio-zip-file-select{max-width:min(38vw,420px);padding:7px 9px;border:1px solid #393d46;border-radius:5px;background:#202228;color:#e7e9ee;font:11px system-ui,sans-serif}.studio-zip-new-source{position:relative}.studio-zip-new-source-form{position:absolute;z-index:12;top:calc(100% + 6px);right:0;display:flex;align-items:center;gap:5px;padding:7px;border:1px solid #393d46;border-radius:6px;background:#181a1f;box-shadow:0 8px 24px #0009}.studio-zip-new-source-form[hidden]{display:none}.studio-zip-new-source-path{width:min(42vw,240px);padding:7px 8px;border:1px solid #393d46;border-radius:4px;background:#111216;color:#e9ebef;font:11px system-ui,sans-serif}.studio-zip-editor-body{display:flex;flex:1;flex-direction:column;min-height:0;padding:12px;background:#111216}.studio-zip-editor-status{min-height:24px;color:#aeb3bd;font-size:11px}.studio-zip-editor-host{display:flex;flex:1;min-height:0}.studio-zip-editor-host .studio-code-workbench{flex:1;max-height:none}
.studio-audio-envelope{position:absolute;z-index:2;left:5px;right:5px;top:17px;height:18px;overflow:visible;pointer-events:none}.studio-audio-envelope polyline{fill:none;stroke:#f1e678;stroke-width:1.5;vector-effect:non-scaling-stroke;opacity:.95}.studio-audio-envelope-point{fill:#fff4a3;stroke:#4c4724;stroke-width:1;vector-effect:non-scaling-stroke;pointer-events:all;cursor:ns-resize;touch-action:none}.studio-audio-envelope-point:hover{r:3}
.studio-add-envelope-point{float:right;padding:3px 5px;border:1px solid #3b3d44;border-radius:4px;background:#24262c;color:#d8f3c2;font-size:9px;cursor:pointer}.studio-add-envelope-point:hover{border-color:#82995f;background:#303b29}
.studio-sequence-player{position:absolute;z-index:5;inset:6% 8%;width:84%;height:88%;max-height:88%;background:#000;border:1px solid var(--studio-border);border-radius:8px;box-shadow:0 12px 40px #0009}
.studio-sequence-transition-player{position:absolute;z-index:5;inset:6% 8%;width:84%;height:88%;max-height:88%;background:#000;border:1px solid var(--studio-border);border-radius:8px;pointer-events:none;transition:opacity .12s linear}
.studio-composer-button{border:1px solid #536843!important;background:#273323!important;color:#d8f3c2!important}.studio-composer-overlay{position:fixed;z-index:1000;inset:0;display:flex;flex-direction:column;background:#111216;color:#eceef2;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.studio-composer-header{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:58px;padding:8px 18px;border-bottom:1px solid #30333a;background:#181a1f}.studio-composer-header>div:first-child{display:flex;flex-direction:column;gap:4px}.studio-composer-header b{font-size:13px}.studio-composer-header small{color:#9298a3;font-size:10px}.studio-composer-header>div:last-child{display:flex;gap:8px}.studio-composer-header button,.studio-composer-order button,.studio-composer-remove{border:1px solid #393d46;border-radius:5px;background:#24272e;color:#e7e9ee;padding:7px 10px;font-size:11px;cursor:pointer}.studio-composer-export{background:#b8ef6a!important;border-color:#b8ef6a!important;color:#17200f!important;font-weight:700}.studio-composer-header .studio-composer-close{width:32px;padding:2px;font-size:21px}.studio-composer-layout{display:grid;grid-template-columns:minmax(0,1fr) 280px;flex:1;min-height:0}.studio-composer-board{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:0;min-height:0;padding:16px;background:#101115}.studio-composer-canvas-wrap{width:min(72vw,68vh);height:min(72vw,68vh);max-width:100%;max-height:100%;background-color:#202228;background-image:linear-gradient(45deg,#2b2d34 25%,transparent 25%),linear-gradient(-45deg,#2b2d34 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#2b2d34 75%),linear-gradient(-45deg,transparent 75%,#2b2d34 75%);background-size:24px 24px;background-position:0 0,0 12px,12px -12px,-12px 0}.studio-composer-canvas{display:block;width:100%;height:100%;touch-action:none;cursor:move}.studio-composer-status{min-height:22px;padding-top:8px;color:#f0a4a4;font-size:11px}.studio-composer-panel{min-width:0;overflow:auto;padding:12px;border-left:1px solid #30333a;background:#181a1f}.studio-composer-section{margin-bottom:17px}.studio-composer-title{display:flex;justify-content:space-between;margin-bottom:8px;color:#9298a3;font-size:9px;font-weight:700;letter-spacing:.08em}.studio-composer-count{color:#c1c5cd}.studio-composer-assets,.studio-composer-layers{display:flex;flex-direction:column;gap:4px;max-height:175px;overflow:auto}.studio-composer-asset,.studio-composer-layer{display:flex;align-items:center;gap:6px;min-width:0;border:1px solid transparent;border-radius:5px;background:#202229;color:#e4e6eb;font-size:10px}.studio-composer-asset{padding:7px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.studio-composer-asset:hover{border-color:#61764d}.studio-composer-layer{padding:3px}.studio-composer-layer.active{border-color:#b8ef6a}.studio-composer-layer-select{flex:1;min-width:0;padding:5px;border:0;background:transparent;color:inherit;text-align:left;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;font-size:10px;cursor:pointer}.studio-composer-visibility{border:0;background:transparent;color:#c2c7d0;cursor:pointer}.studio-composer-properties{padding-top:3px}.studio-composer-layer-name{margin-bottom:9px;overflow:hidden;color:#dce0e7;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.studio-composer-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.studio-composer-grid label,.studio-composer-field{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:6px 0;color:#aeb3bd;font-size:10px}.studio-composer-grid input,.studio-composer-field input,.studio-composer-field select{width:90px;padding:5px;border:1px solid #383c46;border-radius:4px;background:#111216;color:#e9ebef;font:11px system-ui,sans-serif}.studio-composer-field select{width:125px}.studio-composer-range{display:flex;flex-wrap:wrap;justify-content:space-between;gap:5px;margin:12px 0;color:#aeb3bd;font-size:10px}.studio-composer-range input{width:100%;accent-color:#b8ef6a}.studio-composer-range output{color:#e9ebef}.studio-composer-order{display:flex;gap:6px;margin:11px 0}.studio-composer-order button{flex:1;padding:6px 4px;font-size:9px}.studio-composer-remove{width:100%;margin-top:4px;border-color:#5c3737;color:#f0b8b8}.studio-composer-properties>p{color:#9298a3;font-size:10px}
@media(max-width:1050px){.studio-workspace{grid-template-columns:58px 190px minmax(300px,1fr)}.studio-inspector{display:none}.studio-topbar{padding:0 12px}.studio-project-name{display:none}}
@media(max-width:768px){.studio-page{width:100%;height:calc(100dvh - var(--bottom-nav-h, 62px));min-height:420px}.studio-workspace{grid-template-columns:48px minmax(0,1fr)}.studio-assets{display:none}.studio-rail{padding:10px 3px}.studio-tool{width:42px;height:47px}.studio-topbar{height:50px;flex-basis:50px;padding:0 8px}.studio-brand{font-size:13px}.studio-top-actions{gap:4px}.studio-top-actions .studio-button{padding:7px 8px;font-size:10px}.studio-top-actions .studio-new-file{width:30px;min-width:30px;padding:7px 0;font-size:0}.studio-new-file::before{content:"＋";font-size:14px}.studio-empty-art{transform:scale(.8);margin:-12px 0}.studio-empty h1{font-size:16px}.studio-empty p{max-width:260px;line-height:1.5}.studio-timeline{height:205px;max-height:44vh}.studio-timeline-head{overflow-x:auto;flex:0 0 39px}.studio-timeline-hint{display:none}.studio-timeline-head>button{flex:0 0 auto}.studio-video-workarea{max-height:62px}.studio-video-ruler{height:17px}.studio-video-ruler>span{top:2px}.studio-video-lane{min-height:40px}.studio-video-track-label{padding:13px 7px}.studio-video-lane-canvas{min-height:39px}.studio-video-clip{height:30px}.studio-track{min-height:38px}.studio-audio-workarea{max-height:95px}.studio-audio-ruler{height:17px}.studio-audio-ruler>span{top:2px}.studio-audio-lane{min-height:40px}.studio-audio-track-label{padding:13px 7px}.studio-audio-lane-canvas{min-height:39px}.studio-audio-clip{height:30px}.studio-sequence-player,.studio-sequence-overlays{inset:8% 3%;width:94%;height:84%}}
@media(max-width:768px){.studio-composer-preview-controls{gap:8px;padding:5px 9px}.studio-composer-layout{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) 205px}.studio-composer-board{padding:8px}.studio-composer-canvas-wrap{width:min(78vw,48vh);height:min(78vw,48vh)}.studio-composer-panel{padding:8px;border-top:1px solid #30333a;border-left:0}.studio-composer-section{margin-bottom:9px}.studio-composer-assets,.studio-composer-layers{max-height:65px}}
`;

if (!document.getElementById('studio-page-styles')) {
  const style = document.createElement('style');
  style.id = 'studio-page-styles';
  style.textContent = `${studioCss}
.studio-timeline-head{flex-wrap:nowrap;white-space:nowrap}
.studio-timeline-head>button,.studio-timeline-hint{flex:0 0 auto;white-space:nowrap}
.studio-video-workarea{max-height:150px}
.studio-audio-record{border-color:#80504b!important;color:#ffc1b7!important}
.studio-audio-record[aria-pressed=true]{background:#743c39!important;color:#fff!important}
.studio-picture-clip{border-color:#3d7599;background-color:#244259;color:#e0f4ff}
.studio-sequence-pip-player{position:absolute;z-index:6;background:#000;border:2px solid #fff;border-radius:8px;box-shadow:0 8px 28px #000a;pointer-events:none}
@media(max-width:768px){.studio-video-workarea{max-height:108px}}
`;
  document.head.appendChild(style);
}
