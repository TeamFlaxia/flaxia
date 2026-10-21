import { formatCount } from '../lib/format.js';
import { t } from '../lib/i18n.js';

export interface PollData {
  id: string;
  question: string;
  userVote: string | null;
  expired: boolean;
  multipleChoice: boolean;
  endsAt?: string | null;
  options: Array<{ id: string; label: string; votes_count: number }>;
}

function formatRemainingTime(endsAt: string): string {
  const diff = new Date(endsAt).getTime() - Date.now();
  if (diff <= 0) return t('poll.ended');
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(hours / 24);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (days > 0) return t('poll.remaining_days', { count: days });
  if (hours > 0) return t('poll.remaining_hours', { count: hours });
  if (minutes > 0) return t('poll.remaining_minutes', { count: minutes });
  return t('poll.remaining_less_minute');
}

export function createPollElement(poll: PollData): HTMLElement {
  const totalVotes = poll.options.reduce(
    (sum: number, opt: { id: string; label: string; votes_count: number }) => sum + Number(opt.votes_count || 0),
    0,
  );
  const hasVoted = !!poll.userVote;
  const isExpired = poll.expired;
  const showResults = hasVoted || isExpired;
  const canChangeVote = hasVoted && !isExpired;

  const container = document.createElement('div');
  container.className = 'post-poll';
  container.style.cssText = `margin: 12px 0; padding: 12px; background: var(--bg-secondary); border-radius: 8px;`;

  const question = document.createElement('div');
  question.className = 'poll-question';
  question.style.cssText = `font-weight: 600; margin-bottom: 8px; color: var(--text-primary);`;
  question.textContent = poll.question;
  container.appendChild(question);

  if (isExpired) {
    const endedBadge = document.createElement('div');
    endedBadge.style.cssText = `font-size: 0.75rem; color: var(--text-muted); margin-bottom: 6px;`;
    endedBadge.textContent = t('poll.ended');
    container.appendChild(endedBadge);
  }

  poll.options.forEach((opt: { id: string; label: string; votes_count: number }) => {
    const optEl = document.createElement('div');
    optEl.className = 'poll-option';
    const pct = totalVotes > 0 ? Math.round((opt.votes_count / totalVotes) * 100) : 0;
    const isOwnVote = opt.id === poll.userVote;
    const clickable = !isExpired && !isOwnVote;
    optEl.style.cssText = `
      position: relative; padding: 8px 12px; margin-bottom: 6px; border-radius: 6px;
      cursor: ${clickable ? 'pointer' : 'default'};
      background: var(--bg-primary); overflow: hidden;
      transition: opacity 0.2s; border: 1px solid var(--border);
      ${showResults || opt.votes_count > 0 ? '' : 'opacity: 0.9;'}
      ${isOwnVote ? 'border-color: var(--accent);' : ''}
    `;

    const bar = document.createElement('div');
    bar.className = 'poll-bar';
    bar.style.cssText = `
      position: absolute; top: 0; left: 0; height: 100%;
      background: var(--accent);
      width: ${showResults ? pct : 0}%; transition: width 0.5s ease; border-radius: 5px;
      opacity: 0.25;
    `;
    optEl.appendChild(bar);

    const label = document.createElement('span');
    label.className = 'poll-option-label';
    label.style.cssText = `position: relative; z-index: 1; display: flex; justify-content: space-between; align-items: center;`;
    const textSpan = document.createElement('span');
    textSpan.textContent = opt.label;
    const countSpan = document.createElement('span');
    countSpan.style.cssText = `font-size: 0.8rem; color: var(--text-muted); margin-left: 8px;`;
    countSpan.textContent = showResults ? `${pct}%` : '';
    label.appendChild(textSpan);
    label.appendChild(countSpan);
    optEl.appendChild(label);

    if (clickable) {
      optEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const response = await fetch(`/api/polls/${poll.id}/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ optionId: opt.id }),
          });
          if (response.status === 409) {
            return;
          }
          if (!response.ok) {
            const errBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
            if (errBody?.error) console.error(t('poll.vote_error'), errBody.error);
            return;
          }
          const data = (await response.json()) as {
            options: Array<{ id: string; label: string; votes_count: number }>;
            userVote: string | null;
          };
          const newPoll = { ...poll, options: data.options, userVote: data.userVote };
          container.replaceWith(createPollElement(newPoll));
        } catch (e) {
          console.error('Vote failed:', e);
        }
      });
      optEl.addEventListener('mouseenter', () => {
        optEl.style.borderColor = 'var(--accent)';
      });
      optEl.addEventListener('mouseleave', () => {
        optEl.style.borderColor = 'var(--border)';
      });
    }
    container.appendChild(optEl);
  });

  const footer = document.createElement('div');
  footer.style.cssText = `font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;`;

  const voteText =
    totalVotes === 1
      ? t('poll.votes', { count: formatCount(totalVotes) })
      : t('poll.votes_plural', { count: formatCount(totalVotes) });
  const votedText = hasVoted ? ` · ${t('poll.voted')}` : '';
  const changeHint = canChangeVote ? ` · ${t('poll.click_to_change')}` : '';
  let timeText = '';
  if (poll.endsAt && !isExpired) {
    const remaining = formatRemainingTime(poll.endsAt);
    timeText = ` · ${t('poll.remaining', { time: remaining })}`;
  }

  footer.textContent = `${voteText}${votedText}${changeHint}${timeText}`;
  container.appendChild(footer);

  return container;
}
