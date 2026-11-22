export interface AdminUser {
  id: string;
  username: string;
  display_name: string;
  email: string;
  created_at: string;
  role?: string | null;
  is_admin?: boolean;
  frozen_at?: string | null;
  frozen_reason?: string | null;
}
