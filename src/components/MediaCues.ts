import type { MediaCue } from '../lib/post-cues.js';
import { renderCueInlineHtml, renderMathElements } from './PostText.js';

const DANMAKU_DURATION_MS = 5000;
const SUBTITLE_DURATION_MS = 4000;
const SUBTITLE_FADE_MS = 200;
const STILL_DURATION_MS = 2000;
const SEEK_JUMP_MS = 1000;
const LANE_HEIGHT = 30;
const TOP_OFFSET_PX = 12;
const BOTTOM_OFFSET_PX = 56; // above the control bar

export interface MediaCueOverlay {
  readonly element: HTMLElement;
  update(currentTimeSeconds: number): void;
  destroy(): void;
}

interface ActiveCue {
  el: HTMLElement;
  kind: MediaCue['kind'];
  cueIndex: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Niconico-style timed comments for a media element: danmaku that fly
 * right-to-left across the whole player height, and fixed top/bottom
 * subtitles. Driven entirely by the host media's clock; everything is
 * ephemeral and nothing is read from or written to a database.
 */
export function createMediaCueOverlay(cues: MediaCue[] | undefined | null): MediaCueOverlay | null {
  if (!cues || cues.length === 0) return null;

  const element = document.createElement('div');
  element.className = 'media-cues';
  element.setAttribute('aria-hidden', 'true');

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const activeCues = new Set<ActiveCue>();
  const laneBusyUntil: number[] = [];
  let topCount = 0;
  let bottomCount = 0;
  let prevMs: number | null = null;
  let destroyed = false;

  const release = (active: ActiveCue) => {
    activeCues.delete(active);
    if (active.timer) clearTimeout(active.timer);
    if (active.kind === 'top') topCount -= 1;
    else if (active.kind === 'bottom') bottomCount -= 1;
    active.el.remove();
  };

  const destroyActive = () => {
    for (const active of [...activeCues]) release(active);
  };

  // Pre-render cue bodies (inline Markdown + KaTeX placeholders). Bodies
  // resolve long before their cue fires; a cue that fires first is rendered
  // as plain text and upgraded in place when its HTML arrives.
  const richHtml: (string | null)[] = cues.map(() => null);
  cues.forEach((cue, i) => {
    renderCueInlineHtml(cue.text)
      .then((html) => {
        richHtml[i] = html;
        for (const active of activeCues) {
          if (active.cueIndex === i && element.contains(active.el)) {
            active.el.innerHTML = html;
            renderMathElements(active.el);
          }
        }
      })
      .catch(() => {});
  });

  const spawn = (cue: MediaCue, cueIndex: number) => {
    if (destroyed) return;
    const el = document.createElement('div');
    el.className = `media-cue media-cue--${cue.kind}`;
    const rich = richHtml[cueIndex];
    if (rich !== null) {
      el.innerHTML = rich;
    } else {
      el.textContent = cue.text;
    }
    element.appendChild(el);
    if (rich !== null) renderMathElements(el);

    if (cue.kind === 'danmaku') {
      if (reducedMotion) {
        el.classList.add('media-cue--still');
        const active: ActiveCue = { el, kind: cue.kind, cueIndex, timer: null };
        activeCues.add(active);
        active.timer = setTimeout(() => release(active), STILL_DURATION_MS);
        return;
      }
      const containerWidth = element.clientWidth;
      if (containerWidth <= 0) {
        el.remove();
        return;
      }
      const width = el.offsetWidth;
      const laneCount = Math.max(1, Math.floor(element.clientHeight / LANE_HEIGHT));
      const now = Date.now();
      let lane = -1;
      for (let i = 0; i < laneCount; i++) {
        if ((laneBusyUntil[i] ?? 0) <= now) {
          lane = i;
          break;
        }
      }
      if (lane === -1) {
        // Every lane busy: drop the cue rather than stack unreadably.
        el.remove();
        return;
      }
      // The lane is occupied until this danmaku has emerged from the right edge.
      laneBusyUntil[lane] = now + (DANMAKU_DURATION_MS * width) / (containerWidth + width) + 200;
      el.style.top = `${lane * LANE_HEIGHT}px`;
      el.style.setProperty('--cue-from', `${containerWidth}px`);
      el.style.setProperty('--cue-to', `${-width}px`);
      el.style.setProperty('--cue-duration', `${DANMAKU_DURATION_MS}ms`);
      el.classList.add('media-cue--fly');
      const active: ActiveCue = { el, kind: cue.kind, cueIndex, timer: null };
      activeCues.add(active);
      active.timer = setTimeout(() => release(active), DANMAKU_DURATION_MS + 100);
      el.addEventListener('animationend', () => release(active), { once: true });
      return;
    }

    const slot = cue.kind === 'top' ? topCount : bottomCount;
    if (cue.kind === 'top') {
      topCount += 1;
      el.style.top = `${TOP_OFFSET_PX + slot * LANE_HEIGHT}px`;
    } else {
      bottomCount += 1;
      el.style.bottom = `${BOTTOM_OFFSET_PX + slot * LANE_HEIGHT}px`;
    }
    const active: ActiveCue = { el, kind: cue.kind, cueIndex, timer: null };
    activeCues.add(active);
    active.timer = setTimeout(() => {
      el.classList.add('media-cue--out');
      active.timer = setTimeout(() => release(active), SUBTITLE_FADE_MS);
    }, SUBTITLE_DURATION_MS);
  };

  const update = (currentTimeSeconds: number) => {
    if (destroyed) return;
    const ms = currentTimeSeconds * 1000;
    if (prevMs === null) {
      // First observation: fire everything already due (media always starts
      // at 0 in practice, so this is normally just a cue at exactly 0).
      for (let i = 0; i < cues.length; i++) {
        if (cues[i].timeMs <= ms) spawn(cues[i], i);
      }
      prevMs = ms;
      return;
    }
    if (Math.abs(ms - prevMs) > SEEK_JUMP_MS) {
      // Seek or replay: in-flight cues are dropped and skipped cues never fire.
      destroyActive();
      prevMs = ms;
      return;
    }
    for (let i = 0; i < cues.length; i++) {
      const at = cues[i].timeMs;
      if (at > prevMs && at <= ms) spawn(cues[i], i);
    }
    prevMs = ms;
  };

  return {
    element,
    update,
    destroy() {
      destroyed = true;
      destroyActive();
      element.remove();
    },
  };
}
