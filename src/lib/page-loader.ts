// Full-page loading overlay (split out of main.ts).
//
// Shown while navigateTo swaps views; if loading stalls for 15s it turns
// into a failure panel with a reload button instead of hanging forever.
let pageLoader: HTMLDivElement | null = null;
let pageLoaderTimer: ReturnType<typeof setTimeout> | null = null;

const LOADER_HTML =
  '<div class="page-loader-content"><div class="page-loader-spinner"></div><div>Loading...</div></div>';
const FAILURE_HTML =
  '<div style="font-size:2rem;margin-bottom:1rem;">⚠</div><div>Failed to load page</div><button class="page-loader-reload-btn" style="margin-top:1rem;padding:0.6rem 1.5rem;border:1px solid var(--border);border-radius:8px;background:var(--accent);color:#000;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;transition:background .2s">Reload</button>';

export function showPageLoader(): void {
  if (!pageLoader) {
    pageLoader = document.createElement('div');
    pageLoader.className = 'page-loader';
    pageLoader.id = 'page-loader';
    pageLoader.innerHTML = LOADER_HTML;
    document.body.appendChild(pageLoader);
  } else {
    const content = pageLoader.querySelector('.page-loader-content')!;
    content.innerHTML = '<div class="page-loader-spinner"></div><div>Loading...</div>';
    content.className = 'page-loader-content';
  }
  pageLoader!.classList.add('active');

  if (pageLoaderTimer) clearTimeout(pageLoaderTimer);
  pageLoaderTimer = setTimeout(() => {
    if (!pageLoader || !pageLoader.classList.contains('active')) return;
    wireFailurePanel();
  }, 15000);
}

export function hidePageLoader(): void {
  if (pageLoader) pageLoader.classList.remove('active');
  if (pageLoaderTimer) {
    clearTimeout(pageLoaderTimer);
    pageLoaderTimer = null;
  }
}

/** Wire the failure panel (message + reload button) into the overlay. */
function wireFailurePanel(): void {
  if (!pageLoader) return;
  const content = pageLoader.querySelector('.page-loader-content')!;
  content.innerHTML = FAILURE_HTML;
  content.className = 'page-loader-content';
  const btn = content.querySelector('.page-loader-reload-btn') as HTMLButtonElement;
  btn.onclick = () => {
    window.location.reload();
  };
  btn.onmouseenter = () => {
    btn.style.background = 'var(--accent-dark)';
  };
  btn.onmouseleave = () => {
    btn.style.background = 'var(--accent)';
  };
}

/**
 * Show the failure panel on navigation errors. When the overlay is not
 * visible there is nothing to write into, so reload instead.
 */
export function showPageLoaderFailure(): void {
  if (pageLoader && pageLoader.classList.contains('active')) {
    wireFailurePanel();
  } else {
    window.location.reload();
  }
}
