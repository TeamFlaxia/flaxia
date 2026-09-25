export type ReportCategory =
  | 'spam'
  | 'harassment'
  | 'inappropriate'
  | 'misinformation'
  | 'other'
  | 'hate_speech'
  | 'copyright'
  | 'csam'
  | 'malware'
  | 'privacy'
  | 'nsfw_untagged';

export type NotificationType = 'fresh' | 'reported' | 'warned' | 'hidden';

export interface QuotedPost {
  id: string;
  user_id: string;
  username: string;
  display_name?: string | null;
  avatar_key?: string | null;
  badge_type?: string | null;
  text: string;
  hashtags: string;
  mentions?: string;
  gif_key?: string | null;
  payload_key?: string | null;
  swf_key?: string | null;
  thumbnail_key?: string | null;
  attachments?: PostAttachment[];
  parent_id?: string | null;
  root_id?: string | null;
  created_at: string;
}

export type MediaAttachmentKind = 'image' | 'audio' | 'video';

/** One media file attached to a post (multi-media attachments, max 4; 32 for Flaxia+). */
export interface PostAttachment {
  r2_key: string;
  kind: MediaAttachmentKind;
  position: number;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  reacted: boolean;
  stamp_url?: string;
}

export interface Post {
  id: string;
  user_id: string;
  username: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
  text: string;
  hashtags: string;
  mentions?: string;
  gif_key?: string; // Stores all image formats (GIF, PNG, JPG), not just GIFs
  payload_key?: string; // Stores ZIP files for HTML execution
  swf_key?: string; // Stores SWF files for Flash execution
  thumbnail_key?: string; // Stores thumbnail image for ZIP/SWF posts
  attachments?: PostAttachment[]; // Multiple image/audio/video attachments
  fresh_count: number;
  bookmark_count: number;
  reply_count: number;
  impressions: number;
  parent_id?: string;
  root_id?: string;
  depth: number;
  status: string;
  hidden: number;
  created_at: string;
  edited_at?: string;
  author_language?: string;
  quoted_post_id?: string;
  quoted_post?: QuotedPost | null;
  is_freshed?: boolean; // Whether current user has freshed this post
  is_bookmarked?: boolean; // Whether current user has bookmarked this post
  reactions?: ReactionSummary[]; // Emoji reactions summary for this post
  poll?: {
    id: string;
    question: string;
    multipleChoice: boolean;
    endsAt?: string | null;
    options: Array<{ id: string; label: string; votes_count: number }>;
    userVote: string | null;
  };
}

export enum PostCardMode {
  PREVIEW = 'preview',
  EXECUTING = 'executing',
}

export interface PostCardProps {
  post: Post;
  sandboxOrigin: string;
  initialMode?: PostCardMode;
  currentUser?: {
    username: string;
    id: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
  } | null;
  onDelete?: (postId: string) => void;
  disableReply?: boolean;
  disableReplyComposer?: boolean;
  depth?: number;
  postIndex?: number;
  enablePostRefs?: boolean;
  disableNavigation?: boolean;
  stripLeadingPostRef?: boolean;
  showPinOption?: boolean;
  pinned?: boolean;
  onTogglePin?: (postId: string) => void;
}

export interface PostHeaderProps {
  username: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
  createdAt: string;
  editedAt?: string;
}

export interface PostTextProps {
  text: string;
  mentions?: string;
  enablePostRefs?: boolean;
  authorId?: string;
}

export interface PostStageProps {
  post: Post;
  mode: PostCardMode;
  sandboxOrigin: string;
  versionId?: string;
  onModeChange: (mode: PostCardMode) => void;
}

export interface GifPreviewProps {
  gifKey?: string;
  postId: string;
  isThumbnail?: boolean;
  src?: string;
  // Force the preview into a 16:9 box, center-cropping the image to fill it.
  ratio?: '16:9';
  /** All image attachment keys of the post, for lightbox prev/next navigation. */
  gallery?: string[];
  /** Index of this image inside `gallery`. */
  galleryIndex?: number;
}

export interface SandboxFrameProps {
  postId: string;
  sandboxOrigin: string;
  versionId?: string;
}

export interface PostActionsProps {
  postId: string;
  freshCount: number;
  bookmarkCount: number;
  replyCount: number;
  impressions: number;
  isFreshed: boolean;
  isBookmarked: boolean;
  reactions: ReactionSummary[];
  depth: number;
  onFreshToggle: () => void;
  onBookmarkToggle: () => void;
  onReplyToggle: () => void;
  onShare?: () => void;
  onQuote?: () => void;
  onReactionToggle: (emoji: string) => void;
}

export interface TimelineProps {
  sandboxOrigin: string;
  currentUser?: {
    username: string;
    id: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
  } | null;
}

export interface TimelineState {
  mode: 'following' | 'foryou' | 'global';
  hashtag: string;
  posts: TimelineItem[];
  ads: Ad[];
  everyN: number;
  cursor?: string;
  loading: boolean;
  hasMore: boolean;
  error: string | null;
  retryCount: number;
  maxRetries: number;
}

export interface Ad {
  id: string;
  ad_type: 'self_hosted' | 'admax';
  body_text: string;
  payload_key: string | null;
  payload_type: 'zip' | 'swf' | 'gif' | 'image' | null;
  thumbnail_key?: string;
  click_url: string | null;
  script_url?: string;
  impressions: number;
  clicks: number;
}

export interface AdminAd {
  id: string;
  title: string;
  ad_type: 'self_hosted' | 'admax';
  body_text: string;
  click_url: string | null;
  payload_key: string | null;
  payload_type: 'zip' | 'swf' | 'gif' | 'image' | null;
  thumbnail_key?: string;
  script_url?: string;
  impressions: number;
  clicks: number;
  active: number;
  created_at: string;
  ctr?: number;
  interaction_count?: number;
}

export type TimelineItem = Post | Ad;

export function isAd(item: TimelineItem): item is Ad {
  return 'payload_type' in item;
}
