// Mail thread helpers that need real DOM APIs (iframe srcdoc, Blob download).
// Kept out of Svelte so the components stay markup-only.
import { t } from '../i18n.ts';
import { getResolvedTheme } from '../theme.ts';
import type { MailMessage } from './api.ts';
import { type DecryptedMessage, downloadAttachment } from './reader.ts';
import { createMailRenderer, sanitizeMailHtml } from './render.ts';

/** Render a decrypted message body into a sandboxed iframe host. */
export function mountMailHtml(host: HTMLElement, html: string): void {
  const frame = createMailRenderer();
  frame.className = 'mail-message-html';
  frame.title = t('mail.message_body') || 'Message body';
  const dark = getResolvedTheme() === 'dark';
  const colors = dark
    ? 'color:#f8fafc;background:#181d28;a{color:#34d399}'
    : 'color:#0f172a;background:#ffffff;a{color:#047857}';
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.7;${colors}}a{text-decoration:underline}p{margin:0 0 0.75em}img{max-width:100%;height:auto}</style></head><body>${sanitizeMailHtml(html)}</body></html>`;
  host.replaceChildren(frame);
}

/** Decrypt one attachment and hand the bytes to the browser's download flow. */
export async function downloadMailAttachment(
  message: DecryptedMessage,
  attachment: NonNullable<MailMessage['attachments']>[number],
): Promise<void> {
  const bytes = await downloadAttachment(message, attachment);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: attachment.content_type }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = attachment.filename || 'attachment';
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
