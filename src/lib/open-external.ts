function isTauri(): boolean {
  try {
    return typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window)
  } catch {
    return false
  }
}

export function initExternalLinkHandler(): void {
  if (!isTauri()) return

  document.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest('a')
    if (!link || !link.href) return
    if (!link.href.startsWith('http://') && !link.href.startsWith('https://')) return
    if (link.target !== '_blank' && link.href.startsWith(window.location.origin)) return

    e.preventDefault()
    window.location.href = link.href
  })
}
