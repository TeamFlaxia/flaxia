<script lang="ts">
import { getLocale, t } from '../i18n.ts';
import { markdownToHtml } from '../legal/markdown.ts';
import { ALL_PAGES, fetchLegalMarkdown, LEGAL_PAGES, type LegalPageType } from '../legal/pages.ts';

let { type }: { type: LegalPageType } = $props();

let title = $state('');
let effectiveDate = $state<string | null>(null);
let bodyHtml = $state('');
let error = $state(false);

function go(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

$effect(() => {
  const page = LEGAL_PAGES[type];
  let cancelled = false;
  title = t(page.titleKey);
  error = false;
  bodyHtml = '';
  effectiveDate = null;

  void (async () => {
    let markdown: string;
    try {
      markdown = await fetchLegalMarkdown(page.fileName, getLocale());
    } catch {
      try {
        markdown = await fetchLegalMarkdown(page.fileName, 'en');
      } catch {
        if (!cancelled) error = true;
        return;
      }
    }
    if (cancelled) return;
    const match = markdown.match(/^Effective Date:\s*(.+)$/m);
    effectiveDate = match?.[1] ?? null;
    bodyHtml = markdownToHtml(markdown.replace(/^Effective Date:.+\n?/m, '').trim());
  })();

  return () => {
    cancelled = true;
  };
});
</script>

<div class="legal-page">
  <div class="legal-content-wrapper">
    <header class="legal-header" style="display: flex; align-items: center; gap: 0.5rem;">
      <button
        type="button"
        style="background: none; border: none; font-size: 1.25rem; cursor: pointer; color: var(--text-primary); padding: 0.25rem 0.5rem; border-radius: 4px; transition: background 0.2s;"
        onclick={() => window.history.back()}
      >
        ←
      </button>
      <a
        href="/"
        class="legal-wordmark fx-display"
        onclick={(e) => { e.preventDefault(); go('/'); }}
      >
        {t('legal.brand')}
      </a>
    </header>

    <article class="legal-content">
      {#if error}
        <div class="legal-error">{t('legal.load_failed')}</div>
      {:else}
        <h1 class="legal-title fx-display">{title}</h1>
        {#if effectiveDate}
          <div class="legal-effective-date">{t('legal.effective_date', { date: effectiveDate })}</div>
        {/if}
        <!-- The markdown transform escapes all input before emitting tags. -->
        <div class="legal-body">{@html bodyHtml}</div>
      {/if}
    </article>

    <footer class="legal-footer">
      <div class="legal-footer-links">
        {#each ALL_PAGES as page, i (page.path)}
          {#if i > 0}
            <span class="legal-footer-separator">{t('legal.footer_separator')}</span>
          {/if}
          <a
            href={page.path}
            class="legal-footer-link"
            onclick={(e) => { e.preventDefault(); go(page.path); }}
          >
            {t(page.footerKey)}
          </a>
        {/each}
      </div>
    </footer>
  </div>
</div>
