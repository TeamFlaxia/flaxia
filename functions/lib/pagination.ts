/**
 * Clamp a client-supplied `limit` query value into a safe range.
 *
 * SQLite treats a negative LIMIT as unlimited, so `Math.min(n, max)` alone
 * lets `?limit=-1` dump a whole table. Always floor at 1 and cap at `max`.
 */
export function clampLimit(raw: string | null | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    // Non-numeric input falls back to the default; a numeric value below 1
    // is floored instead of passed through (negative LIMIT is unlimited).
    if (raw === null || raw === undefined || raw === '' || Number.isNaN(parsed)) return fallback;
    return 1;
  }
  return Math.min(parsed, max);
}
