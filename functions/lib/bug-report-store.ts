/**
 * Bug-report D1 rows are reservation metadata only: a per-user content
 * fingerprint, the created issue URL and an expiry. Report text, diagnostics
 * and screenshots are never written to D1.
 */
export async function cleanupExpiredBugReportSubmissions(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
): Promise<number> {
  const result = await db.prepare('DELETE FROM bug_report_submissions WHERE expires_at <= ?').bind(now).run();
  return Number(result.meta.changes) || 0;
}
