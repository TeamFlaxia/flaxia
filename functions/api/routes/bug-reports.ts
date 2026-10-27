import { Hono } from 'hono';
import {
  BUG_REPORT_FEATURES,
  type BugReportContent,
  buildBugReportIssueBody,
  buildBugReportIssueTitle,
  fingerprintBugReport,
  parseBugReportDiagnostics,
  validateBugReportContent,
} from '../../lib/bug-report';
import { createGitHubInstallationToken } from '../../lib/github-app';
import { validateImageDimensions } from '../../lib/image-dimensions';
import { checkDeclaredType, detectMimeType, isAllowedImageMime } from '../../lib/scan/mime';
import { requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const bugReports = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const MAX_SCREENSHOT_SIZE = 5 * 1024 * 1024;
const MAX_REQUEST_SIZE = MAX_SCREENSHOT_SIZE + 32 * 1024;
const GITHUB_REPOSITORY = 'TeamFlaxia/flaxia';
const GITHUB_API = 'https://api.github.com';
const ISSUE_LABELS = ['bug', 'user-report'];

interface GitHubIssueResponse {
  number?: unknown;
  html_url?: unknown;
}

function textField(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === 'string' ? value : null;
}

function isLabelValidationError(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('errors' in value)) return false;
  const errors = (value as { errors?: unknown }).errors;
  return (
    Array.isArray(errors) &&
    errors.some((error) => Boolean(error && typeof error === 'object' && 'field' in error && error.field === 'labels'))
  );
}

async function createIssueRequest(
  token: string,
  body: { title: string; body: string; labels?: string[] },
): Promise<Response> {
  return fetch(`${GITHUB_API}/repos/${GITHUB_REPOSITORY}/issues`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

async function ensureIssueLabels(token: string): Promise<boolean> {
  for (const name of ISSUE_LABELS) {
    let response: Response;
    try {
      response = await fetch(`${GITHUB_API}/repos/${GITHUB_REPOSITORY}/labels`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          name,
          color: name === 'bug' ? 'd73a4a' : '1d76db',
          description: name === 'bug' ? 'A problem with Flaxia' : 'A bug report submitted by a Flaxia user',
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return false;
    }
    // 422 is also returned when a concurrent request created the label first.
    if (!response.ok && response.status !== 422) return false;
  }
  return true;
}

async function createIssue(token: string, title: string, body: string): Promise<Response> {
  let response = await createIssueRequest(token, { title, body, labels: ISSUE_LABELS });
  if (response.status !== 422) return response;

  const errorBody = (await response
    .clone()
    .json()
    .catch(() => null)) as unknown;
  if (!isLabelValidationError(errorBody)) return response;

  if (await ensureIssueLabels(token)) {
    response = await createIssueRequest(token, { title, body, labels: ISSUE_LABELS });
    if (response.ok || response.status !== 422) return response;
  }

  // The app may have issue-write permission without permission to create
  // repository labels. In that case the report itself should still succeed.
  return createIssueRequest(token, { title, body });
}

function imageExtension(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    default:
      return 'webp';
  }
}

function screenshotUrl(baseUrl: string, key: string): string {
  const origin = new URL(baseUrl || 'https://flaxia.app').origin;
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `${origin}/api/images/${path}`;
}

async function deleteUploadedImage(bucket: R2Bucket, key: string | undefined): Promise<void> {
  if (!key) return;
  try {
    await bucket.delete(key);
  } catch {
    // The report is already rejected; never log report content or credentials.
  }
}

async function releaseReservation(
  db: D1Database,
  userId: string,
  fingerprint: string,
  reservationId: string,
): Promise<void> {
  try {
    await db
      .prepare('DELETE FROM bug_report_submissions WHERE user_id = ? AND fingerprint = ? AND reservation_id = ?')
      .bind(userId, fingerprint, reservationId)
      .run();
  } catch {
    // A failed cleanup is eventually cleared by the reservation expiration.
  }
}

// Enforce the limit on actual bytes, including extra multipart fields, before parsing.
async function readLimitedForm(request: Request): Promise<FormData | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_SIZE) {
      await reader.cancel().catch(() => {});
      throw new RangeError('request too large');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, { method: 'POST', headers: request.headers, body }).formData();
}

