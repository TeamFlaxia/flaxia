// Main PostCard component

export { createImagePreview } from './components/ImagePreview.js';
export { createPostActions } from './components/PostActions.js';
export { createPostCard, PostCard } from './components/PostCard.js';
// Sub-components (for advanced usage)
export { createPostHeader } from './components/PostHeader.js';
export { createPostStage, updatePostStage } from './components/PostStage.js';
export { createPostText } from './components/PostText.js';
export { createSandboxFrame } from './components/SandboxFrame.js';
// Timeline component
export { createTimeline, Timeline } from './components/Timeline.js';
// Bridge types for postMessage communication
export type { ParentMessage, SandboxMessage } from './lib/bridge.js';
export { isParentMessage, isSandboxMessage } from './lib/bridge.js';
export type { SandboxBridgeOptions } from './lib/sandbox-bridge.js';
// Sandbox bridge
export { SandboxBridge, useSandboxBridge } from './lib/sandbox-bridge.js';
// Types
export type {
  GifPreviewProps,
  Post,
  PostActionsProps,
  PostCardProps,
  PostHeaderProps,
  PostStageProps,
  PostTextProps,
  SandboxFrameProps,
  TimelineProps,
  TimelineState,
} from './types/post.js';
export { PostCardMode } from './types/post.js';
