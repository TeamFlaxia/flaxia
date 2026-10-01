import type { StudioVideoClip } from './studio-project-store.ts';

/** Keep clips on the single video lane sequential, pushing later clips forward when edits collide. */
export function rippleOverlappingVideoClips(clips: StudioVideoClip[]): boolean {
  const ordered = [...clips].sort((left, right) => left.start - right.start);
  let timelineEnd = 0;
  let changed = false;
  for (const clip of ordered) {
    const proposedStart = Number.isFinite(clip.start) ? Math.max(0, clip.start) : timelineEnd;
    const nextStart = Math.max(timelineEnd, proposedStart);
    if (clip.start !== nextStart) {
      clip.start = nextStart;
      changed = true;
    }
    const speed = Number.isFinite(clip.speed) ? Math.max(0.5, Math.min(2, clip.speed ?? 1)) : 1;
    const sourceDuration = Number.isFinite(clip.sourceEnd - clip.sourceStart)
      ? Math.max(0.1, clip.sourceEnd - clip.sourceStart)
      : 0.1;
    timelineEnd = nextStart + sourceDuration / speed;
  }
  return changed;
}
