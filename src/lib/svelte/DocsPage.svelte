<script lang="ts">
import { FOOTER_PAGES } from '../docs/manifest.ts';
import type { DocsPageContent } from '../docs/ssr-content.ts';
import { t } from '../i18n.ts';
import { navigate } from '../navigation.ts';
import { SEO_ORIGIN } from '../seo-jsonld.ts';

let { data }: { data?: DocsPageContent } = $props();

const isArticle = $derived(data?.kind === 'article');
const title = $derived(data?.title ?? t('docs.title'));
const description = $derived(data?.description ?? '');
const canonical = $derived(data?.canonical ?? '');

function go(path: string): void {
  void navigate(path);
}
</script>

<svelte:head>
  {#if data}
    <meta name="description" content={description} />
    <link rel="canonical" href={canonical} />
    <meta property="og:url" content={canonical} />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:image" content={`${SEO_ORIGIN}/og-default-v2.png`} />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content={title} />
    <meta name="twitter:description" content={description} />
    <meta name="twitter:image" content="https://flaxia.app/og-default-v2.png" />
  {/if}
</svelte:head>

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
      <h1 class="legal-title fx-display" class:docs-title={!isArticle} class:docs-article-title={isArticle}>
        {title}
      </h1>

      {#if !data}
        <div class="legal-error">{t('docs.load_failed')}</div>
      {:else if data.kind === 'index'}
        <div class="docs-list">
          {#each data.docs as doc (doc.slug)}
            <a
              href={`/docs/${encodeURIComponent(doc.slug)}`}
              class="docs-list-item"
              data-docs-slug={doc.slug}
              onclick={(e) => { e.preventDefault(); go(`/docs/${encodeURIComponent(doc.slug)}`); }}
            >
              <div class="docs-list-title fx-display">{doc.title}</div>
              <span class="docs-list-arrow">→</span>
            </a>
          {/each}
        </div>
      {:else}
        <!-- markdown-it rendered this with raw HTML disabled; safe for {@html} on both server and client. -->
        <div class="legal-body docs-article-body">{@html data.bodyHtml}</div>
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
