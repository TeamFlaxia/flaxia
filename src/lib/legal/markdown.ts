// Pure legal markdown → HTML transform (the markdown is escaped before any
// substitution, so the result is safe to render with {@html}).

// Only navigational URLs may become an href. `&<>` are escaped before this
// point, but quotes are not, and browsers ignore leading whitespace/control
// characters when parsing a URL scheme — normalise before checking it.
const ALLOWED_HREF = /^(?:https?:|mailto:|\/|#)/;

function isAllowedHref(url: string): boolean {
  let start = 0;
  while (start < url.length) {
    const code = url.charCodeAt(start);
    if (code > 0x20 && !/\s/.test(url.charAt(start))) break;
    start += 1;
  }
  return ALLOWED_HREF.test(url.slice(start).toLowerCase());
}

function escapeHrefAttribute(url: string): string {
  return url.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function markdownToHtml(markdown: string): string {
  let html = markdown;

  html = html.replace(/&/g, '&amp;');
  html = html.replace(/</g, '&lt;');
  html = html.replace(/>/g, '&gt;');

  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');

  html = html.replace(
    /\|(.+)\|[\r\n]+\|[-\s|]+\|[\r\n]+((?:\|.+[\r\n?]+)+)/g,
    (_match: string, header: string, body: string) => {
      const headerCells = header
        .split('|')
        .map((c: string) => c.trim())
        .filter((c: string) => c);
      const rows = body.trim().split('\n');
      return `<table class="legal-table"><thead><tr>${headerCells.map((c: string) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows
        .map(
          (row: string) =>
            `<tr>${row
              .split('|')
              .map((c: string) => c.trim())
              .filter((c: string) => c)
              .map((c: string) => `<td>${c}</td>`)
              .join('')}</tr>`,
        )
        .join('')}</tbody></table>`;
    },
  );

  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match: string, label: string, url: string) => {
    // Disallowed schemes (javascript:, data:, vbscript:, ...) lose the anchor
    // entirely; a legal link keeps the exact markup it always had.
    if (!isAllowedHref(url)) return label;
    return `<a href="${escapeHrefAttribute(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  html = html.replace(/^\s*\d+\.\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/^\s*-\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => {
    if (match.includes('1.') || match.includes('2.') || match.includes('3.')) return '<ol>' + match + '</ol>';
    return '<ul>' + match + '</ul>';
  });
  html = html.replace(/<\/ul>\s*<ul>/g, '');
  html = html.replace(/<\/ol>\s*<ol>/g, '');

  const lines = html.split('\n');
  const processedLines = lines.map((line) => {
    const trimmedLine = line.trim();
    if (trimmedLine === '') return '';
    if (
      trimmedLine.startsWith('<table>') ||
      trimmedLine.startsWith('</table>') ||
      trimmedLine.startsWith('<pre>') ||
      trimmedLine.startsWith('</pre>')
    )
      return line;
    if (trimmedLine.startsWith('<h') && trimmedLine.endsWith('>')) return line;
    if (
      trimmedLine.startsWith('<ul>') ||
      trimmedLine.startsWith('<ol>') ||
      trimmedLine.startsWith('</ul>') ||
      trimmedLine.startsWith('</ol>') ||
      trimmedLine.startsWith('<li>')
    )
      return line;
    if (!trimmedLine.startsWith('<')) return `<p>${line}</p>`;
    return line;
  });

  return processedLines
    .join('\n')
    .replace(/<p><\/p>/g, '')
    .replace(/\n{3,}/g, '\n\n');
}
