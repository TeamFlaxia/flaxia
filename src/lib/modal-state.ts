let modalCount = 0;
let scrollY = 0;

export function isModalOpen(): boolean {
  return modalCount > 0;
}

function lockScroll(): void {
  document.body.style.overflow = 'hidden';
  document.body.style.position = 'fixed';
  document.body.style.top = `-${scrollY}px`;
  document.body.style.width = '100%';
}

function unlockScroll(): void {
  document.body.style.overflow = '';
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.width = '';
  window.scrollTo(0, scrollY);
}

function dispatchChange(): void {
  window.dispatchEvent(new CustomEvent('modalchange', { detail: { open: modalCount > 0 } }));
}

export function registerModal(): () => void {
  const wasClosed = modalCount === 0;
  if (wasClosed) {
    scrollY = window.scrollY;
  }
  modalCount++;
  if (wasClosed) {
    lockScroll();
  }
  dispatchChange();
  return () => {
    modalCount = Math.max(0, modalCount - 1);
    if (modalCount === 0) {
      unlockScroll();
    }
    dispatchChange();
  };
}
