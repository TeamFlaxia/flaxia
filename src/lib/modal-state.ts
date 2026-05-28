let modalCount = 0

export function isModalOpen(): boolean {
  return modalCount > 0
}

function preventScroll(e: Event): void {
  e.preventDefault()
}

function preventScrollKey(e: KeyboardEvent): void {
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
    e.preventDefault()
  }
}

function lockScroll(): void {
  window.addEventListener('wheel', preventScroll, { passive: false })
  window.addEventListener('touchmove', preventScroll, { passive: false })
  window.addEventListener('keydown', preventScrollKey)
}

function unlockScroll(): void {
  window.removeEventListener('wheel', preventScroll)
  window.removeEventListener('touchmove', preventScroll)
  window.removeEventListener('keydown', preventScrollKey)
}

function dispatchChange(): void {
  window.dispatchEvent(new CustomEvent('modalchange', { detail: { open: modalCount > 0 } }))
}

export function registerModal(): () => void {
  const wasClosed = modalCount === 0
  modalCount++
  if (wasClosed) {
    lockScroll()
  }
  dispatchChange()
  return () => {
    modalCount = Math.max(0, modalCount - 1)
    if (modalCount === 0) {
      unlockScroll()
    }
    dispatchChange()
  }
}
