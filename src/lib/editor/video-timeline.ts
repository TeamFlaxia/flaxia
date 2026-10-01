import type { StudioVideoClip } from './studio-project-store.ts';

export function videoClipDuration(clip: StudioVideoClip): number {
  const speed = Number.isFinite(clip.speed) ? Math.max(0.5, Math.min(2, clip.speed ?? 1)) : 1;
  const sourceDuration = Number.isFinite(clip.sourceEnd - clip.sourceStart)
    ? Math.max(0.001, clip.sourceEnd - clip.sourceStart)
    : 0.1;
  return sourceDuration / speed;
}

/** Return the usable dissolve duration after limiting it to half of both clips. */
export function videoClipTransitionDuration(clip: StudioVideoClip, nextClip: StudioVideoClip): number {
  const requested = Number.isFinite(clip.transitionOut) ? Math.max(0, Math.min(2, clip.transitionOut ?? 0)) : 0;
  const duration = Math.min(requested, videoClipDuration(clip) / 2, videoClipDuration(nextClip) / 2);
  return duration > 0.04 ? duration : 0;
}

/** Keep clips on the single video lane sequential, pushing later clips forward when edits collide. */
export function rippleOverlappingVideoClips(clips: StudioVideoClip[]): boolean {
  const ordered = [...clips].sort((left, right) => left.start - right.start);
  let timelineEnd = 0;
  let previous: StudioVideoClip | null = null;
  let changed = false;
  for (const clip of ordered) {
    const proposedStart = Number.isFinite(clip.start) ? Math.max(0, clip.start) : timelineEnd;
    const transition = previous ? videoClipTransitionDuration(previous, clip) : 0;
    const nextStart =
      proposedStart > timelineEnd + 0.04
        ? proposedStart
        : proposedStart >= timelineEnd - 0.04
          ? timelineEnd - transition
          : Math.max(timelineEnd - transition, proposedStart);
    if (clip.start !== nextStart) {
      clip.start = nextStart;
      changed = true;
    }
    timelineEnd = Math.max(timelineEnd, nextStart + videoClipDuration(clip));
    previous = clip;
  }
  return changed;
}
