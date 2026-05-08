export type GameType = 'flash' | 'html5' | 'zip'

export interface Game {
  id: string
  postId: string
  title: string
  username: string
  displayName?: string
  avatarKey?: string
  type: GameType
  swfKey?: string
  payloadKey?: string
  thumbnailKey?: string
  freshCount: number
  replyCount: number
  impressions: number
  isFreshed?: boolean
  createdAt: string
}

export interface ArcadePageProps {
  sandboxOrigin: string
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null
  initialGameId?: string
}

export interface GamePlayerProps {
  game: Game
  sandboxOrigin: string
  autoplay?: boolean
  onError?: (error: Error) => void
}

export interface GameCardProps {
  game: Game
  isActive: boolean
  sandboxOrigin: string
  onLike?: (gameId: string) => void
  onShare?: (gameId: string) => void
  onFullscreen?: () => void
}
