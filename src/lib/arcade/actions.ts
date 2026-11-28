// Arcade action adapters. Svelte components call these functions so the legacy
// modal factories and network payloads stay outside the view layer.
import { maxUploadBytesForUser } from '../../../shared/upload-limits.ts';
import { GameUploadModal } from '../../components/GameUploadModal.ts';
import { showSignInPrompt } from '../../components/SignInPrompt.ts';
import { navigate } from '../navigation.ts';

export type ArcadeSignInAction = 'fresh' | 'bookmark' | 'report' | 'upload';

export interface DmcaReport {
  work_description: string;
  reporter_email: string;
  sworn: boolean;
}

export interface FreshResult {
  freshed: boolean;
  is_freshed?: boolean;
  fresh_count: number;
}

export interface BookmarkResult {
  bookmarked: boolean;
  is_bookmarked?: boolean;
  bookmark_count: number;
}

export function promptArcadeSignIn(action: ArcadeSignInAction): void {
  showSignInPrompt(
    action,
    () => void navigate('/login'),
    () => void navigate('/register'),
  );
}

export function openArcadeUpload(
  user: { badge_type?: string | null; role?: string | null } | null,
  onUploaded: (postId: string) => void,
): void {
  new GameUploadModal({
    maxUploadBytes: maxUploadBytesForUser(user),
    onUploaded,
  });
}

export async function toggleArcadeFresh(postId: string): Promise<FreshResult> {
  const response = await fetch(`/api/posts/${postId}/fresh`, { method: 'POST', credentials: 'include' });
  if (!response.ok) throw new Error('Failed to toggle fresh');
  return (await response.json()) as FreshResult;
}

export async function toggleArcadeBookmark(postId: string): Promise<BookmarkResult> {
  const response = await fetch(`/api/posts/${postId}/bookmark`, { method: 'POST', credentials: 'include' });
  if (!response.ok) throw new Error('Failed to toggle bookmark');
  return (await response.json()) as BookmarkResult;
}

/** Returns 'duplicate' when the server already has this report (409). */
export async function submitArcadeReport(
  postId: string,
  category: string,
  dmca?: DmcaReport,
): Promise<'ok' | 'duplicate'> {
  const body: { post_id: string; category: string; dmca?: DmcaReport } = { post_id: postId, category };
  if (dmca) body.dmca = dmca;
  const response = await fetch('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (response.status === 409) return 'duplicate';
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || 'Failed to submit report');
  }
  return 'ok';
}
