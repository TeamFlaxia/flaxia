<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { formatCount } from '../format.ts';
import { t } from '../i18n.ts';
import { castPollVote } from '../poll/vote.ts';
import { isPollExpired, shouldShowPollResults } from '../poll-state.ts';

export interface PollData {
  id: string;
  question: string;
  userVote: string | null;
  expired?: boolean;
  multipleChoice: boolean;
  endsAt?: string | null;
  options: Array<{ id: string; label: string; votes_count: number }>;
}

let initial: PollData = $props();

let state = $state<PollData>(initial);
let voting = $state(false);
let revealed = $state(false);

const totalVotes = $derived(state.options.reduce((sum, option) => sum + Number(option.votes_count || 0), 0));
const hasVoted = $derived(Boolean(state.userVote));
const expired = $derived(isPollExpired(state));
const showResults = $derived(shouldShowPollResults(state, hasVoted));
const canChangeVote = $derived(hasVoted && !expired());
const maxVotes = $derived(state.options.reduce((max, option) => Math.max(max, Number(option.votes_count || 0)), 0));
const footerText = $derived.by(() => {
  const total = totalVotes();
  const voteText =
    total === 1
      ? t('poll.votes', { count: formatCount(total) })
      : t('poll.votes_plural', { count: formatCount(total) });
  const votedText = hasVoted ? ` · ${t('poll.voted')}` : '';
  const changeHint = canChangeVote() ? ` · ${t('poll.click_to_change')}` : '';
  let timeText = '';
  if (state.endsAt && !expired) timeText = ` · ${t('poll.remaining', { time: formatRemainingTime(state.endsAt) })}`;
  return `${voteText}${votedText}${changeHint}${timeText}`;
});

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

async function castVote(optionId: string): Promise<void> {
  if (voting) return;
  voting = true;
  try {
    const data = await castPollVote(state.id, optionId);
    if (data) state = { ...state, options: data.options, userVote: data.userVote };
  } catch (error) {
    console.error('Vote failed:', error);
  } finally {
    voting = false;
  }
}

function percentage(option: PollData['options'][number]): number {
  return totalVotes > 0 ? Math.round((option.votes_count / totalVotes) * 100) : 0;
}

onMount(() => {
  const raf = requestAnimationFrame(() => (revealed = true));
  return () => cancelAnimationFrame(raf);
});

let expiryTimer: ReturnType<typeof setTimeout> | null = null;
$effect(() => {
  if (expiryTimer) clearTimeout(expiryTimer);
  if (!state.endsAt || isPollExpired(state)) return;
  const endTime = Date.parse(state.endsAt);
  if (!Number.isFinite(endTime)) return;
  const remaining = endTime - Date.now();
  if (remaining <= 0) {
    state = { ...state, expired: true };
    return;
  }
  expiryTimer = setTimeout(
    () => {
      state = { ...state, expired: true };
    },
    Math.min(remaining, 2_147_483_647),
  );
});

onDestroy(() => {
  if (expiryTimer) clearTimeout(expiryTimer);
});
</script>

<div class="post-poll" class:is-expired={expired}>
  <div class="poll-question">{state.question}</div>
  {#if expired}<div class="poll-ended-badge">{t('poll.ended')}</div>{/if}
  <div class="poll-options">
    {#each state.options as option (option.id)}
      {@const own = option.id === state.userVote}
      {@const clickable = !expired && !own && !voting}
      {@const leading = showResults && totalVotes > 0 && Number(option.votes_count) > 0 && Number(option.votes_count) === maxVotes}
      <div
        class="poll-option"
        class:is-clickable={clickable}
        class:is-voted={own}
        class:is-leading={leading}
        role={clickable ? 'button' : undefined}
        tabindex={clickable ? '0' : undefined}
        aria-label={option.label}
        onclick={(e) => { e.stopPropagation(); if (clickable) void castVote(option.id); }}
        onkeydown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          if (clickable) void castVote(option.id);
        }}
      >
        <div class="poll-bar" style="width: {revealed ? percentage(option) : 0}%"></div>
        <span class="poll-option-label">
          <span class="poll-option-text">{option.label}</span>
          {#if showResults}
            <span class="poll-option-pct">{percentage(option)}%{#if own}<span class="poll-voted-check" aria-hidden="true">✓</span>{/if}</span>
          {/if}
        </span>
      </div>
    {/each}
  </div>
  <div class="post-poll-footer">{footerText}</div>
</div>
