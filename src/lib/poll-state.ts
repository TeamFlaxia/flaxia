export interface PollExpiryState {
  endsAt?: string | null;
  expired?: boolean;
}

/** Return whether the server or the end timestamp says a poll has ended. */
export function isPollExpired(poll: PollExpiryState, now = Date.now()): boolean {
  if (poll.expired === true) return true;
  if (!poll.endsAt) return false;

  const endTime = Date.parse(poll.endsAt);
  return Number.isFinite(endTime) && endTime <= now;
}

/** Results are available to everyone once a poll ends, and to voters while it is open. */
export function shouldShowPollResults(poll: PollExpiryState, hasVoted: boolean, now = Date.now()): boolean {
  return hasVoted || isPollExpired(poll, now);
}
