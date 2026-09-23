export interface TrimRange {
  start: number;
  end: number;
}

export interface TrimTimelineOptions {
  duration: number;
  initial?: TrimRange;
  onChange: (range: TrimRange) => void;
  /** Optional waveform peaks painted under the selection. */
  peaks?: Float32Array;
}

export interface TrimTimelineHandle {
  el: HTMLElement;
  getRange: () => TrimRange;
  setRange: (range: Partial<TrimRange>) => void;
  destroy: () => void;
}

const MIN_SELECTION = 0.05;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function formatTimelineTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

/**
 * Dual-handle range slider used for audio/video trimming. The selection area
 * dims everything outside via box-shadow so handles stay simple to hit.
 */
export function createTrimTimeline(options: TrimTimelineOptions): TrimTimelineHandle {
  const duration = Math.max(options.duration, MIN_SELECTION * 2);
  let start = clamp(options.initial?.start ?? 0, 0, duration);
  let end = clamp(options.initial?.end ?? duration, start + MIN_SELECTION, duration);

  const el = document.createElement('div');
  el.className = 'me-timeline';
  el.style.cssText = `
    position: relative;
    height: 56px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    touch-action: none;
    user-select: none;
  `;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; pointer-events:none;';
  el.appendChild(canvas);

  const selection = document.createElement('div');
  selection.style.cssText = `
    position: absolute;
    top: 0;
    bottom: 0;
    background: rgba(99, 102, 241, 0.28);
    border-left: 2px solid var(--accent, #6366f1);
    border-right: 2px solid var(--accent, #6366f1);
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
    pointer-events: none;
  `;
  el.appendChild(selection);

  const makeHandle = (which: 'start' | 'end'): HTMLDivElement => {
    const handle = document.createElement('div');
    handle.style.cssText = `
      position: absolute;
      top: 0;
      bottom: 0;
      width: 14px;
      margin-left: -7px;
      background: var(--accent, #6366f1);
      cursor: ew-resize;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2;
    `;
    handle.dataset.role = which;
    const grip = document.createElement('div');
    grip.style.cssText = 'width: 2px; height: 18px; background: rgba(255,255,255,0.85); border-radius: 1px;';
    handle.appendChild(grip);
    el.appendChild(handle);
    return handle;
  };

  const startHandle = makeHandle('start');
  const endHandle = makeHandle('end');

  const paint = (): void => {
    const left = (start / duration) * 100;
    const right = (end / duration) * 100;
    selection.style.left = `${left}%`;
    selection.style.width = `${Math.max(0, right - left)}%`;
    startHandle.style.left = `${left}%`;
    endHandle.style.left = `${right}%`;
    drawBackground();
  };

  const drawBackground = (): void => {
    if (!options.peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(el.clientWidth * dpr));
    const height = Math.max(1, Math.floor(el.clientHeight * dpr));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(99, 102, 241, 0.9)';
    const mid = height / 2;
    const barWidth = width / options.peaks.length;
    for (let i = 0; i < options.peaks.length; i++) {
      const amp = Math.min(1, options.peaks[i]);
      const h = Math.max(1, amp * height * 0.85);
      ctx.fillRect(i * barWidth, mid - h / 2, Math.max(1, barWidth - 0.5), h);
    }
  };

  let dragging: 'start' | 'end' | null = null;

  const fractionFromEvent = (e: PointerEvent): number => {
    const rect = el.getBoundingClientRect();
    return clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  };

  const onPointerDown = (which: 'start' | 'end') => (e: PointerEvent) => {
    e.preventDefault();
    dragging = which;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const time = fractionFromEvent(e) * duration;
    if (dragging === 'start') {
      start = clamp(time, 0, end - MIN_SELECTION);
    } else {
      end = clamp(time, start + MIN_SELECTION, duration);
    }
    paint();
    options.onChange({ start, end });
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    options.onChange({ start, end });
  };

  startHandle.addEventListener('pointerdown', onPointerDown('start'));
  endHandle.addEventListener('pointerdown', onPointerDown('end'));
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);

  const observer = new ResizeObserver(() => drawBackground());
  observer.observe(el);

  paint();

  return {
    el,
    getRange: () => ({ start, end }),
    setRange: (range) => {
      if (range.start !== undefined) start = clamp(range.start, 0, end - MIN_SELECTION);
      if (range.end !== undefined) end = clamp(range.end, start + MIN_SELECTION, duration);
      paint();
    },
    destroy: () => {
      observer.disconnect();
      el.remove();
    },
  };
}
