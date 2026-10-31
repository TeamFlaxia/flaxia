export const BUG_REPORT_FEATURES = ['timeline', 'arcade', 'chat', 'crowd', 'account', 'other'] as const;
export type BugReportFeature = (typeof BUG_REPORT_FEATURES)[number];

export interface BugReportDiagnostics {
  appVersion: string;
  commit: string;
  os: string;
  browser: string;
  occurredAt: string;
}

export interface BugReportContent {
  feature: BugReportFeature | '';
  summary: string;
  details: string;
  reproduction: string;
  language: 'ja' | 'en';
  diagnostics?: BugReportDiagnostics;
}

export type BugReportValidationError =
  | 'invalid_feature'
  | 'invalid_summary'
  | 'invalid_details'
  | 'invalid_reproduction';

export function validateBugReportContent(content: {
  feature: unknown;
  summary: unknown;
  details: unknown;
  reproduction: unknown;
}): BugReportValidationError | null {
  if (content.feature !== '' && !BUG_REPORT_FEATURES.some((feature) => feature === content.feature)) {
    return 'invalid_feature';
  }
  if (typeof content.summary !== 'string' || content.summary.trim().length === 0 || content.summary.length > 100) {
    return 'invalid_summary';
  }
  if (typeof content.details !== 'string' || content.details.trim().length === 0 || content.details.length > 5000) {
    return 'invalid_details';
  }
  if (typeof content.reproduction !== 'string' || content.reproduction.length > 2000) {
    return 'invalid_reproduction';
  }
  return null;
}

/** Diagnostics are small by construction; cap the raw JSON before parsing it. */
export const MAX_DIAGNOSTICS_JSON_LENGTH = 4096;

export function parseBugReportDiagnostics(raw: string): BugReportDiagnostics | null {
  if (raw.length > MAX_DIAGNOSTICS_JSON_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const fields = ['appVersion', 'commit', 'os', 'browser', 'occurredAt'] as const;
  const parsed: Partial<BugReportDiagnostics> = {};
  for (const field of fields) {
    const entry = record[field];
    if (
      typeof entry !== 'string' ||
      entry.length > 120 ||
      Array.from(entry).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      return null;
    }
    parsed[field] = entry.trim();
  }
  return parsed as BugReportDiagnostics;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function textBlock(value: string): string {
  return `<pre>${escapeHtml(value)}</pre>`;
}

export function buildBugReportIssueTitle(content: BugReportContent): string {
  const feature = content.feature ? `[${content.feature}]` : '';
  const summary = content.summary.trim().replace(/\s+/g, ' ');
  return `[Bug]${feature} ${summary}`;
}

export function buildBugReportIssueBody(content: BugReportContent, screenshotUrl?: string): string {
  const ja = content.language === 'ja';
  const sections = [
    `## ${ja ? '概要' : 'Summary'}\n${textBlock(content.summary.trim())}`,
    `## ${ja ? '発生した機能' : 'Affected feature'}\n${textBlock(content.feature || (ja ? '未選択' : 'Not selected'))}`,
    `## ${ja ? '詳細' : 'Details'}\n${textBlock(content.details.trim())}`,
    `## ${ja ? '再現手順' : 'Steps to reproduce'}\n${textBlock(content.reproduction.trim() || (ja ? '未記入' : 'Not provided'))}`,
  ];
  if (content.diagnostics) {
    const labels = ja
      ? ['アプリ版', 'Commit', 'OS', 'ブラウザ', '発生日時']
      : ['App version', 'Commit', 'OS', 'Browser', 'Reported at'];
    const values = [
      content.diagnostics.appVersion,
      content.diagnostics.commit,
      content.diagnostics.os,
      content.diagnostics.browser,
      content.diagnostics.occurredAt,
    ];
    sections.push(
      `## ${ja ? '診断情報（送信に同意済み）' : 'Diagnostics (user consented)'}\n${textBlock(
        values.map((value, index) => `${labels[index]}: ${value}`).join('\n'),
      )}`,
    );
  }
  if (screenshotUrl) {
    sections.push(
      `## ${ja ? 'スクリーンショット（公開に同意済み）' : 'Screenshot (user consented to public sharing)'}\n![${ja ? 'スクリーンショット' : 'Screenshot'}](${screenshotUrl})`,
    );
  }
  return sections.join('\n\n');
}

/** Fingerprint the submitted content without persisting it in KV. */
export async function fingerprintBugReport(content: BugReportContent, screenshotBytes?: Uint8Array): Promise<string> {
  const diagnostics = content.diagnostics ? { ...content.diagnostics, occurredAt: '' } : undefined;
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      feature: content.feature,
      summary: content.summary.trim(),
      details: content.details.trim(),
      reproduction: content.reproduction.trim(),
      language: content.language,
      diagnostics,
    }),
  );
  const image = screenshotBytes ?? new Uint8Array();
  const bytes = new Uint8Array(metadata.length + image.length + 1);
  bytes.set(metadata, 0);
  bytes[metadata.length] = 0;
  bytes.set(image, metadata.length + 1);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
