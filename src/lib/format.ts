export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k < 10 ? `${k.toFixed(1).replace(/\.0$/, '')}k` : `${Math.floor(k)}k`;
  }
  const m = n / 1_000_000;
  return m < 10 ? `${m.toFixed(1).replace(/\.0$/, '')}M` : `${Math.floor(m)}M`;
}

/** Formats a 0–100 percentage with at most one decimal place. */
export function formatPercentage(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(1).replace(/\.0$/, '');
}

/** Bar width (0–100) relative to the largest value in the group. */
export function relativeBarPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}
