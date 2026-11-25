<script lang="ts">
import type { LegalArticleContent } from '../docs/ssr-content.ts';
import { t } from '../i18n.ts';
import { ALL_PAGES, LEGAL_PAGES, type LegalPageType } from '../legal/pages.ts';
import { navigate } from '../navigation.ts';
import { SEO_ORIGIN } from '../seo-jsonld.ts';

let { type, data }: { type: LegalPageType; data?: LegalArticleContent } = $props();

const title = $derived(data?.title ?? t(LEGAL_PAGES[type].titleKey));
const effectiveDate = $derived(data?.effectiveDate ?? null);
const bodyHtml = $derived(data?.bodyHtml ?? '');

function go(path: string): void {
  void navigate(path);
}
</script>

<svelte:head>
  {#if data}
    <meta name="description" content={data.description} />
    <link rel="canonical" href={data.canonical} />
    <meta property="og:url" content={data.canonical} />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={data.description} />
    <meta property="og:image" content={`${SEO_ORIGIN}/og-default-v2.png`} />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content={title} />
    <meta name="twitter:description" content={data.description} />
    <meta name="twitter:image" content="https://flaxia.app/og-default-v2.png" />
  {/if}
</svelte:head>

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
      {#if !data}
        <div class="legal-error">{t('legal.load_failed')}</div>
      {:else}
        <h1 class="legal-title fx-display">{title}</h1>
        {#if effectiveDate}
          <div class="legal-effective-date">{t('legal.effective_date', { date: effectiveDate })}</div>
        {/if}
        <!-- The pure markdown transform escapes all input before emitting tags. -->
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
