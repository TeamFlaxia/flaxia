let modalCount = 0

export function isModalOpen(): boolean {
  return modalCount > 0
}

function dispatchChange(): void {
  window.dispatchEvent(new CustomEvent('modalchange', { detail: { open: modalCount > 0 } }))
}

export function registerModal(): () => void {
  modalCount++
  dispatchChange()
  return () => {
    modalCount = Math.max(0, modalCount - 1)
    dispatchChange()
  }
}
