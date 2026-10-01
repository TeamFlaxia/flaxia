import { type AudioTimelineClip, audibleAudioTimelineClips, mixAudioTimeline } from './audio-mixer.ts';
import { probeFFmpegStreams, runFFmpeg } from './ffmpeg-client.ts';
import { drawStudioImageLayer } from './image-layer-canvas.ts';
import type { StudioImageLayer, StudioVideoClip } from './studio-project-store.ts';
import { rippleOverlappingVideoClips } from './video-timeline.ts';

const MAX_INPUT_BYTES = 80 * 1024 * 1024;
const MAX_DURATION_SECONDS = 180;

/** Build FFmpeg fade filters for a clip's timeline duration. */
export function videoClipFadeFilters(duration: number, fadeIn = 0, fadeOut = 0): string[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const safeFadeIn = Math.min(duration, Math.max(0, Number.isFinite(fadeIn) ? fadeIn : 0));
  const safeFadeOut = Math.min(duration, Math.max(0, Number.isFinite(fadeOut) ? fadeOut : 0));
  const filters: string[] = [];
  if (safeFadeIn > 0) filters.push(`fade=t=in:st=0:d=${safeFadeIn.toFixed(3)}`);
  if (safeFadeOut > 0) {
    filters.push(`fade=t=out:st=${Math.max(0, duration - safeFadeOut).toFixed(3)}:d=${safeFadeOut.toFixed(3)}`);
  }
  return filters;
}

/** Build FFmpeg audio fades using the clip's post-speed timeline duration. */
export function videoClipAudioFadeFilters(duration: number, fadeIn = 0, fadeOut = 0): string[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const safeFadeIn = Math.min(duration, Math.max(0, Number.isFinite(fadeIn) ? fadeIn : 0));
  const safeFadeOut = Math.min(duration, Math.max(0, Number.isFinite(fadeOut) ? fadeOut : 0));
  const filters: string[] = [];
  if (safeFadeIn > 0) filters.push(`afade=t=in:st=0:d=${safeFadeIn.toFixed(3)}`);
  if (safeFadeOut > 0) {
    filters.push(`afade=t=out:st=${Math.max(0, duration - safeFadeOut).toFixed(3)}:d=${safeFadeOut.toFixed(3)}`);
  }
  return filters;
}

/** Return the video clip opacity at an offset on its timeline. */
export function videoClipOpacityAt(time: number, duration: number, fadeIn = 0, fadeOut = 0): number {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) return 1;
  const safeFadeIn = Math.min(duration, Math.max(0, Number.isFinite(fadeIn) ? fadeIn : 0));
  const safeFadeOut = Math.min(duration, Math.max(0, Number.isFinite(fadeOut) ? fadeOut : 0));
  let opacity = 1;
  if (safeFadeIn > 0) opacity = Math.min(opacity, Math.max(0, Math.min(1, time / safeFadeIn)));
  if (safeFadeOut > 0) opacity = Math.min(opacity, Math.max(0, Math.min(1, (duration - time) / safeFadeOut)));
  return opacity;
}

/** Build the per-clip image adjustments shared by video sequence exports. */
export function videoClipColorFilters(
  clip: Pick<StudioVideoClip, 'brightness' | 'contrast' | 'saturation' | 'hueDeg' | 'blurPx'>,
): string[] {
  const brightness = Number.isFinite(clip.brightness) ? Math.max(0, Math.min(200, clip.brightness!)) : 100;
  const contrast = Number.isFinite(clip.contrast) ? Math.max(0, Math.min(200, clip.contrast!)) : 100;
  const saturation = Number.isFinite(clip.saturation) ? Math.max(0, Math.min(200, clip.saturation!)) : 100;
  const hue = Number.isFinite(clip.hueDeg) ? Math.max(-180, Math.min(180, clip.hueDeg!)) : 0;
  const blur = Number.isFinite(clip.blurPx) ? Math.max(0, Math.min(24, clip.blurPx!)) : 0;
  const filters = [
    `eq=brightness=${((brightness - 100) / 100).toFixed(3)}:contrast=${(contrast / 100).toFixed(3)}:saturation=${(saturation / 100).toFixed(3)}`,
  ];
  if (hue !== 0) filters.push(`hue=h=${((hue * Math.PI) / 180).toFixed(3)}`);
  if (blur > 0) filters.push(`gblur=sigma=${Math.max(0.5, blur).toFixed(1)}`);
  return filters;
}

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
  fadeIn: number;
  fadeOut: number;
  blend: StudioImageLayer['blend'];
}

const ffmpegBlendModes: Record<StudioImageLayer['blend'], string | null> = {
  normal: null,
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color-dodge': 'dodge',
  'color-burn': 'burn',
  'hard-light': 'hardlight',
  'soft-light': 'softlight',
  difference: 'difference',
  exclusion: 'exclusion',
};

