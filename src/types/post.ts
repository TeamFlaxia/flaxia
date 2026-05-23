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

export type NotificationType = 'fresh' | 'reported' | 'warned' | 'hidden'

export interface Post {
  id: string
  user_id: string
  username: string
  display_name?: string
  avatar_key?: string
  text: string
  hashtags: string
  mentions?: string
  gif_key?: string  // Stores all image formats (GIF, PNG, JPG), not just GIFs
  payload_key?: string  // Stores ZIP files for HTML execution
  swf_key?: string  // Stores SWF files for Flash execution
  thumbnail_key?: string  // Stores thumbnail image for ZIP/SWF posts
  fresh_count: number
  reply_count: number
  impressions: number
  parent_id?: string
  root_id?: string
  depth: number
  status: string
  hidden: number
  created_at: string
  is_freshed?: boolean  // Whether current user has freshed this post
}

export enum PostCardMode {
  PREVIEW = 'preview',
  EXECUTING = 'executing'
}

export interface PostCardProps {
  post: Post
  sandboxOrigin: string
  initialMode?: PostCardMode
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null
  onDelete?: (postId: string) => void
  disableReply?: boolean
  disableReplyComposer?: boolean
  depth?: number
  postIndex?: number
}

export interface PostHeaderProps {
  username: string
  display_name?: string
  avatar_key?: string
  createdAt: string
}

export interface PostTextProps {
  text: string
  mentions?: string
}

export interface PostStageProps {
  post: Post
  mode: PostCardMode
  sandboxOrigin: string
  onModeChange: (mode: PostCardMode) => void
}

export interface GifPreviewProps {
  gifKey?: string
  postId: string
}

export interface SandboxFrameProps {
  postId: string
  sandboxOrigin: string
}

export interface PostActionsProps {
  postId: string
  freshCount: number
  replyCount: number
  impressions: number
  isFreshed: boolean
  depth: number
  onFreshToggle: () => void
  onReplyToggle: () => void
  onShare?: () => void
}

export interface TimelineProps {
  sandboxOrigin: string
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null
}

export interface TimelineState {
  mode: 'following' | 'foryou'
  hashtag: string
  posts: TimelineItem[]
  ads: Ad[]
  everyN: number
  cursor?: string
  loading: boolean
  hasMore: boolean
  error: string | null
  retryCount: number
  maxRetries: number
}

export interface Ad {
  id: string
  ad_type: 'self_hosted' | 'admax'
  body_text: string
  payload_key: string | null
  payload_type: 'zip' | 'swf' | 'gif' | 'image' | null
  thumbnail_key?: string
  click_url: string | null
  script_url?: string
  impressions: number
  clicks: number
}

export interface AdminAd {
  id: string
  title: string
  ad_type: 'self_hosted' | 'admax'
  body_text: string
  click_url: string | null
  payload_key: string | null
  payload_type: 'zip' | 'swf' | 'gif' | 'image' | null
  thumbnail_key?: string
  script_url?: string
  impressions: number
  clicks: number
  active: number
  created_at: string
  ctr?: number
  interaction_count?: number
}

export type TimelineItem = Post | Ad

export function isAd(item: TimelineItem): item is Ad {
  return 'payload_type' in item
}
