import { createPostComposer, PostComposer } from '../components/PostComposer.js'
import { registerModal } from './modal-state.js'
import { t } from './i18n.js'

export function openPostModal(opts: {
  currentUser: { username: string; id?: string; display_name?: string; avatar_key?: string } | null | undefined
  onPostCreated: (post: any) => void
}): void {
  const unregister = registerModal()
  const overlay = document.createElement('div')
  overlay.className = 'post-modal-overlay'

  const dialog = document.createElement('div')
  dialog.className = 'post-modal-dialog'

  let refreshDrafts: () => void

  const modalComposer = createPostComposer({
    onPostCreated: (post) => {
      opts.onPostCreated(post)
      unregister()
      destroy()
    },
    currentUser: opts.currentUser,
    onDraftSaved: () => refreshDrafts?.()
  })
  dialog.appendChild(modalComposer.getElement())

  const panelResult = createDraftsPanel(modalComposer)
  dialog.appendChild(panelResult.panel)
  refreshDrafts = panelResult.refresh

  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  modalComposer.focus()

  function destroy() {
    if (overlay.parentNode) overlay.remove()
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      unregister()
      destroy()
    }
  })
}

function createDraftsPanel(composer: PostComposer): { panel: HTMLElement; refresh: () => void } {
  const panel = document.createElement('div')
  panel.className = 'post-modal-drafts'

  const title = document.createElement('div')
  title.className = 'post-modal-drafts-title'
  const updateTitle = () => {
    const d = composer.getSavedDrafts()
    title.textContent = t('composer.list_drafts') + (d.length > 0 ? ` (${d.length})` : '')
  }
  updateTitle()
  panel.appendChild(title)

  const renderItems = () => {
    const existing = panel.querySelector('.post-modal-drafts-items')
    if (existing) existing.remove()

    const emptyEl = panel.querySelector('.post-modal-drafts-empty')
    if (emptyEl) emptyEl.remove()

    const items = composer.getSavedDrafts()
    if (items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'post-modal-drafts-empty'
      empty.style.cssText = 'padding: 0.5rem; color: var(--text-muted); font-size: 0.8rem; text-align: center;'
      empty.textContent = t('composer.no_drafts')
      panel.appendChild(empty)
      updateTitle()
      return
    }
    updateTitle()

    const list = document.createElement('div')
    list.className = 'post-modal-drafts-items'

    for (const draft of items) {
      const item = document.createElement('div')
      item.className = 'post-modal-draft-item'

      const text = document.createElement('div')
      text.className = 'post-modal-draft-text'
      text.textContent = draft.text
      text.addEventListener('click', () => {
        composer.setText(draft.text)
        composer.focus()
      })

      const meta = document.createElement('div')
      meta.className = 'post-modal-draft-meta'

      const diff = Date.now() - draft.savedAt
      const minutes = Math.floor(diff / 60000)
      const hours = Math.floor(minutes / 60)
      const days = Math.floor(hours / 24)
      const time = document.createElement('span')
      time.className = 'post-modal-draft-time'
      time.textContent = minutes < 1 ? t('time.just_now') : days > 0 ? `${days}d` : hours > 0 ? `${hours}h` : `${minutes}m`

      const delBtn = document.createElement('button')
      delBtn.className = 'post-modal-draft-del'
      delBtn.textContent = '✕'
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        composer.deleteDraft(draft.id)
        renderItems()
      })

      meta.appendChild(time)
      meta.appendChild(delBtn)
      item.appendChild(text)
      item.appendChild(meta)
      list.appendChild(item)
    }

    panel.appendChild(list)
  }

  renderItems()
  return { panel, refresh: renderItems }
}
