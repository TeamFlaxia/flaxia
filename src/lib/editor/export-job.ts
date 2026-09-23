import { type AudioEditState, encodeAudioFile } from './audio-editor.ts';
import { runFFmpeg } from './ffmpeg-client.ts';
import { buildGifEditArgs, type ImageEditState } from './image-editor.ts';
import { defaultTargetBytes, tightenVideoPlan } from './render-preset.ts';
import { encodeVideoFile, type VideoEditState, type VideoMeta } from './video-editor.ts';

/**
 * A serializable encode request. The editor modal executes jobs inline
 * (single-threaded core) and the export popup executes the same jobs with the
 * multithreaded core — one code path, two execution environments.
 */
export type ExportJob =
  | { kind: 'audio'; file: File; state: AudioEditState }
  | { kind: 'video'; file: File; meta: VideoMeta; state: VideoEditState }
  | { kind: 'gif'; file: File; width: number; height: number; state: ImageEditState };

export interface ExportHooks {
  onProgress?: (ratio: number) => void;
  /** Returns true when the user aborted the render. */
  signal?: () => boolean;
  /** Load the multithreaded core (requires cross-origin isolation). */
  multithreaded?: boolean;
}

function safeBaseName(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}

function inputFsName(name: string): string {
  const ext = (name.toLowerCase().split('.').pop() || 'bin').replace(/[^a-z0-9]/g, '');
  return `input.${ext || 'bin'}`;
}

async function runGifJob(job: Extract<ExportJob, { kind: 'gif' }>, hooks: ExportHooks): Promise<File> {
  const bytes = new Uint8Array(await job.file.arrayBuffer());
  const inputName = inputFsName(job.file.name);
  const outputName = 'output.gif';
  const data = await runFFmpeg({
    inputs: [{ name: inputName, data: bytes }],
    args: buildGifEditArgs(job.width, job.height, job.state, inputName, outputName),
    outputName,
    onProgress: hooks.onProgress,
    signal: hooks.signal,
    multithreaded: hooks.multithreaded,
  });
  if (data.byteLength > defaultTargetBytes()) throw new Error('output-too-large');
  const base = safeBaseName(job.file.name) || 'media';
  return new File([data as BlobPart], `${base}.gif`, { type: 'image/gif' });
}

/** Executes an export job in the current document (popup or inline fallback). */
export async function runExportJob(job: ExportJob, hooks: ExportHooks = {}): Promise<File> {
  if (job.kind === 'audio') {
    return encodeAudioFile(job.file, job.state, {
      onProgress: hooks.onProgress,
      signal: hooks.signal,
      multithreaded: hooks.multithreaded,
    });
  }
  if (job.kind === 'video') {
    return encodeVideoFile(job.file, job.meta, job.state, {
      onProgress: hooks.onProgress,
      signal: hooks.signal,
      multithreaded: hooks.multithreaded,
      tighten: tightenVideoPlan,
    });
  }
  return runGifJob(job, hooks);
}
