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

  const titleRow = document.createElement('div')
  titleRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.4rem; padding: 0 0.25rem;'

  const title = document.createElement('div')
  title.className = 'post-modal-drafts-title'
  title.style.cssText = 'margin: 0; padding: 0;'
  const updateTitle = () => {
    const d = composer.getSavedDrafts()
    title.textContent = t('composer.list_drafts') + (d.length > 0 ? ` (${d.length})` : '')
  }
  updateTitle()
  titleRow.appendChild(title)

  const deleteAllBtn = document.createElement('button')
  deleteAllBtn.textContent = t('composer.draft_delete_all')
  deleteAllBtn.style.cssText = `
    background: none;
    border: none;
    color: var(--danger, #ef4444);
    cursor: pointer;
    font-size: 0.75rem;
    font-family: inherit;
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
    transition: background 0.15s;
  `
  deleteAllBtn.addEventListener('mouseenter', () => { deleteAllBtn.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))' })
  deleteAllBtn.addEventListener('mouseleave', () => { deleteAllBtn.style.background = 'none' })
  deleteAllBtn.addEventListener('click', () => {
    const unreg = registerModal()
    const overlay = document.createElement('div')
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.5);
      display: flex; align-items: center; justify-content: center;
      z-index: 3000;
    `
    const dialog = document.createElement('div')
    dialog.style.cssText = `
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 24px;
      max-width: 400px;
      width: 90%;
    `
    const title = document.createElement('h3')
    title.style.cssText = 'margin: 0 0 8px 0; font-size: 18px; color: var(--text-primary);'
    title.textContent = t('composer.draft_delete_all')

    const message = document.createElement('p')
    message.style.cssText = 'margin: 0 0 24px 0; color: var(--text-muted); font-size: 14px;'
    message.textContent = t('composer.draft_delete_all_confirm')

    const buttonRow = document.createElement('div')
    buttonRow.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end;'

    const cancelBtn = document.createElement('button')
    cancelBtn.style.cssText = 'padding: 8px 16px; background: none; border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary); cursor: pointer; font-family: inherit;'
    cancelBtn.textContent = t('common.cancel')

    const deleteBtn = document.createElement('button')
    deleteBtn.style.cssText = 'padding: 8px 16px; background: var(--danger, #ef4444); border: none; border-radius: 4px; color: #fff; cursor: pointer; font-family: inherit;'
    deleteBtn.textContent = t('common.delete')

    buttonRow.appendChild(cancelBtn)
    buttonRow.appendChild(deleteBtn)
    dialog.appendChild(title)
    dialog.appendChild(message)
    dialog.appendChild(buttonRow)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    const destroy = () => {
      unreg()
      overlay.remove()
    }

    cancelBtn.addEventListener('click', destroy)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) destroy() })

    deleteBtn.addEventListener('click', () => {
      destroy()
      composer.deleteAllDraftsPublic()
      renderItems()
    })
  })
  titleRow.appendChild(deleteAllBtn)

  panel.appendChild(titleRow)

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
