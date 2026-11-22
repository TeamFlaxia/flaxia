export interface HiddenPost {
  id: string;
  user_id: string;
  username: string;
  display_name: string;
  text: string;
  created_at: string;
  hidden: number;
  category?: string;
}
