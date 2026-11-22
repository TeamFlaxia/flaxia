export interface Notification {
  id: string;
  type:
    | 'reported'
    | 'fresh'
    | 'reload'
    | 'warned'
    | 'hidden'
    | 'ap_follow'
    | 'ap_like'
    | 'ap_announce'
    | 'reply'
    | 'mention'
    | 'poll_ended'
    | 'quote';
  post_id: string | null;
  post_text_preview: string | null;
  actor?: {
    username: string;
    display_name: string;
    avatar_key: string | null;
    badge_type?: string | null;
  };
  actors?: Array<{
    username: string;
    display_name: string;
    avatar_key: string | null;
    badge_type?: string | null;
  } | null>;
  actor_id?: string | null;
  actor_data?: string | null;
  read: boolean;
  created_at: string;
}
