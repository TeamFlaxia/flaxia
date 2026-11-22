export interface AdminAd {
  id: string;
  title: string;
  ad_type: 'self_hosted' | 'admax';
  body_text: string;
  click_url: string | null;
  payload_key: string | null;
  payload_type: 'zip' | 'swf' | 'gif' | 'image' | null;
  thumbnail_key?: string;
  impressions: number;
  clicks: number;
  active: number;
  created_at: string;
  ctr?: number;
  interaction_count?: number;
}
