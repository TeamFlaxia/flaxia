// Preconnect hints for the sandbox/emulator CDNs. The Svelte page owns when
// they are added, but the DOM bookkeeping lives here so it can be cleaned up.
export function addPreconnects(hrefs: readonly string[]): () => void {
  const links: HTMLLinkElement[] = [];
  for (const href of hrefs) {
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = href;
    document.head.appendChild(link);
    links.push(link);
  }
  return () => {
    for (const link of links) link.remove();
  };
}
