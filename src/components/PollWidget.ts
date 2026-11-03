import { formatCount } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { isPollExpired, shouldShowPollResults } from '../lib/poll-state.js';

export interface PollData {
  id: string;
  question: string;
  userVote: string | null;
  expired?: boolean;
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
  const isExpired = isPollExpired(poll);
  const showResults = shouldShowPollResults(poll, hasVoted);
  const canChangeVote = hasVoted && !isExpired;
  const maxVotes = poll.options.reduce(
    (max: number, opt: { votes_count: number }) => Math.max(max, Number(opt.votes_count || 0)),
    0,
  );

  const container = document.createElement('div');
  container.className = `post-poll${isExpired ? ' is-expired' : ''}`;

  const question = document.createElement('div');
  question.className = 'poll-question';
  question.textContent = poll.question;
  container.appendChild(question);

  if (isExpired) {
    const endedBadge = document.createElement('div');
    endedBadge.className = 'poll-ended-badge';
    endedBadge.textContent = t('poll.ended');
    container.appendChild(endedBadge);
  }

  const optionsList = document.createElement('div');
  optionsList.className = 'poll-options';
  container.appendChild(optionsList);

  // Bars render at 0% and are widened on the next frame so the fill
  // animates in (and re-animates after a vote re-renders the widget).
  const fills: Array<{ bar: HTMLElement; pct: number }> = [];

  poll.options.forEach((opt: { id: string; label: string; votes_count: number }) => {
    const optEl = document.createElement('div');
    const pct = totalVotes > 0 ? Math.round((opt.votes_count / totalVotes) * 100) : 0;
    const isOwnVote = opt.id === poll.userVote;
    const isLeading =
      showResults && totalVotes > 0 && Number(opt.votes_count || 0) > 0 && Number(opt.votes_count) === maxVotes;
    const clickable = !isExpired && !isOwnVote;

    optEl.className = [
      'poll-option',
      clickable ? 'is-clickable' : '',
      isOwnVote ? 'is-voted' : '',
      isLeading ? 'is-leading' : '',
    ]
      .filter(Boolean)
      .join(' ');

    const bar = document.createElement('div');
    bar.className = 'poll-bar';
    bar.style.width = '0%';
    optEl.appendChild(bar);
    if (showResults) fills.push({ bar, pct });

    const label = document.createElement('span');
    label.className = 'poll-option-label';

    const textSpan = document.createElement('span');
    textSpan.className = 'poll-option-text';
    textSpan.textContent = opt.label;

    const pctSpan = document.createElement('span');
    pctSpan.className = 'poll-option-pct';
    if (showResults) {
      pctSpan.textContent = `${pct}%`;
      if (isOwnVote) {
        const check = document.createElement('span');
        check.className = 'poll-voted-check';
        check.textContent = '✓';
        check.setAttribute('aria-hidden', 'true');
        pctSpan.appendChild(check);
      }
    }

    label.appendChild(textSpan);
    label.appendChild(pctSpan);
    optEl.appendChild(label);

    if (clickable) {
      const castVote = async (): Promise<void> => {
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
      };

      // Keyboard parity for the div-based options (Enter / Space).
      optEl.setAttribute('role', 'button');
      optEl.setAttribute('tabindex', '0');
      optEl.setAttribute('aria-label', opt.label);

      optEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        await castVote();
      });
      optEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        void castVote();
      });
    }

    optionsList.appendChild(optEl);
  });

  const footer = document.createElement('div');
  footer.className = 'post-poll-footer';

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

  if (fills.length > 0) {
    requestAnimationFrame(() => {
      for (const { bar, pct } of fills) {
        bar.style.width = `${pct}%`;
      }
    });
  }

  if (!isExpired && poll.endsAt) {
    const endTime = Date.parse(poll.endsAt);
    if (Number.isFinite(endTime) && endTime > Date.now()) {
      const scheduleExpiry = () => {
        const remainingTime = endTime - Date.now();
        if (remainingTime > 0) {
          window.setTimeout(scheduleExpiry, Math.min(remainingTime, 2_147_483_647));
          return;
        }
        if (container.isConnected) {
          container.replaceWith(createPollElement({ ...poll, expired: true }));
        }
      };
      window.setTimeout(scheduleExpiry, Math.min(endTime - Date.now(), 2_147_483_647));
    }
  }

  return container;
}
