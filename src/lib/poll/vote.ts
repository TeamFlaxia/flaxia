// Poll voting request logic, shared by the Svelte widget and its tests.
import { t } from '../i18n.ts';

export interface PollVoteResult {
  options: Array<{ id: string; label: string; votes_count: number }>;
  userVote: string | null;
}

export async function castPollVote(pollId: string, optionId: string): Promise<PollVoteResult | null> {
  const response = await fetch(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ optionId }),
  });
  if (response.status === 409) return null;
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (body?.error) console.error(t('poll.vote_error'), body.error);
    return null;
  }
  return (await response.json()) as PollVoteResult;
}