bugReports.post('/bug-reports', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const contentLength = c.req.header('content-length');
  if (contentLength) {
    const requestSize = Number(contentLength);
    if (!Number.isFinite(requestSize) || requestSize > MAX_REQUEST_SIZE) {
      return c.json({ error: 'request_too_large' }, 413);
    }
  }

  let form: FormData;
  try {
    const parsed = await readLimitedForm(c.req.raw);
    if (!parsed) return c.json({ error: 'invalid_request' }, 400);
    form = parsed;
  } catch (error) {
    if (error instanceof RangeError) return c.json({ error: 'request_too_large' }, 413);
    return c.json({ error: 'invalid_request' }, 400);
  }

  const feature = textField(form, 'feature');
  const summary = textField(form, 'summary');
  const details = textField(form, 'details');
  const reproduction = textField(form, 'reproduction');
  if (feature === null || summary === null || details === null || reproduction === null) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const validationError = validateBugReportContent({ feature, summary, details, reproduction });
  if (validationError) return c.json({ error: validationError }, 400);

  if (textField(form, 'publicConfirmation') !== 'true') {
    return c.json({ error: 'public_confirmation_required' }, 400);
  }

  const screenshotEntry = form.get('screenshot');
  if (screenshotEntry !== null && typeof screenshotEntry === 'string') {
    return c.json({ error: 'invalid_screenshot' }, 400);
  }
  if (screenshotEntry && typeof screenshotEntry !== 'string' && screenshotEntry.size === 0) {
    return c.json({ error: 'invalid_screenshot' }, 400);
  }
  const screenshot = screenshotEntry && typeof screenshotEntry !== 'string' ? screenshotEntry : null;
  const screenshotConsent = textField(form, 'screenshotConsent') === 'true';
  if (screenshot && !screenshotConsent) return c.json({ error: 'screenshot_consent_required' }, 400);
  if (screenshot && screenshot.size > MAX_SCREENSHOT_SIZE) return c.json({ error: 'screenshot_too_large' }, 413);

  const diagnosticsConsent = textField(form, 'diagnosticsConsent') === 'true';
  let diagnostics: BugReportContent['diagnostics'];
  if (diagnosticsConsent) {
    const rawDiagnostics = textField(form, 'diagnostics');
    if (!rawDiagnostics) return c.json({ error: 'diagnostics_required' }, 400);
    diagnostics = parseBugReportDiagnostics(rawDiagnostics) ?? undefined;
    if (!diagnostics) return c.json({ error: 'invalid_diagnostics' }, 400);
  }

  const languageValue = textField(form, 'language');
  if (languageValue !== 'ja' && languageValue !== 'en') return c.json({ error: 'invalid_request' }, 400);

  const appId = c.env.GITHUB_APP_ID;
  const installationId = c.env.GITHUB_APP_INSTALLATION_ID;
  const privateKey = c.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !installationId || !privateKey) return c.json({ error: 'github_not_configured' }, 503);
  if (!c.env.DB || !c.env.BUCKET) return c.json({ error: 'storage_unavailable' }, 503);

  let screenshotBytes: Uint8Array | undefined;
  let screenshotBuffer: ArrayBuffer | undefined;
  let screenshotMime: string | undefined;
  if (screenshot) {
    let imageBuffer: ArrayBuffer;
    try {
      imageBuffer = await screenshot.arrayBuffer();
    } catch {
      return c.json({ error: 'invalid_screenshot' }, 400);
    }
    screenshotBuffer = imageBuffer;
    screenshotBytes = new Uint8Array(imageBuffer);
    screenshotMime = detectMimeType(screenshotBytes) ?? undefined;
    if (!screenshotMime || !isAllowedImageMime(screenshotMime) || checkDeclaredType(screenshot.type, screenshotMime)) {
      return c.json({ error: 'invalid_screenshot' }, 400);
    }
    const dimensionsError = validateImageDimensions(screenshotBuffer, screenshotMime);
    if (dimensionsError) return c.json({ error: 'invalid_screenshot' }, 400);
  }

  const content: BugReportContent = {
    feature: feature as BugReportContent['feature'],
    summary,
    details,
    reproduction,
    language: languageValue,
    ...(diagnostics ? { diagnostics } : {}),
  };
  let fingerprint: string;
  try {
    fingerprint = await fingerprintBugReport(content, screenshotBytes);
  } catch {
    return c.json({ error: 'internal_error' }, 500);
  }

  const reservationId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const windowId = Math.floor(now / 86400);
  try {
    // Expired processing reservations and old deduplication entries no longer count.
    await c.env.DB.prepare('DELETE FROM bug_report_submissions WHERE user_id = ? AND expires_at <= ?')
      .bind(user.id, now)
      .run();
    // This single statement makes the quota check and reservation atomic in D1.
    const inserted = await c.env.DB.prepare(`
      INSERT INTO bug_report_submissions (user_id, fingerprint, reservation_id, window_id, state, expires_at)
      SELECT ?, ?, ?, ?, 'processing', ?
      WHERE (SELECT COUNT(*) FROM bug_report_submissions
             WHERE user_id = ? AND window_id = ? AND expires_at > ?) < 3
      ON CONFLICT(user_id, fingerprint) DO NOTHING
    `)
      .bind(user.id, fingerprint, reservationId, windowId, now + 300, user.id, windowId, now)
      .run();
    if (!inserted.meta.changes) {
      const cached = await c.env.DB.prepare(`
        SELECT state, issue_number, issue_url FROM bug_report_submissions
        WHERE user_id = ? AND fingerprint = ? AND expires_at > ?
      `)
        .bind(user.id, fingerprint, now)
        .first<{ state: string; issue_number: number | null; issue_url: string | null }>();
      if (cached?.state === 'created' && cached.issue_number && cached.issue_url) {
        return c.json({ issueNumber: cached.issue_number, issueUrl: cached.issue_url, duplicate: true }, 200);
      }
      if (cached?.state === 'processing') return c.json({ error: 'submission_in_progress' }, 409);
      return c.json({ error: 'rate_limited' }, 429);
    }
  } catch {
    return c.json({ error: 'storage_unavailable' }, 503);
  }

  let uploadedImageKey: string | undefined;
  let issueRequestStarted = false;
  try {
    let imageUrl: string | undefined;
    if (screenshot && screenshotBytes && screenshotMime) {
      uploadedImageKey = `bug-reports/${crypto.randomUUID()}.${imageExtension(screenshotMime)}`;
      await c.env.BUCKET.put(uploadedImageKey, screenshotBytes, {
        httpMetadata: { contentType: screenshotMime, cacheControl: 'public, max-age=31536000, immutable' },
      });
      imageUrl = screenshotUrl(c.env.BASE_URL, uploadedImageKey);
    }

    const installationToken = await createGitHubInstallationToken(appId, installationId, privateKey);
    issueRequestStarted = true;
    const response = await createIssue(
      installationToken,
      buildBugReportIssueTitle(content),
      buildBugReportIssueBody(content, imageUrl),
    );
    if (!response.ok) {
      if (response.status < 500) {
        await releaseReservation(c.env.DB, user.id, fingerprint, reservationId);
        await deleteUploadedImage(c.env.BUCKET, uploadedImageKey);
      }
      return c.json({ error: 'github_unavailable' }, 502);
    }

    const issue = (await response.json().catch(() => null)) as GitHubIssueResponse | null;
    if (!issue || typeof issue.number !== 'number' || typeof issue.html_url !== 'string') {
      // The issue may have been created despite an unreadable response. Keep
      // its screenshot and the short reservation so an immediate retry cannot
      // create a duplicate with a broken image link.
      return c.json({ error: 'github_unavailable' }, 502);
    }
    const issueUrl = issue.html_url;
    if (!/^https:\/\/github\.com\/TeamFlaxia\/flaxia\/issues\/\d+$/.test(issueUrl)) {
      return c.json({ error: 'github_unavailable' }, 502);
    }

    try {
      await c.env.DB.prepare(`
        UPDATE bug_report_submissions SET state = 'created', issue_number = ?, issue_url = ?, expires_at = ?
        WHERE user_id = ? AND fingerprint = ? AND reservation_id = ?
      `)
        .bind(issue.number, issueUrl, Math.floor(Date.now() / 1000) + 86400, user.id, fingerprint, reservationId)
        .run();
    } catch {
      // The GitHub issue already exists; return the URL even if dedupe caching
      // is temporarily unavailable.
    }
    return c.json({ issueNumber: issue.number, issueUrl }, 201);
  } catch {
    if (issueRequestStarted) {
      // GitHub may have accepted a request before a timeout. Keep any attached
      // image alive and hold the short reservation to avoid a broken issue or
      // accidental duplicate.
    } else {
      await deleteUploadedImage(c.env.BUCKET, uploadedImageKey);
      await releaseReservation(c.env.DB, user.id, fingerprint, reservationId);
    }
    return c.json({ error: issueRequestStarted ? 'github_unavailable' : 'upload_failed' }, 502);
  }
});

export { BUG_REPORT_FEATURES };
export default bugReports;
