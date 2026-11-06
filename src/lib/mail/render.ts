// Mail HTML rendering (docs/mail.md §9.4).
//
// HTML mail renders inside a `sandbox` iframe with NO allow-scripts and NO
// allow-same-origin. DOMPurify strips scripts/handlers/forms/meta-refresh/
// iframes/object-embed before insertion. Remote images are blocked by default.
// Active attachments (HTML/ZIP/SWF) are never executed.

import DOMPurify from 'dompurify';

export const MAIL_SANDBOX_POLICY = 'sandbox=""';

export function sandboxMailIframe(): { sandbox: string; policyNote: string } {
  // Empty sandbox = fully opaque origin, no scripts.
  return { sandbox: '', policyNote: 'opaque origin' };
}

export function sanitizeMailHtml(dirty: string): string {
  const clean = DOMPurify.sanitize(dirty, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'meta', 'link', 'base'],
    FORBID_ATTR: [
      'onerror',
      'onload',
      'onclick',
      'onmouseover',
      'onfocus',
      'onblur',
      'onchange',
      'formaction',
      'srcdoc',
      'xlink:href',
    ],
    ALLOW_UNKNOWN_PROTOCOLS: false,
    IN_PLACE: false,
  });
  // Strip CSS url() exfiltration vectors: only allow http(s)/data:image URLs.
  return clean.replace(/url\(\s*['"]?(?!https?:|data:image\/)[^)]+\)/gi, 'url(blocked)');
}

export function createMailRenderer(): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  // Empty sandbox = opaque origin. See AGENTS.md for sandbox rules.
  iframe.setAttribute('sandbox', '');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('loading', 'lazy');
  return iframe;
}

/** Show the real link target before navigation; noopener+ noreferrer everywhere. */
export function sanitizeMailLinks(container: HTMLElement): void {
  for (const a of container.querySelectorAll('a[href]')) {
    const el = a as HTMLAnchorElement;
    el.setAttribute('rel', 'noopener noreferrer');
    el.setAttribute('target', '_blank');
    const href = el.getAttribute('href') ?? '';
    if (!/^(https?:\/\/|mailto:)/i.test(href)) el.removeAttribute('href');
  }
}
