// Mail HTML rendering (docs/mail.md §9.4).
//
// HTML mail renders inside a `sandbox` iframe with NO allow-scripts and NO
// allow-same-origin. DOMPurify strips scripts/handlers/forms/meta-refresh/
// iframes/object-embed before insertion. Remote images are blocked by default.
// Active attachments (HTML/ZIP/SWF) are never executed.

import DOMPurify from 'dompurify';

export const MAIL_SANDBOX_POLICY = 'sandbox=""';

const INLINE_IMAGE = /^data:image\//i;

/**
 * Block remote media by default (docs/mail.md §9.4). Tracking pixels and
 * remote styles leak the reader's IP and read time, so only inline `data:image`
 * sources survive. Link targets stay intact; only media/background fetches are
 * stripped.
 */
function stripRemoteMedia(node: Element): void {
  const tag = node.tagName.toLowerCase();
  if (tag === 'img' || tag === 'source' || tag === 'video' || tag === 'audio' || tag === 'track') {
    node.removeAttribute('srcset');
    for (const attribute of ['src', 'poster']) {
      const value = node.getAttribute(attribute);
      if (value && !INLINE_IMAGE.test(value.trim())) node.removeAttribute(attribute);
    }
  }
  node.removeAttribute('background');
  node.removeAttribute('style');
}

let mediaHookInstalled = false;
// DOMPurify hooks are process-global, so gate the mail-only stripping instead
// of affecting PostText/DocsPage sanitization when Mail is opened first.
let stripMediaForMail = false;

function installMediaHook(): void {
  if (mediaHookInstalled) return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (stripMediaForMail) stripRemoteMedia(node);
  });
  mediaHookInstalled = true;
}

export function sandboxMailIframe(): { sandbox: string; policyNote: string } {
  // Empty sandbox = fully opaque origin, no scripts.
  return { sandbox: '', policyNote: 'opaque origin' };
}

export function sanitizeMailHtml(dirty: string): string {
  installMediaHook();
  stripMediaForMail = true;
  try {
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
        'style',
        'background',
      ],
      ALLOW_UNKNOWN_PROTOCOLS: false,
      IN_PLACE: false,
    });
    // CSS url() is a second exfiltration path; only inline data:image survives.
    return clean.replace(/url\(\s*['"]?(?!data:image\/)[^)]+\)/gi, 'url(blocked)');
  } finally {
    stripMediaForMail = false;
  }
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
