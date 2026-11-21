<script lang="ts">
import { type DocEntry, FOOTER_PAGES, fetchDocsManifest, preferredFile, preferredTitle } from '../docs/manifest.ts';
import { getLocale, t } from '../i18n.ts';
import { navigate } from '../navigation.ts';

let { slug }: { slug?: string } = $props();

let title = $state('');
let articleTitle = $state(false);
let docs = $state<DocEntry[]>([]);
let bodyHtml = $state('');
let error = $state('');

function go(path: string): void {
  void navigate(path);
}

$effect(() => {
  const currentSlug = slug;
  let cancelled = false;
  title = t('docs.title');
  articleTitle = false;
  docs = [];
  bodyHtml = '';
  error = '';

  void (async () => {
    try {
      const manifest = await fetchDocsManifest();
      if (cancelled) return;
      if (!currentSlug) {
        docs = manifest.docs;
        return;
      }
      const doc = manifest.docs.find((entry) => entry.slug === currentSlug);
      if (!doc) {
        error = t('docs.not_found');
        return;
      }
      const file = preferredFile(doc, getLocale());
      if (!file) {
        error = t('docs.not_found');
        return;
      }
      title = preferredTitle(doc, getLocale());
      articleTitle = true;

      const [{ default: MarkdownIt }, DOMPurifyModule, response] = await Promise.all([
        import('markdown-it'),
        import('dompurify'),
        fetch(`/docs/${encodeURIComponent(file)}`),
      ]);
      if (cancelled) return;
      if (!response.ok) {
        error = t('docs.load_failed');
        return;
      }
      const md = new MarkdownIt({ html: false, xhtmlOut: false, breaks: true, linkify: false, typographer: true });
      const rendered = md.render(await response.text());
      if (cancelled) return;
      bodyHtml = DOMPurifyModule.default.sanitize(rendered, {
        ALLOWED_TAGS: [
          'h1',
          'h2',
          'h3',
          'h4',
          'p',
          'br',
          'strong',
          'em',
          'code',
          'pre',
          'blockquote',
          'hr',
          'ul',
          'ol',
          'li',
          'a',
          'span',
          'table',
          'thead',
          'tbody',
          'tr',
          'td',
          'th',
          's',
          'del',
          'img',
        ],
        ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'src', 'alt', 'title', 'colspan', 'rowspan'],
        ALLOW_DATA_ATTR: false,
      });
    } catch {
      if (!cancelled) error = t('docs.load_failed');
    }
  })();

  return () => {
    cancelled = true;
  };
});
</script>

<div class="legal-page docs-page">
  <div class="legal-content-wrapper">
    <header class="legal-header" style="display: flex; align-items: center; gap: 0.5rem;">
      <button
        type="button"
        style="background: none; border: none; font-size: 1.25rem; cursor: pointer; color: var(--text-primary); padding: 0.25rem 0.5rem; border-radius: 4px; transition: background 0.2s;"
        onclick={() => window.history.back()}
      >
        ←
      </button>
      <a href="/" class="legal-wordmark fx-display" onclick={(e) => { e.preventDefault(); go('/'); }}>
        {t('legal.brand')}
      </a>
    </header>

    <article class="legal-content">
      <h1 class="legal-title fx-display" class:docs-title={!articleTitle} class:docs-article-title={articleTitle}>
        {title}
      </h1>

      {#if error}
        <div class="legal-error">{error}</div>
      {:else if !slug}
        <div class="docs-list">
          {#each docs as doc (doc.slug)}
            <a
              href={`/docs/${encodeURIComponent(doc.slug)}`}
              class="docs-list-item"
              data-docs-slug={doc.slug}
              onclick={(e) => { e.preventDefault(); go(`/docs/${encodeURIComponent(doc.slug)}`); }}
            >
              <div class="docs-list-title fx-display">{preferredTitle(doc, getLocale())}</div>
              <span class="docs-list-arrow">→</span>
            </a>
          {/each}
        </div>
      {:else}
        <!-- Rendered markdown is sanitized with DOMPurify above. -->
        <div class="legal-body docs-article-body">{@html bodyHtml}</div>
      {/if}
    </article>

    <footer class="legal-footer">
      <div class="legal-footer-links">
        {#each FOOTER_PAGES as page, i (page.path)}
          {#if i > 0}
            <span class="legal-footer-separator">{t('legal.footer_separator')}</span>
          {/if}
          <a href={page.path} class="legal-footer-link" onclick={(e) => { e.preventDefault(); go(page.path); }}>
            {t(page.key)}
          </a>
        {/each}
      </div>
    </footer>
  </div>
</div>
