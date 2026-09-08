import type { User } from '../lib/auth';

export type Bindings = {
  DB: D1Database;
  DB_TEST: D1Database;
  BUCKET: R2Bucket;
  CACHE: KVNamespace;
  SANDBOX_ORIGIN: string;
  BASE_URL: string;
  ADMIN_USERNAMES: string;
  AP_DELIVERY_QUEUE: Queue;
  CROWD_ORCHESTRATOR_URL: string;
  CROWD_API_KEY: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  CF_ACCESS_AUD: string;
  CF_TEAM_DOMAIN: string;
  CROWD_ORCHESTRATOR?: Fetcher;
  NOTIFICATION_STREAM?: DurableObjectNamespace;
  CALL_STREAM?: DurableObjectNamespace;
  MULTIPLAYER_ROOM?: DurableObjectNamespace;
  MATCHMAKER?: DurableObjectNamespace;
  FCM_SERVER_KEY?: string;
  VECTORIZE?: Vectorize;
};

export type Variables = {
  user: User | null;
};

export type PostRow = {
  id: string;
  user_id: string;
  username: string;
  display_name?: string | null;
  avatar_key?: string | null;
  text: string;
  hashtags: string;
  mentions: string;
  gif_key: string | null;
  payload_key: string | null;
  swf_key: string | null;
  thumbnail_key: string | null;
  game_description?: string | null;
  parent_id: string | null;
  root_id: string | null;
  depth: number;
  fresh_count: number;
  bookmark_count: number;
  reply_count: number;
  impressions: number;
  status: string;
  hidden: number;
  author_language?: string | null;
  actor_id: string | null;
  created_at: string;
  quoted_post_id?: string | null;
  quoted_post?: Record<string, unknown> | null;
  is_freshed?: boolean;
  is_bookmarked?: boolean;
  reactions?: Array<{ emoji: string; count: number; reacted: boolean }>;
  poll?: {
    id: string;
    question: string;
    multipleChoice: boolean;
    endsAt?: string | null;
    ended_notified?: number;
    expired: boolean;
    options: Array<{ id: string; label: string; votes_count: number }>;
    userVote: string | null;
  };
};

export type PollRow = {
  id: string;
  post_id: string;
  question: string;
  multiple_choice: number;
  ends_at: string | null;
  ended_notified: number;
};

export type PollOptionRow = {
  id: string;
  poll_id: string;
  label: string;
  votes_count: number;
};

export type WebfingerData = {
  links?: Array<{ rel: string; href?: string; type?: string }>;
};

export type ActorData = {
  inbox?: string;
  publicKey?: { publicKeyPem?: string };
};
