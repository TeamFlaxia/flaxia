import { type AudioTimelineClip, mixAudioTimeline } from './audio-mixer.ts';
import { probeFFmpegStreams, runFFmpeg } from './ffmpeg-client.ts';
import type { StudioVideoClip } from './studio-project-store.ts';

const MAX_INPUT_BYTES = 80 * 1024 * 1024;
const MAX_DURATION_SECONDS = 180;

function inputName(index: number, file: File): string {
  const extension =
    file.name
      .toLowerCase()
      .split('.')
      .pop()
      ?.replace(/[^a-z0-9]/g, '') || 'mp4';
  return `sequence-${index}.${extension}`;
}

async function probeAudioStreams(inputs: Array<{ name: string; data: Uint8Array }>): Promise<boolean[]> {
  const args = ['-hide_banner', ...inputs.flatMap((input) => ['-i', input.name])];
  const logs = await probeFFmpegStreams(inputs, args);
  return inputs.map((_, index) => new RegExp(`Stream #${index}:\\d+.*Audio:`).test(logs));
}

/** Encode ordered, trimmed video clips into one H.264/AAC MP4 on-device. */
export async function renderVideoSequence(
  files: File[],
  clips: StudioVideoClip[],
  audioClips: AudioTimelineClip[],
  onProgress?: (ratio: number) => void,
): Promise<File> {
  const ordered = [...clips].sort((left, right) => left.start - right.start);
  if (ordered.length === 0) throw new Error('Add a video clip to the timeline first');
  if (ordered.length > 12) throw new Error('Video sequences support up to 12 clips per export');
  const durations = ordered.map((clip) => clip.sourceEnd - clip.sourceStart);
  if (durations.some((length) => !Number.isFinite(length) || length <= 0)) {
    throw new Error('Video sequences must be between 0 and 3 minutes');
  }
  const timelineSegments: Array<{ kind: 'clip'; clipIndex: number } | { kind: 'gap'; duration: number }> = [];
  let duration = 0;
  for (let index = 0; index < ordered.length; index++) {
    const clipStart = Math.max(duration, ordered[index].start);
    const gap = clipStart - duration;
    if (gap > 0.04) timelineSegments.push({ kind: 'gap', duration: gap });
    timelineSegments.push({ kind: 'clip', clipIndex: index });
    duration = clipStart + durations[index];
  }
  if (duration > MAX_DURATION_SECONDS) throw new Error('Video sequences must be between 0 and 3 minutes');

  const uniqueFiles = [...new Set(ordered.map((clip) => clip.fileIndex))];
  const fileBytes = new Map<number, Uint8Array>();
  let totalBytes = 0;
  for (const index of uniqueFiles) {
    const file = files[index];
    if (!file || !file.type.startsWith('video/')) throw new Error('A timeline clip is not a playable video');
    if (file.size > MAX_INPUT_BYTES - totalBytes) throw new Error('Video sequence inputs exceed 80 MB');
    totalBytes += file.size;
    fileBytes.set(index, new Uint8Array(await file.arrayBuffer()));
  }

  const indexByFile = new Map(uniqueFiles.map((fileIndex, index) => [fileIndex, index]));
  const inputs = uniqueFiles.map((fileIndex, index) => ({
    name: inputName(index, files[fileIndex]),
    data: fileBytes.get(fileIndex)!,
  }));
  const hasAudio = await probeAudioStreams(inputs);
  const sourceInputs: Array<{ name: string; data: Uint8Array }> = [];
  const clipSources = ordered.map((clip, sourceOrdinal) => {
    const fileIndex = indexByFile.get(clip.fileIndex)!;
    const name = `clip-${sourceOrdinal}.${inputs[fileIndex].name.split('.').pop()}`;
    sourceInputs.push({ name, data: fileBytes.get(clip.fileIndex)!.slice() });
    return { clip, name, hasAudio: hasAudio[fileIndex] };
  });
  // Build a distinct input per timeline clip so each trim can use its own seek.
  const args: string[] = [];
  for (let index = 0; index < clipSources.length; index++) {
    const { clip, name } = clipSources[index];
    args.push('-ss', clip.sourceStart.toFixed(3), '-t', (clip.sourceEnd - clip.sourceStart).toFixed(3), '-i', name);
  }

  const filters: string[] = [];
  const concatInputs: string[] = [];
  for (let segmentIndex = 0; segmentIndex < timelineSegments.length; segmentIndex++) {
    const segment = timelineSegments[segmentIndex];
    if (segment.kind === 'gap') {
      filters.push(`color=c=black:s=1280x720:r=30:d=${segment.duration.toFixed(3)},format=yuv420p[vg${segmentIndex}]`);
      filters.push(
        `anullsrc=channel_layout=stereo:sample_rate=44100:d=${segment.duration.toFixed(3)}[ag${segmentIndex}]`,
      );
      concatInputs.push(`[vg${segmentIndex}]`, `[ag${segmentIndex}]`);
      continue;
    }
    const index = segment.clipIndex;
    const clipDuration = durations[index];
    filters.push(
      `[${index}:v:0]trim=duration=${clipDuration.toFixed(3)},setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${index}]`,
    );
    if (clipSources[index].hasAudio) {
      filters.push(
        `[${index}:a:0]atrim=duration=${clipDuration.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[a${index}]`,
      );
    } else {
      filters.push(`anullsrc=channel_layout=stereo:sample_rate=44100:d=${clipDuration.toFixed(3)}[silence${index}]`);
    }
    concatInputs.push(`[v${index}]`);
    concatInputs.push(clipSources[index].hasAudio ? `[a${index}]` : `[silence${index}]`);
  }
  filters.push(`${concatInputs.join('')}concat=n=${timelineSegments.length}:v=1:a=1[outv][outa]`);
  const audioBitrate = 96;
  const videoBitrate = Math.max(
    350,
    Math.min(3000, Math.floor((24 * 1024 * 1024 * 8 * 0.82) / duration / 1000) - audioBitrate),
  );
  const outputBytes = await runFFmpeg({
    inputs: sourceInputs,
    args: [
      ...args,
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[outv]',
      '-map',
      '[outa]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-b:v',
      `${videoBitrate}k`,
      '-maxrate',
      `${Math.round(videoBitrate * 1.25)}k`,
      '-bufsize',
      `${videoBitrate * 2}k`,
      '-c:a',
      'aac',
      '-b:a',
      `${audioBitrate}k`,
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      'studio-sequence.mp4',
    ],
    outputName: 'studio-sequence.mp4',
    onProgress: onProgress ? (ratio) => onProgress(ratio * (audioClips.length ? 0.72 : 1)) : undefined,
  });
  let finalBytes = outputBytes;
  const hasAudioMix = audioClips.some((clip) => !clip.muted && clip.sourceEnd > clip.sourceStart);
  if (hasAudioMix) {
    const mixedAudio = await mixAudioTimeline(files, audioClips);
    const audioBytes = new Uint8Array(await mixedAudio.arrayBuffer());
    finalBytes = await runFFmpeg({
      inputs: [
        { name: 'sequence-with-source-audio.mp4', data: outputBytes },
        { name: 'studio-audio-mix.wav', data: audioBytes },
      ],
      args: [
        '-i',
        'sequence-with-source-audio.mp4',
        '-i',
        'studio-audio-mix.wav',
        '-filter_complex',
        '[0:a:0]aresample=44100[va];[1:a:0]aresample=44100[ma];[va][ma]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,alimiter=limit=0.95[aout]',
        '-map',
        '0:v:0',
        '-map',
        '[aout]',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-shortest',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        'studio-final.mp4',
      ],
      outputName: 'studio-final.mp4',
      onProgress: onProgress ? (ratio) => onProgress(0.72 + ratio * 0.28) : undefined,
    });
  }
  const output = new File([finalBytes as BlobPart], 'flaxia-video-sequence.mp4', { type: 'video/mp4' });
  if (output.size > 25 * 1024 * 1024) throw new Error('Rendered video exceeds the 25 MB post attachment limit');
  return output;
}
