import { type AudioTimelineClip, mixAudioTimeline } from './audio-mixer.ts';
import { probeFFmpegStreams, runFFmpeg } from './ffmpeg-client.ts';
import { imageLayerCanvasFilter, imageLayerSourceRect } from './image-adjustments.ts';
import type { StudioImageLayer, StudioVideoClip } from './studio-project-store.ts';

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

interface TimedOverlay {
  name: string;
  data: Uint8Array;
  start: number;
  end: number;
}

async function renderLayerOverlayFrame(
  layers: StudioImageLayer[],
  bitmaps: Map<number, ImageBitmap>,
): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create the video overlay canvas');
  const scale = 2 / 3;
  for (const layer of layers) {
    context.save();
    context.globalAlpha = layer.opacity;
    context.globalCompositeOperation = layer.blend === 'normal' ? 'source-over' : layer.blend;
    context.translate(280 + (layer.x + layer.width / 2) * scale, (layer.y + layer.height / 2) * scale);
    context.rotate((layer.rotation * Math.PI) / 180);
    if (layer.kind === 'text') {
      context.beginPath();
      context.rect((-layer.width * scale) / 2, (-layer.height * scale) / 2, layer.width * scale, layer.height * scale);
      context.clip();
      const fontSize = (layer.fontSize ?? 72) * scale;
      context.fillStyle = layer.color ?? '#ffffff';
      context.font = `${fontSize}px ${layer.fontFamily ?? 'sans-serif'}`;
      context.textBaseline = 'middle';
      (layer.text ?? '')
        .split('\n')
        .slice(0, 20)
        .forEach((line, index) => {
          context.fillText(
            line,
            (-layer.width * scale) / 2,
            (-layer.height * scale) / 2 + fontSize * 0.7 + index * fontSize * 1.2,
            layer.width * scale,
          );
        });
    } else {
      const bitmap = bitmaps.get(layer.fileIndex);
      if (!bitmap) throw new Error('A video overlay layer is not an image');
      context.filter = imageLayerCanvasFilter(layer);
      const source = imageLayerSourceRect(layer, bitmap.width, bitmap.height);
      context.drawImage(
        bitmap,
        source.x,
        source.y,
        source.width,
        source.height,
        (-layer.width * scale) / 2,
        (-layer.height * scale) / 2,
        layer.width * scale,
        layer.height * scale,
      );
    }
    context.restore();
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error('Could not encode video overlay layers'))),
      'image/png',
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}

async function renderTimedLayerOverlays(
  files: File[],
  layers: StudioImageLayer[],
  duration: number,
): Promise<TimedOverlay[]> {
  const visibleLayers = layers.filter(
    (layer) => layer.visible && (layer.start ?? 0) < duration && (layer.end ?? duration) > 0,
  );
  if (visibleLayers.length === 0) return [];
  const bitmaps = new Map<number, ImageBitmap>();
  try {
    for (const layer of visibleLayers) {
      if (layer.kind !== 'image' || bitmaps.has(layer.fileIndex)) continue;
      const file = files[layer.fileIndex];
      if (!file || !file.type.startsWith('image/')) throw new Error('A video overlay layer is not an image');
      bitmaps.set(layer.fileIndex, await createImageBitmap(file));
    }
    const boundaries = [
      ...new Set([
        0,
        duration,
        ...visibleLayers.flatMap((layer) => [
          Math.max(0, Math.min(duration, layer.start ?? 0)),
          Math.max(0, Math.min(duration, layer.end ?? duration)),
        ]),
      ]),
    ].sort((left, right) => left - right);
    const overlays: TimedOverlay[] = [];
    for (let index = 0; index < boundaries.length - 1; index++) {
      const start = boundaries[index];
      const end = boundaries[index + 1];
      if (end - start <= 0.001) continue;
      const midpoint = start + (end - start) / 2;
      const active = visibleLayers.filter(
        (layer) => midpoint >= (layer.start ?? 0) && midpoint < (layer.end ?? duration),
      );
      if (active.length === 0) continue;
      overlays.push({
        name: `studio-overlay-${overlays.length}.png`,
        data: await renderLayerOverlayFrame(active, bitmaps),
        start,
        end,
      });
    }
    return overlays;
  } finally {
    for (const bitmap of bitmaps.values()) bitmap.close();
  }
}

