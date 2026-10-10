export type StudioPostMode = 'video' | 'game' | 'timeline-assets' | 'selected-file' | 'unsupported';

/** Overlay-only clips do not form a renderable video sequence. */
export function hasMainStudioVideoClips(clips: readonly { track?: string }[]): boolean {
  return clips.some((clip) => clip.track !== 'overlay');
}

/** Choose one valid post handoff from a mixed Studio workspace. */
export function resolveStudioPostMode(options: {
  hasVideoClips: boolean;
  selectedIsGame: boolean;
  hasAudioClips: boolean;
  hasVisibleImageLayers: boolean;
  selectedIsPostable: boolean;
}): StudioPostMode {
  if (options.hasVideoClips) return 'video';
  if (options.selectedIsGame) return 'game';
  if (options.hasAudioClips || options.hasVisibleImageLayers) return 'timeline-assets';
  return options.selectedIsPostable ? 'selected-file' : 'unsupported';
}
