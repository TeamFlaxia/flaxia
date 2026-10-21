export interface AudioPeaks {
  peaks: Float32Array;
  duration: number;
}

/**
 * Decodes the file once and reduces it to per-bucket peak amplitudes for the
 * trim timeline. Uses the default AudioContext — decode works while suspended,
 * so no user gesture is required.
 */
export async function computeAudioPeaks(file: File, buckets = 600): Promise<AudioPeaks> {
  const data = await file.arrayBuffer();
  const Ctx =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  try {
    const buffer = await ctx.decodeAudioData(data);
    const peaks = new Float32Array(buckets);
    const channels = Math.max(1, buffer.numberOfChannels);
    const total = buffer.length;
    const per = Math.max(1, Math.floor(total / buckets));
    for (let b = 0; b < buckets; b++) {
      const start = b * per;
      const end = Math.min(total, start + per);
      let max = 0;
      for (let ch = 0; ch < channels; ch++) {
        const samples = buffer.getChannelData(ch);
        for (let i = start; i < end; i++) {
          const v = Math.abs(samples[i]);
          if (v > max) max = v;
        }
      }
      peaks[b] = max;
    }
    return { peaks, duration: buffer.duration };
  } finally {
    void ctx.close();
  }
}

export function drawPeaks(canvas: HTMLCanvasElement, peaks: Float32Array, color: string): void {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = color;
  const mid = height / 2;
  const barWidth = width / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const amp = Math.min(1, peaks[i]);
    const h = Math.max(1 * dpr, amp * (height * 0.9));
    ctx.fillRect(i * barWidth, mid - h / 2, Math.max(1, barWidth - 0.5 * dpr), h);
  }
}
