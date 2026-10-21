export function setMetaTag(selector: string, attr: string, value: string): void {
  const el = document.querySelector(selector);
  if (el) el.setAttribute(attr, value);
}

export function updateMetaTags(options: { title: string; description: string; url: string; image?: string }): void {
  document.title = options.title;

  setMetaTag('meta[name="description"]', 'content', options.description);
  setMetaTag('meta[property="og:title"]', 'content', options.title);
  setMetaTag('meta[property="og:description"]', 'content', options.description);
  setMetaTag('meta[property="og:url"]', 'content', options.url);
  setMetaTag('meta[property="og:image"]', 'content', options.image || 'https://flaxia.app/og-default-v2.png');
  setMetaTag('meta[property="og:site_name"]', 'content', 'Flaxia');
  setMetaTag('meta[name="twitter:card"]', 'content', 'summary_large_image');
  setMetaTag('meta[name="twitter:site"]', 'content', '@flaxia_app');
  setMetaTag('meta[name="twitter:title"]', 'content', options.title);
  setMetaTag('meta[name="twitter:description"]', 'content', options.description);
  setMetaTag('meta[name="twitter:image"]', 'content', options.image || 'https://flaxia.app/og-default-v2.png');

  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) {
    canonical.setAttribute('href', options.url);
  }
}
