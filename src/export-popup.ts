import { type ExportJob, runExportJob } from './lib/editor/export-job.ts';
import {
  EXPORT_CHANNEL_NAME,
  EXPORT_UNREACHABLE,
  type MainToPopup,
  type PopupToMain,
} from './lib/editor/export-popup-protocol.ts';
import { terminateFFmpeg } from './lib/editor/ffmpeg-client.ts';
import { initI18n, t } from './lib/i18n.ts';

const titleEl = document.getElementById('ep-title');
const fileEl = document.getElementById('ep-file');
const statusEl = document.getElementById('ep-status');
const barEl = document.getElementById('ep-bar');
const cancelEl = document.getElementById('ep-cancel') as HTMLButtonElement | null;
const noteEl = document.getElementById('ep-note');

let channel: BroadcastChannel | null = null;
let bootDone = false;
const queue: MainToPopup[] = [];
let busy = false;
let currentId: string | null = null;
let cancelled = false;
let firstProgress = false;
let currentFile = '';

function post(message: PopupToMain): void {
  channel?.postMessage(message);
}

function applyLabels(): void {
  if (titleEl) titleEl.textContent = t('editor.title');
  if (cancelEl) cancelEl.textContent = t('editor.cancel');
  if (noteEl) noteEl.textContent = crossOriginIsolated ? t('editor.export_note') : '';
  fileEl && (fileEl.textContent = currentFile);
  idleStatus();
}

function idleStatus(): void {
  if (statusEl) {
    statusEl.textContent = crossOriginIsolated ? t('editor.export_ready') : t('editor.export_unavailable');
  }
}

function setBar(ratio: number): void {
  if (barEl) barEl.style.width = `${Math.round(Math.min(Math.max(ratio, 0), 1) * 100)}%`;
}

async function startJob(id: string, job: ExportJob): Promise<void> {
  if (!crossOriginIsolated) {
    post({ type: 'error', id, message: EXPORT_UNREACHABLE });
    return;
  }
  busy = true;
  currentId = id;
  cancelled = false;
  firstProgress = false;
  currentFile = job.file.name;
  if (fileEl) fileEl.textContent = currentFile;
  if (cancelEl) cancelEl.disabled = false;
  if (statusEl) statusEl.textContent = t('editor.loading_core');
  setBar(0.02);
  post({ type: 'accepted', id });
  try {
    const file = await runExportJob(job, {
      onProgress: (ratio) => {
        if (!firstProgress) {
          firstProgress = true;
          if (statusEl) statusEl.textContent = t('editor.processing');
        }
        setBar(0.1 + ratio * 0.9);
        if (!cancelled) post({ type: 'progress', id, ratio });
      },
      signal: () => cancelled,
      multithreaded: true,
    });
    if (cancelled) {
      post({ type: 'cancelled', id });
    } else {
      setBar(1);
      post({ type: 'result', id, file });
    }
  } catch (error) {
    if (cancelled || (error instanceof Error && error.message === 'render cancelled')) {
      post({ type: 'cancelled', id });
    } else {
      post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    busy = false;
    currentId = null;
    cancelled = false;
    if (cancelEl) cancelEl.disabled = true;
    setBar(0);
    idleStatus();
  }
}

function handle(message: MainToPopup): void {
  if (!message || typeof message.type !== 'string') return;
  switch (message.type) {
    case 'ping':
      post({ type: 'ready', isolated: crossOriginIsolated === true });
      return;
    case 'bye':
      channel?.close();
      channel = null;
      try {
        window.close();
      } catch {
        /* may be blocked; the page becomes inert with no channel */
      }
      return;
    case 'job':
      // Jobs arrive on both BroadcastChannel and WindowProxy — dedupe.
      if (busy || message.id === currentId) return;
      void startJob(message.id, message.job);
      return;
    case 'cancel':
      if (!busy || message.id !== currentId) return;
      cancelled = true;
      terminateFFmpeg();
      return;
  }
}

function onChannelMessage(data: unknown): void {
  const message = data as MainToPopup;
  if (!bootDone) queue.push(message);
  else handle(message);
}

cancelEl?.addEventListener('click', () => {
  if (!busy || !currentId) return;
  cancelled = true;
  terminateFFmpeg();
});

async function boot(): Promise<void> {
  channel = new BroadcastChannel(EXPORT_CHANNEL_NAME);
  channel.onmessage = (event) => onChannelMessage(event.data);
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    onChannelMessage(event.data);
  });
  await initI18n().catch(() => {});
  applyLabels();
  bootDone = true;
  for (const message of queue) handle(message);
  queue.length = 0;
  post({ type: 'ready', isolated: crossOriginIsolated === true });
}

void boot();
