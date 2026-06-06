interface LegalContentProps {
  type: 'terms' | 'privacy' | 'about' | 'whitepaper';
  content: string;
  title: string;
  effectiveDate?: string;
}

const LEGAL_PAGES = [
  { path: '/terms', label: 'legal.footer_terms' },
  { path: '/privacy', label: 'legal.footer_privacy' },
  { path: '/about', label: 'legal.footer_about' },
  { path: '/whitepaper', label: 'legal.footer_whitepaper' },
];

function markdownToHtml(markdown: string): string {
  let html = markdown;
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/^\s*-\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  html = html.replace(/<\/ul>\s*<ul>/g, '');

  const lines = html.split('\n');
  const processed = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('<h') || t.startsWith('<pre') || t.startsWith('</pre') || t.startsWith('<ul') || t.startsWith('</ul') || t.startsWith('<li')) return line;
    if (!t.startsWith('<')) return `<p>${line}</p>`;
    return line;
  });

  return processed.join('\n').replace(/<p><\/p>/g, '').replace(/\n{3,}/g, '\n\n');
}

export function LegalContent({ type, content, title, effectiveDate }: LegalContentProps) {
  const htmlContent = markdownToHtml(content);

  return (
    <div className="legal-page">
      <div className="legal-content-wrapper">
        <header className="legal-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <a href="/" className="legal-wordmark">Flaxia</a>
        </header>
        <article className="legal-content">
          <h1 className="legal-title">{title}</h1>
          {effectiveDate && (
            <div className="legal-effective-date">Effective: {effectiveDate}</div>
          )}
          <div className="legal-body" dangerouslySetInnerHTML={{ __html: htmlContent }} />
        </article>
        <footer className="legal-footer">
          <div className="legal-footer-links">
            {LEGAL_PAGES.map((page, i) => (
              <span key={page.path}>
                {i > 0 && <span className="legal-footer-separator"> · </span>}
                <a href={page.path} className="legal-footer-link">{page.label}</a>
              </span>
            ))}
          </div>
        </footer>
      </div>
    </div>
  );
}