/** Map the canvas layer blend mode to FFmpeg's blend filter mode. */
export function videoOverlayBlendMode(mode: StudioImageLayer['blend']): string | null {
  return ffmpegBlendModes[mode];
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
    const bitmap = layer.kind === 'image' ? bitmaps.get(layer.fileIndex) : null;
    if (layer.kind === 'image' && !bitmap) throw new Error('A video overlay layer is not an image');
    drawStudioImageLayer(context, layer, bitmap ?? null, { scale, offsetX: 280 });
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
  const visibleLayers = layers
    .filter((layer) => layer.visible && (layer.start ?? 0) < duration && (layer.end ?? duration) > 0)
    .map((layer, index) => {
      const start = Math.max(0, layer.start ?? 0);
      const end = Math.min(duration, layer.end ?? duration);
      return {
        layer,
        start,
        end,
        fadeIn: Math.min(Math.max(0, layer.fadeIn ?? 0), end - start),
        fadeOut: Math.min(Math.max(0, layer.fadeOut ?? 0), end - start),
        name: `studio-overlay-${index}.png`,
      };
    })
    .filter((overlay) => overlay.end > overlay.start);
  if (visibleLayers.length === 0) return [];
  const bitmaps = new Map<number, ImageBitmap>();
  try {
    for (const { layer } of visibleLayers) {
      if (layer.kind !== 'image' || bitmaps.has(layer.fileIndex)) continue;
      const file = files[layer.fileIndex];
      if (!file || !file.type.startsWith('image/')) throw new Error('A video overlay layer is not an image');
      bitmaps.set(layer.fileIndex, await createImageBitmap(file));
    }
    return Promise.all(
      visibleLayers.map(async ({ layer, start, end, fadeIn, fadeOut, name }) => ({
        name,
        data: await renderLayerOverlayFrame([layer], bitmaps),
        start,
        end,
        fadeIn,
        fadeOut,
        blend: layer.blend,
      })),
    );
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
  const ordered = clips.map((clip) => ({ ...clip })).sort((left, right) => left.start - right.start);
  rippleOverlappingVideoClips(ordered);
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
    const fades = videoClipFadeFilters(clipDuration, clip.fadeIn, clip.fadeOut);
    const videoFilters = [
      framing,
      ...videoClipColorFilters(clip),
      ...fades,
      'setsar=1',
      'fps=30',
      'format=yuv420p',
    ].join(',');
    filters.push(
      `[${index}:v:0]trim=duration=${sourceDuration.toFixed(3)},setpts=(PTS-STARTPTS)/${speed.toFixed(3)},${videoFilters}[v${index}]`,
    );
    if (clipSources[index].hasAudio && !clipSources[index].clip.muted) {
      const gain = Math.max(0, Math.min(1, clipSources[index].clip.gain ?? 1));
      const audioFades = videoClipAudioFadeFilters(clipDuration, clip.fadeIn, clip.fadeOut);
      filters.push(
        `[${index}:a:0]atrim=duration=${sourceDuration.toFixed(3)},asetpts=PTS-STARTPTS,atempo=${speed.toFixed(3)},aformat=sample_rates=44100:channel_layouts=stereo,volume=${gain.toFixed(3)}${audioFades.length ? `,${audioFades.join(',')}` : ''}[a${index}]`,
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
      const overlayLabel = `overlay-source-${index}`;
      const enable = `gte(t,${overlay.start.toFixed(3)})*lt(t,${overlay.end.toFixed(3)})`;
      const fades: string[] = [];
      if (overlay.fadeIn > 0) {
        fades.push(`fade=t=in:st=${overlay.start.toFixed(3)}:d=${overlay.fadeIn.toFixed(3)}:alpha=1`);
      }
      if (overlay.fadeOut > 0) {
        fades.push(
          `fade=t=out:st=${Math.max(overlay.start, overlay.end - overlay.fadeOut).toFixed(3)}:d=${overlay.fadeOut.toFixed(3)}:alpha=1`,
        );
      }
      filters.push(
        `[${clipSources.length + index}:v:0]format=rgba,setpts=PTS-STARTPTS${fades.length > 0 ? `,${fades.join(',')}` : ''}[${overlayLabel}]`,
      );
      const blendMode = videoOverlayBlendMode(overlay.blend);
      if (blendMode === null) {
        filters.push(
          `[${inputLabel}][${overlayLabel}]overlay=shortest=1:format=auto:enable='${enable}'[${outputLabel}]`,
        );
      } else {
        const colorBase = `blend-base-${index}`;
        const maskBase = `blend-mask-base-${index}`;
        const colorSource = `blend-color-source-${index}`;
        const maskSource = `blend-mask-source-${index}`;
        const blended = `blend-result-${index}`;
        const mask = `blend-mask-${index}`;
        const result = index === overlays.length - 1 ? outputLabel : `outv${index}`;
        filters.push(`[${inputLabel}]format=rgb24,split[${colorBase}][${maskBase}]`);
        filters.push(`[${overlayLabel}]split[${colorSource}][${maskSource}]`);
        filters.push(`[${colorSource}]format=rgb24[blend-top-${index}]`);
        filters.push(`[blend-top-${index}][${colorBase}]blend=all_mode=${blendMode}:shortest=1[${blended}]`);
        filters.push(`[${maskSource}]alphaextract[${mask}]`);
        filters.push(`[${maskBase}][${blended}][${mask}]maskedmerge=shortest=1:enable='${enable}'[${result}]`);
      }
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
  const hasAudioMix = audibleAudioTimelineClips(audioClips).length > 0;
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
