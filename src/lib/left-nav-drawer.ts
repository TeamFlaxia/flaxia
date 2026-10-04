// Mobile left-nav drawer behavior (split out of main.ts).
//
// Overlay, open/close, Escape/resize/modal handling, and the left-edge swipe
// strip. All state is module-local; callers only need the three exported
// functions below.
let leftNavOverlay: HTMLElement | null = null;
let leftNavWasOpen = false;
let leftNavSwipeCatch: HTMLElement | null = null;
let isModalOpen = false;

let currentResizeHandler: (() => void) | null = null;
let currentKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
let currentModalChangeHandler: ((e: Event) => void) | null = null;
let currentOpenLeftNavHandler: (() => void) | null = null;
let currentEdgeTouchStartHandler: ((e: TouchEvent) => void) | null = null;
let currentEdgeTouchMoveHandler: ((e: TouchEvent) => void) | null = null;
let currentEdgeTouchEndHandler: (() => void) | null = null;

const createLeftNavOverlay = (): HTMLElement => {
  const overlay = document.createElement('div');
  overlay.className = 'left-nav-overlay';
  overlay.addEventListener('click', () => {
    closeLeftNav();
  });
  document.body.appendChild(overlay);
  return overlay;
};

const updateSwipeCatchVisibility = (): void => {
  if (!leftNavSwipeCatch) return;
  const shouldShow = window.innerWidth <= 768 && !leftNavWasOpen && !isModalOpen;
  leftNavSwipeCatch.style.display = shouldShow ? 'block' : 'none';
};

export const openLeftNav = (leftNavElement: HTMLElement): void => {
  if (window.innerWidth > 768) return;

  leftNavWasOpen = true;
  leftNavElement.classList.add('left-nav--open');

  if (!leftNavOverlay) {
    leftNavOverlay = createLeftNavOverlay();
  }
  leftNavOverlay.classList.add('left-nav-overlay--visible');

  // Prevent body scroll
  document.body.style.overflow = 'hidden';

  updateSwipeCatchVisibility();
};

export const closeLeftNav = (): void => {
  if (!leftNavWasOpen) return;
  leftNavWasOpen = false;

  const leftNavElement = document.querySelector('.left-nav') as HTMLElement;
  if (leftNavElement) {
    leftNavElement.classList.remove('left-nav--open');
  }

  if (leftNavOverlay) {
    leftNavOverlay.classList.remove('left-nav-overlay--visible');
  }

  // Restore body scroll
  document.body.style.overflow = '';

  updateSwipeCatchVisibility();
};

/**
 * Remove the overlay element entirely (used when switching to fullscreen
 * auth pages that must not leave a stale overlay behind).
 */
export function removeLeftNavOverlay(): void {
  if (leftNavOverlay) {
    leftNavOverlay.remove();
    leftNavOverlay = null;
  }
}

export const setupMobileLeftNav = (leftNavElement: HTMLElement): void => {
  // Clean up existing event listeners
  if (currentResizeHandler) {
    window.removeEventListener('resize', currentResizeHandler);
    currentResizeHandler = null;
  }
  if (currentKeydownHandler) {
    document.removeEventListener('keydown', currentKeydownHandler);
    currentKeydownHandler = null;
  }
  if (currentModalChangeHandler) {
    window.removeEventListener('modalchange', currentModalChangeHandler);
    currentModalChangeHandler = null;
  }
  if (currentOpenLeftNavHandler) {
    document.removeEventListener('openLeftNav', currentOpenLeftNavHandler);
    currentOpenLeftNavHandler = null;
  }
  if (currentEdgeTouchStartHandler) {
    if (leftNavSwipeCatch) {
      leftNavSwipeCatch.removeEventListener('touchstart', currentEdgeTouchStartHandler);
    }
    currentEdgeTouchStartHandler = null;
  }
  if (currentEdgeTouchMoveHandler) {
    if (leftNavSwipeCatch) {
      leftNavSwipeCatch.removeEventListener('touchmove', currentEdgeTouchMoveHandler);
    }
    currentEdgeTouchMoveHandler = null;
  }
  if (currentEdgeTouchEndHandler) {
    if (leftNavSwipeCatch) {
      leftNavSwipeCatch.removeEventListener('touchend', currentEdgeTouchEndHandler);
      leftNavSwipeCatch.removeEventListener('touchcancel', currentEdgeTouchEndHandler);
    }
    currentEdgeTouchEndHandler = null;
  }
  if (leftNavSwipeCatch) {
    leftNavSwipeCatch.remove();
    leftNavSwipeCatch = null;
  }

  // Listen for openLeftNav events from timeline
  currentOpenLeftNavHandler = () => {
    openLeftNav(leftNavElement);
  };
  document.addEventListener('openLeftNav', currentOpenLeftNavHandler);

  // Handle escape key to close
  currentKeydownHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && window.innerWidth <= 768) {
      closeLeftNav();
    }
  };
  document.addEventListener('keydown', currentKeydownHandler);

  // Handle window resize
  currentResizeHandler = () => {
    if (window.innerWidth > 768) {
      closeLeftNav();
    }
    updateSwipeCatchVisibility();
  };
  window.addEventListener('resize', currentResizeHandler);

  // Close mobile nav when modal opens
  currentModalChangeHandler = (e: Event) => {
    isModalOpen = (e as CustomEvent<{ open: boolean }>).detail.open;
    if (isModalOpen) {
      closeLeftNav();
    }
    updateSwipeCatchVisibility();
  };
  window.addEventListener('modalchange', currentModalChangeHandler);

  // Edge swipe detection to open the mobile left nav (swipe right from the left edge).
  // The touch handlers live on a fixed left-edge strip instead of the document, because
  // game iframes (e.g. arcade) swallow touch events before they reach the parent document.
  if (!leftNavSwipeCatch) {
    leftNavSwipeCatch = document.createElement('div');
    leftNavSwipeCatch.className = 'left-nav-swipe-catch';
    document.body.appendChild(leftNavSwipeCatch);
  }

  let swipeStartX = 0;
  let swipeStartY = 0;
  let isEdgeSwipeTracking = false;

  currentEdgeTouchStartHandler = (e: TouchEvent) => {
    if (window.innerWidth > 768 || leftNavWasOpen) return;
    const touch = e.touches[0];
    if (!touch) return;
    isEdgeSwipeTracking = true;
    swipeStartX = touch.clientX;
    swipeStartY = touch.clientY;
  };

  currentEdgeTouchMoveHandler = (e: TouchEvent) => {
    if (!isEdgeSwipeTracking) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - swipeStartX;
    const dy = touch.clientY - swipeStartY;
    if (dx > 60 && Math.abs(dx) > Math.abs(dy)) {
      e.preventDefault();
      isEdgeSwipeTracking = false;
      openLeftNav(leftNavElement);
    }
  };

  currentEdgeTouchEndHandler = () => {
    isEdgeSwipeTracking = false;
  };

  leftNavSwipeCatch.addEventListener('touchstart', currentEdgeTouchStartHandler, { passive: true });
  leftNavSwipeCatch.addEventListener('touchmove', currentEdgeTouchMoveHandler, { passive: false });
  leftNavSwipeCatch.addEventListener('touchend', currentEdgeTouchEndHandler);
  leftNavSwipeCatch.addEventListener('touchcancel', currentEdgeTouchEndHandler);

  updateSwipeCatchVisibility();
};
