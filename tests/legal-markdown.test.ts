// Legal markdown is injected with {@html}, so an href built from a repo-local
// markdown file must never be able to execute script. Keep the allowlist tight
// and preserve the exact output for the normal links used by the legal pages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownToHtml } from '../src/lib/legal/markdown.ts';

function hrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((match) => match[1]);
}

test('legal markdown keeps the exact markup for allowed link schemes', () => {
  const cases = [
    { url: 'https://example.com', label: 'site' },
    { url: 'http://example.com/path', label: 'insecure' },
    { url: 'mailto:teamflaxia@proton.me', label: 'email' },
    { url: '/privacy', label: 'relative' },
    { url: '#section', label: 'anchor' },
  ] as const;
  for (const { url, label } of cases) {
    const html = markdownToHtml(`[${label}](${url})`);
    assert.equal(
      html,
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
      `${url} must keep the existing anchor markup`,
    );
  }
});

test('legal markdown keeps entity-escaped href values unchanged', () => {
  const html = markdownToHtml('[terms](https://example.com?a=1&b=2)');
  assert.equal(html, '<a href="https://example.com?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">terms</a>');
});

test('legal markdown drops dangerous link schemes instead of emitting an href', () => {
  const dangerous = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://example.com/uuid',
  ] as const;
  for (const url of dangerous) {
    const html = markdownToHtml(`[click](${url})`);
    assert.equal(hrefs(html).length, 0, `${url} must not produce an <a href>`);
    assert.doesNotMatch(html, /javascript:|data:|vbscript:|file:|blob:/i, `${url} must not survive in the HTML`);
  }
});

test('legal markdown normalises browser-ignored whitespace and entities before checking the scheme', () => {
  const evasions = [
    'java\nscript:alert(1)',
    'java\tscript:alert(1)',
    '\u0000javascript:alert(1)',
    'java&#x73;cript:alert(1)',
    '&#106;avascript:alert(1)',
  ] as const;
  for (const url of evasions) {
    const html = markdownToHtml(`[click](${url})`);
    assert.equal(hrefs(html).length, 0, `${JSON.stringify(url)} must not produce an <a href>`);
    assert.doesNotMatch(html, /javascript:/i, `${JSON.stringify(url)} must not decode to javascript:`);
  }
});

test('legal markdown cannot break out of the href attribute with a quote', () => {
  const html = markdownToHtml('[click](https://example.com" onmouseover="alert(1))');
  assert.equal(
    html,
    '<a href="https://example.com&quot; onmouseover=&quot;alert(1" target="_blank" rel="noopener noreferrer">click</a>)',
    'the quote must stay inside the href value and no extra attribute may appear',
  );
});
