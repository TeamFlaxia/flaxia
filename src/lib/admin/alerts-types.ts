export interface AdminAlert {
  id: string;
  post_id: string;
  category: string;
  priority: 'critical' | 'high' | 'normal';
  resolved: number;
  created_at: string;
  dmca_work_description?: string;
  dmca_reporter_email?: string;
  dmca_sworn?: number;
  post_text?: string;
  payload_key?: string;
}
