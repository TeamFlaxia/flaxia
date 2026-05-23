let modalCount = 0

export function isModalOpen(): boolean {
  return modalCount > 0
}

export function registerModal(): () => void {
  modalCount++
  return () => {
    modalCount = Math.max(0, modalCount - 1)
  }
}