/** Encode ordered, trimmed video clips, audio, and image/text overlays into one MP4 on-device. */
export async function renderVideoSequence(
  files: File[],
  clips: StudioVideoClip[],
  audioClips: AudioTimelineClip[],
  imageLayers: StudioImageLayer[],
  onProgress?: (ratio: number) => void,
): Promise<File> {
  const ordered = [...clips].sort((left, right) => left.start - right.start);
  if (ordered.length === 0) throw new Error('Add a video clip to the timeline first');
  if (ordered.length > 12) throw new Error('Video sequences support up to 12 clips per export');
  const sourceDurations = ordered.map((clip) => clip.sourceEnd - clip.sourceStart);
  const speeds = ordered.map((clip) => Math.max(0.5, Math.min(2, clip.speed ?? 1)));
  const durations = sourceDurations.map((length, index) => length / speeds[index]);
  if (sourceDurations.some((length) => !Number.isFinite(length) || length <= 0)) {
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

  const overlayImageIndices = [
    ...new Set(
      imageLayers
        .filter(
          (layer) =>
            layer.visible && layer.kind === 'image' && (layer.start ?? 0) < duration && (layer.end ?? duration) > 0,
        )
        .map((layer) => layer.fileIndex),
    ),
  ];
  const uniqueFiles = [...new Set([...ordered.map((clip) => clip.fileIndex), ...overlayImageIndices])];
  const fileBytes = new Map<number, Uint8Array>();
  let totalBytes = 0;
  for (const index of uniqueFiles) {
    const file = files[index];
    const isVideo = ordered.some((clip) => clip.fileIndex === index);
    if (!file || (isVideo ? !file.type.startsWith('video/') : !file.type.startsWith('image/')))
      throw new Error('A timeline layer has an unsupported media type');
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
  const overlays = await renderTimedLayerOverlays(files, imageLayers, duration);
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
    args.push('-ss', clip.sourceStart.toFixed(3), '-t', sourceDurations[index].toFixed(3), '-i', name);
  }
  for (const overlay of overlays) {
    sourceInputs.push({ name: overlay.name, data: overlay.data });
    args.push('-loop', '1', '-framerate', '30', '-i', overlay.name);
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
    const clip = ordered[index];
    const clipDuration = durations[index];
    const sourceDuration = sourceDurations[index];
    const speed = speeds[index];
    const framing =
      clip.fit === 'cover'
        ? 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720'
        : 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2';
    const color = `eq=brightness=${(((clip.brightness ?? 100) - 100) / 100).toFixed(3)}:contrast=${((clip.contrast ?? 100) / 100).toFixed(3)}:saturation=${((clip.saturation ?? 100) / 100).toFixed(3)}`;
    filters.push(
      `[${index}:v:0]trim=duration=${sourceDuration.toFixed(3)},setpts=(PTS-STARTPTS)/${speed.toFixed(3)},${framing},${color},setsar=1,fps=30,format=yuv420p[v${index}]`,
    );
    if (clipSources[index].hasAudio && !clipSources[index].clip.muted) {
      const gain = Math.max(0, Math.min(1, clipSources[index].clip.gain ?? 1));
      filters.push(
        `[${index}:a:0]atrim=duration=${sourceDuration.toFixed(3)},asetpts=PTS-STARTPTS,atempo=${speed.toFixed(3)},aformat=sample_rates=44100:channel_layouts=stereo,volume=${gain.toFixed(3)}[a${index}]`,
      );
    } else {
      filters.push(`anullsrc=channel_layout=stereo:sample_rate=44100:d=${clipDuration.toFixed(3)}[silence${index}]`);
    }
    concatInputs.push(`[v${index}]`);
    concatInputs.push(
      clipSources[index].hasAudio && !clipSources[index].clip.muted ? `[a${index}]` : `[silence${index}]`,
    );
  }
  filters.push(`${concatInputs.join('')}concat=n=${timelineSegments.length}:v=1:a=1[outvbase][outa]`);
  if (overlays.length === 0) filters.push('[outvbase]null[outv]');
  else {
    let inputLabel = 'outvbase';
    overlays.forEach((overlay, index) => {
      const outputLabel = index === overlays.length - 1 ? 'outv' : `outv${index}`;
      const enable = `gte(t,${overlay.start.toFixed(3)})*lt(t,${overlay.end.toFixed(3)})`;
      filters.push(
        `[${inputLabel}][${clipSources.length + index}:v:0]overlay=shortest=1:format=auto:enable='${enable}'[${outputLabel}]`,
      );
      inputLabel = outputLabel;
    });
  }
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
