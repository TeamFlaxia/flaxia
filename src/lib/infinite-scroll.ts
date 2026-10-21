export interface InfiniteScrollOptions {
  onLoadMore: () => void;
  canLoadMore: () => boolean;
  rootMargin?: string;
  threshold?: number;
}

export interface InfiniteScrollController {
  sentinel: HTMLElement;
  disconnect: () => void;
  reconnect: () => void;
}

export function createInfiniteScroll(options: InfiniteScrollOptions): InfiniteScrollController {
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'height: 100px; width: 100%; display: flex; align-items: center; justify-content: center;';

  let observer: IntersectionObserver | null = null;

  const connect = () => {
    disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && options.canLoadMore()) {
          options.onLoadMore();
        }
      },
      {
        root: null,
        rootMargin: options.rootMargin ?? '300px',
        threshold: options.threshold ?? 0.1,
      },
    );
    observer.observe(sentinel);
  };

  const disconnect = () => {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  };

  connect();

  return { sentinel, disconnect, reconnect: connect };
}
