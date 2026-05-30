import { t, getLocale } from '../lib/i18n.js'

interface LegalPageProps {
  type: 'terms' | 'privacy' | 'about' | 'whitepaper'
}

const LEGAL_PAGES: Record<LegalPageProps['type'], { fileName: string; titleKey: string; footerKey: string; path: string }> = {
  terms: { fileName: 'terms', titleKey: 'legal.terms_title', footerKey: 'legal.footer_terms', path: '/terms' },
  privacy: { fileName: 'privacy', titleKey: 'legal.privacy_title', footerKey: 'legal.footer_privacy', path: '/privacy' },
  about: { fileName: 'about', titleKey: 'legal.about_title', footerKey: 'legal.footer_about', path: '/about' },
  whitepaper: { fileName: 'whitepaper', titleKey: 'legal.whitepaper_title', footerKey: 'legal.footer_whitepaper', path: '/whitepaper' },
}

const ALL_PAGES = Object.values(LEGAL_PAGES) as { fileName: string; titleKey: string; footerKey: string; path: string }[]

function fetchMarkdown(fileName: string, locale: string): Promise<string> {
  return fetch(`/legal/${fileName}.${locale}.md`).then(r => {
    if (!r.ok) throw new Error('Failed to load')
    return r.text()
  })
}

function markdownToHtml(markdown: string): string {
  let html = markdown

  html = html.replace(/&/g, '&amp;')
  html = html.replace(/</g, '&lt;')
  html = html.replace(/>/g, '&gt;')

  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')

  html = html.replace(/\|(.+)\|[\r\n]+\|[-\s\|]+\|[\r\n]+((?:\|.+[\r\n?]+)+)/g, (_match: string, header: string, body: string) => {
    const headerCells = header.split('|').map((c: string) => c.trim()).filter((c: string) => c)
    const rows = body.trim().split('\n')
    return `<table class="legal-table"><thead><tr>${headerCells.map((c: string) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
      rows.map((row: string) => `<tr>${row.split('|').map((c: string) => c.trim()).filter((c: string) => c).map((c: string) => `<td>${c}</td>`).join('')}</tr>`).join('')
    }</tbody></table>`
  })

  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')

  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')

  html = html.replace(/^\s*\d+\.\s+(.+)$/gm, '<li>$1</li>')
  html = html.replace(/^\s*-\s+(.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => {
    if (match.includes('1.') || match.includes('2.') || match.includes('3.')) return '<ol>' + match + '</ol>'
    return '<ul>' + match + '</ul>'
  })
  html = html.replace(/<\/ul>\s*<ul>/g, '')
  html = html.replace(/<\/ol>\s*<ol>/g, '')

  const lines = html.split('\n')
  const processedLines = lines.map(line => {
    const trimmedLine = line.trim()
    if (trimmedLine === '') return ''
    if (trimmedLine.startsWith('<table>') || trimmedLine.startsWith('</table>') || trimmedLine.startsWith('<pre>') || trimmedLine.startsWith('</pre>')) return line
    if (trimmedLine.startsWith('<h') && trimmedLine.endsWith('>')) return line
    if (trimmedLine.startsWith('<ul>') || trimmedLine.startsWith('<ol>') || trimmedLine.startsWith('</ul>') || trimmedLine.startsWith('</ol>') || trimmedLine.startsWith('<li>')) return line
    if (!trimmedLine.startsWith('<')) return `<p>${line}</p>`
    return line
  })

  return processedLines.join('\n').replace(/<p><\/p>/g, '').replace(/\n{3,}/g, '\n\n')
}

export function createLegalPage({ type }: LegalPageProps) {
  const container = document.createElement('div')
  container.className = 'legal-page'

  const contentWrapper = document.createElement('div')
  contentWrapper.className = 'legal-content-wrapper'

  // Header
  const header = document.createElement('header')
  header.className = 'legal-header'
  header.style.cssText = 'display: flex; align-items: center; gap: 0.5rem;'

  const backBtn = document.createElement('button')
  backBtn.textContent = '←'
  backBtn.style.cssText = 'background: none; border: none; font-size: 1.25rem; cursor: pointer; color: var(--text-primary); padding: 0.25rem 0.5rem; border-radius: 4px; transition: background 0.2s;'
  backBtn.addEventListener('mouseenter', () => { backBtn.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))' })
  backBtn.addEventListener('mouseleave', () => { backBtn.style.background = 'none' })
  backBtn.addEventListener('click', () => window.history.back())

  const wordmark = document.createElement('a')
  wordmark.href = '/'
  wordmark.className = 'legal-wordmark'
  wordmark.textContent = t('legal.brand')
  wordmark.addEventListener('click', (e) => {
    e.preventDefault()
    window.history.pushState({}, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

  header.appendChild(backBtn)
  header.appendChild(wordmark)

  const content = document.createElement('article')
  content.className = 'legal-content'

  const loadContent = async () => {
    const locale = getLocale()
    const page = LEGAL_PAGES[type]

    let markdown: string
    try {
      markdown = await fetchMarkdown(page.fileName, locale)
    } catch {
      markdown = await fetchMarkdown(page.fileName, 'en')
    }

    try {
      const effectiveDateMatch = markdown.match(/^Effective Date:\s*(.+)$/m)
      const effectiveDate = effectiveDateMatch ? effectiveDateMatch[1] : null
      const contentMarkdown = markdown.replace(/^Effective Date:.+\n?/m, '').trim()

      const titleEl = document.createElement('h1')
      titleEl.className = 'legal-title'
      titleEl.textContent = t(page.titleKey)
      content.appendChild(titleEl)

      if (effectiveDate) {
        const dateEl = document.createElement('div')
        dateEl.className = 'legal-effective-date'
        dateEl.textContent = t('legal.effective_date', { date: effectiveDate })
        content.appendChild(dateEl)
      }

      const bodyEl = document.createElement('div')
      bodyEl.className = 'legal-body'
      bodyEl.innerHTML = markdownToHtml(contentMarkdown)
      content.appendChild(bodyEl)
    } catch {
      const errorEl = document.createElement('div')
      errorEl.className = 'legal-error'
      errorEl.textContent = t('legal.load_failed')
      content.appendChild(errorEl)
    }
  }

  // Footer
  const footer = document.createElement('footer')
  footer.className = 'legal-footer'
  const footerLinks = document.createElement('div')
  footerLinks.className = 'legal-footer-links'

  ALL_PAGES.forEach((p, i) => {
    if (i > 0) {
      const sep = document.createElement('span')
      sep.className = 'legal-footer-separator'
      sep.textContent = t('legal.footer_separator')
      footerLinks.appendChild(sep)
    }
    const link = document.createElement('a')
    link.href = p.path
    link.textContent = t(p.footerKey)
    link.className = 'legal-footer-link'
    link.addEventListener('click', (e) => {
      e.preventDefault()
      window.history.pushState({}, '', p.path)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    footerLinks.appendChild(link)
  })

  footer.appendChild(footerLinks)

  contentWrapper.appendChild(header)
  contentWrapper.appendChild(content)
  contentWrapper.appendChild(footer)
  container.appendChild(contentWrapper)

  loadContent()

  return {
    getElement: () => container,
    destroy: () => {}
  }
}
