import { formatCount } from '../lib/format.ts';
import { t } from '../lib/i18n.ts';
import { isPollExpired, shouldShowPollResults } from '../lib/poll-state.ts';
import {
  type Accessor,
  afterPaint,
  computed,
  each,
  effect,
  html,
  mount,
  onCleanup,
  onMount,
  type Renderable,
  signal,
  when,
} from '../lib/render/index.ts';

export interface PollData {
  id: string;
  question: string;
  userVote: string | null;
  expired?: boolean;
  multipleChoice: boolean;
  endsAt?: string | null;
  options: Array<{ id: string; label: string; votes_count: number }>;
}

type PollOption = PollData['options'][number];

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

function PollOptionView(
  option: Accessor<PollOption>,
  state: Accessor<PollData>,
  totalVotes: Accessor<number>,
  maxVotes: Accessor<number>,
  showResults: Accessor<boolean>,
  expired: Accessor<boolean>,
  isVoting: Accessor<boolean>,
  castVote: (optionId: string) => void,
): Renderable {
  // Bars start at 0 and expand on the next paint, which gives the same entrance
  // animation as the previous implementation without replacing the widget.
  const revealed = signal(false);
  onMount(() => {
    const cancel = afterPaint(() => revealed.set(true));
    onCleanup(cancel);
  });

  const isOwnVote = () => option().id === state().userVote;
  const clickable = () => !expired() && !isOwnVote() && !isVoting();
  const percentage = computed(() => {
    const total = totalVotes();
    return total > 0 ? Math.round((option().votes_count / total) * 100) : 0;
  });
  const isLeading = computed(
    () =>
      showResults() &&
      totalVotes() > 0 &&
      Number(option().votes_count) > 0 &&
      Number(option().votes_count) === maxVotes(),
  );
  const className = () =>
    ['poll-option', clickable() ? 'is-clickable' : '', isOwnVote() ? 'is-voted' : '', isLeading() ? 'is-leading' : '']
      .filter(Boolean)
      .join(' ');

  const activate = (event: Event): void => {
    event.stopPropagation();
    if (!clickable()) return;
    castVote(option().id);
  };

  const activateFromKeyboard = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ') return;
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
    if (!clickable()) return;
    castVote(option().id);
  };

  return html`<div
    class=${className}
    role=${() => (clickable() ? 'button' : null)}
    tabindex=${() => (clickable() ? '0' : null)}
    aria-label=${() => option().label}
    @click=${activate}
    @keydown=${activateFromKeyboard}
  >
    <div class="poll-bar" style=${() => `width:${revealed() ? percentage() : 0}%`}></div>
    <span class="poll-option-label">
      <span class="poll-option-text">${() => option().label}</span>
      ${when(
        showResults,
        () =>
          html`<span class="poll-option-pct"
            >${() => `${percentage()}%`}${when(
              isOwnVote,
              () => html`<span class="poll-voted-check" aria-hidden="true">✓</span>`,
            )}</span
          >`,
      )}
    </span>
  </div>`;
}

function PollView(initial: PollData): Renderable {
  const state = signal(initial);
  const voting = signal(false);

  const totalVotes = computed(() => state().options.reduce((sum, option) => sum + Number(option.votes_count || 0), 0));
  const hasVoted = computed(() => Boolean(state().userVote));
  const expired = computed(() => isPollExpired(state()));
  const showResults = computed(() => shouldShowPollResults(state(), hasVoted()));
  const canChangeVote = computed(() => hasVoted() && !expired());
  const maxVotes = computed(() =>
    state().options.reduce((maximum, option) => Math.max(maximum, Number(option.votes_count || 0)), 0),
  );

  const footerText = computed(() => {
    const total = totalVotes();
    const voteText =
      total === 1
        ? t('poll.votes', { count: formatCount(total) })
        : t('poll.votes_plural', { count: formatCount(total) });
    const votedText = hasVoted() ? ` · ${t('poll.voted')}` : '';
    const changeHint = canChangeVote() ? ` · ${t('poll.click_to_change')}` : '';
    let timeText = '';
    const endsAt = state().endsAt;
    if (endsAt && !expired()) {
      timeText = ` · ${t('poll.remaining', { time: formatRemainingTime(endsAt) })}`;
    }
    return `${voteText}${votedText}${changeHint}${timeText}`;
  });

  const castVote = (optionId: string): void => {
    if (voting.peek()) return;
    voting.set(true);

    void (async () => {
      try {
        const response = await fetch(`/api/polls/${state.peek().id}/vote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ optionId }),
        });

        if (response.status === 409) return;
        if (!response.ok) {
          const errBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          if (errBody?.error) console.error(t('poll.vote_error'), errBody.error);
          return;
        }

        const data = (await response.json()) as {
          options: Array<{ id: string; label: string; votes_count: number }>;
          userVote: string | null;
        };
        state.set({ ...state.peek(), options: data.options, userVote: data.userVote });
      } catch (error) {
        console.error('Vote failed:', error);
      } finally {
        voting.set(false);
      }
    })();
  };

  // One timer for the current state. A vote resets it; expiry flips the state
  // once and the next run returns early.
  effect(() => {
    const current = state();
    if (!current.endsAt || isPollExpired(current)) return;

    const endTime = Date.parse(current.endsAt);
    if (!Number.isFinite(endTime)) return;

    const remaining = endTime - Date.now();
    if (remaining <= 0) {
      state.set({ ...current, expired: true });
      return;
    }

    const timer = window.setTimeout(
      () => {
        state.set({ ...state.peek(), expired: true });
      },
      Math.min(remaining, 2_147_483_647),
    );

    return () => window.clearTimeout(timer);
  });

  return html`<div class=${() => `post-poll${expired() ? ' is-expired' : ''}`}>
    <div class="poll-question">${() => state().question}</div>
    ${when(expired, () => html`<div class="poll-ended-badge">${t('poll.ended')}</div>`)}
    <div class="poll-options">
      ${each(
        () => state().options,
        (option) => option.id,
        (option) => PollOptionView(option, state, totalVotes, maxVotes, showResults, expired, voting, castVote),
      )}
    </div>
    <div class="post-poll-footer">${() => footerText()}</div>
  </div>`;
}

export function createPollElement(poll: PollData): HTMLElement {
  const container = document.createElement('div');
  const mounted = mount(container, () => PollView(poll));
  (container as HTMLElement & { destroy?: () => void }).destroy = () => mounted.dispose();
  return container;
}
