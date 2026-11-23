<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import { onDestroy } from 'svelte';
import type { MediaCue } from '../../../../shared/post-cues.ts';
import { renderCueInlineHtml, renderMathElements } from '../../../components/PostText.js';

interface Props {
  cues?: MediaCue[] | null;
}

let { cues }: Props = $props();

const DANMAKU_DURATION_MS = 5000;
const SUBTITLE_DURATION_MS = 4000;
const SUBTITLE_FADE_MS = 200;
const STILL_DURATION_MS = 2000;
const SEEK_JUMP_MS = 1000;
const LANE_HEIGHT = 30;
const TOP_OFFSET_PX = 12;
const BOTTOM_OFFSET_PX = 56; // above the control bar

interface ActiveCue {
  id: number;
  cueIndex: number;
  kind: MediaCue['kind'];
  text: string;
  html: string | null;
  out: boolean;
  top: string;
  bottom: string;
  reduced: boolean;
}

let root = $state<HTMLDivElement>();
let active = $state<ActiveCue[]>([]);

const srcCues: MediaCue[] = cues ?? [];
const richHtml: (string | null)[] = srcCues.map(() => null);
const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const timers = new Map<number, ReturnType<typeof setTimeout>>();
const laneBusyUntil: number[] = [];
let topCount = 0;
let bottomCount = 0;
let prevMs: number | null = null;
let nextId = 0;
let destroyed = false;

function setTimer(id: number, timer: ReturnType<typeof setTimeout>): void {
  timers.set(id, timer);
}

function clearTimer(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

function release(cue: ActiveCue): void {
  clearTimer(cue.id);
  active = active.filter((item) => item.id !== cue.id);
  if (cue.kind === 'top') topCount = Math.max(0, topCount - 1);
  else if (cue.kind === 'bottom') bottomCount = Math.max(0, bottomCount - 1);
}

function destroyActive(): void {
  for (const cue of active) clearTimer(cue.id);
  active = [];
  topCount = 0;
  bottomCount = 0;
}

function prefetch(index: number): void {
  const cue = srcCues[index];
  if (!cue) return;
  renderCueInlineHtml(cue.text)
    .then((html) => {
      richHtml[index] = html;
      const target = active.find((item) => item.cueIndex === index);
      if (target) target.html = html;
    })
    .catch(() => {});
}

function spawn(cue: MediaCue, cueIndex: number): void {
  if (destroyed) return;
  const id = nextId++;
  const item: ActiveCue = {
    id,
    cueIndex,
    kind: cue.kind,
    text: cue.text,
    html: richHtml[cueIndex],
    out: false,
    top: '',
    bottom: '',
    reduced: reducedMotion,
  };

  if (cue.kind === 'danmaku' && reducedMotion) {
    active = [...active, item];
    setTimer(
      id,
      setTimeout(() => release(item), STILL_DURATION_MS),
    );
    if (richHtml[cueIndex] === null) prefetch(cueIndex);
    return;
  }

  if (cue.kind === 'top') {
    item.top = `${TOP_OFFSET_PX + topCount * LANE_HEIGHT}px`;
    topCount += 1;
  } else if (cue.kind === 'bottom') {
    item.bottom = `${BOTTOM_OFFSET_PX + bottomCount * LANE_HEIGHT}px`;
    bottomCount += 1;
  }

  active = [...active, item];
  if (richHtml[cueIndex] === null) prefetch(cueIndex);

  if (cue.kind !== 'danmaku') {
    setTimer(
      id,
      setTimeout(() => {
        active = active.map((existing) => (existing.id === id ? { ...existing, out: true } : existing));
        setTimer(
          id,
          setTimeout(() => {
            const current = active.find((existing) => existing.id === id);
            if (current) release(current);
          }, SUBTITLE_FADE_MS),
        );
      }, SUBTITLE_DURATION_MS),
    );
  }
}

// Svelte action: runs once after the cue node is in the DOM, when it can be
// measured against the player height.
function fly(node: HTMLElement, cue: ActiveCue): void {
  if (cue.kind !== 'danmaku' || cue.reduced || !root) return;
  const containerWidth = root.clientWidth;
  if (containerWidth <= 0) {
    release(cue);
    return;
  }
  const width = node.offsetWidth;
  const laneCount = Math.max(1, Math.floor(root.clientHeight / LANE_HEIGHT));
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
    release(cue);
    return;
  }
  laneBusyUntil[lane] = now + (DANMAKU_DURATION_MS * width) / (containerWidth + width) + 200;
  node.style.top = `${lane * LANE_HEIGHT}px`;
  node.style.setProperty('--cue-from', `${containerWidth}px`);
  node.style.setProperty('--cue-to', `${-width}px`);
  node.style.setProperty('--cue-duration', `${DANMAKU_DURATION_MS}ms`);
  node.classList.add('media-cue--fly');
  setTimer(
    cue.id,
    setTimeout(() => release(cue), DANMAKU_DURATION_MS + 100),
  );
  node.addEventListener('animationend', () => release(cue), { once: true });
}

// Upgrade math placeholders once a cue body's inline HTML arrives.
$effect(() => {
  if (!root) return;
  for (const cue of active) {
    if (!cue.html) continue;
    const node = root.querySelector<HTMLElement>(`[data-cue-id="${cue.id}"]`);
    if (!node || node.dataset.mathReady === '1') continue;
    node.dataset.mathReady = '1';
    renderMathElements(node);
  }
});

export function update(currentTimeSeconds: number): void {
  if (destroyed || srcCues.length === 0) return;
  const ms = currentTimeSeconds * 1000;
  if (prevMs === null) {
    // First observation: fire everything already due (media always starts
    // at 0 in practice, so this is normally just a cue at exactly 0).
    for (let i = 0; i < srcCues.length; i++) {
      if (srcCues[i].timeMs <= ms) spawn(srcCues[i], i);
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
  for (let i = 0; i < srcCues.length; i++) {
    const at = srcCues[i].timeMs;
    if (at > prevMs && at <= ms) spawn(srcCues[i], i);
  }
  prevMs = ms;
}

onDestroy(() => {
  destroyed = true;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
});
</script>

<div bind:this={root} class="media-cues" aria-hidden="true">
  {#each active as cue (cue.id)}
    <div
      class="media-cue media-cue--{cue.kind}"
      class:media-cue--out={cue.out}
      class:media-cue--still={cue.kind === 'danmaku' && cue.reduced}
      data-cue-id={cue.id}
      style:top={cue.kind === 'top' ? cue.top : undefined}
      style:bottom={cue.kind === 'bottom' ? cue.bottom : undefined}
      use:fly={cue}
    >
      {#if cue.html !== null}{@html cue.html}{:else}{cue.text}{/if}
    </div>
  {/each}
</div>
