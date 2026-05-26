import { t } from '../lib/i18n.js'

interface SearchPageProps {
  query: string
  type?: 'posts' | 'users' | 'arcade'
  currentUser: { username: string } | null
  sandboxOrigin: string
}

type SuggestionItem = { type: 'tag'; label: string; count: number } | { type: 'user'; label: string; display: string; avatar: string }

export function createSearchPage({ query, type = 'posts', currentUser, sandboxOrigin }: SearchPageProps) {
  const container = document.createElement('div')
  container.className = 'search-page'

  const header = document.createElement('div')
  header.className = 'search-page-header'
  header.style.cssText = `
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--bg-primary);
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  `

  const backBtn = document.createElement('button')
  backBtn.textContent = '←'
  backBtn.style.cssText = `
    background: none;
    border: none;
    font-size: 1.25rem;
    cursor: pointer;
    color: var(--text-primary);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    transition: background 0.2s;
    flex-shrink: 0;
  `
  backBtn.addEventListener('mouseenter', () => { backBtn.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))' })
  backBtn.addEventListener('mouseleave', () => { backBtn.style.background = 'none' })
  backBtn.addEventListener('click', () => {
    window.history.pushState({}, '', '/explore')
    window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'explore' } }))
  })

  const searchBox = document.createElement('div')
  searchBox.className = 'search-box'
  searchBox.style.cssText = 'position: relative; flex: 1;'

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'search-input'
  input.value = query
  input.placeholder = t('explore.search_placeholder')
  input.style.cssText = `
    width: 100%;
    padding: 0.6rem 0.75rem 0.6rem 2.3rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 9999px;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 0.875rem;
    outline: none;
    transition: border-color 0.2s ease;
    box-sizing: border-box;
  `

  const icon = document.createElement('span')
  icon.className = 'search-icon'
  icon.style.cssText = 'position: absolute; left: 0.7rem; top: 50%; transform: translateY(-50%); color: var(--text-muted); font-size: 0.8rem; pointer-events: none;'
  icon.textContent = '🔍'

  searchBox.appendChild(input)
  searchBox.appendChild(icon)

  const suggestDropdown = document.createElement('div')
  suggestDropdown.className = 'tag-suggest-dropdown'
  suggestDropdown.style.cssText = `
    display: none;
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 100;
    max-height: 300px;
    overflow-y: auto;
    margin-top: 4px;
  `
  searchBox.appendChild(suggestDropdown)

  header.appendChild(backBtn)
  header.appendChild(searchBox)

  const content = document.createElement('div')
  content.className = 'search-page-content'

  container.appendChild(header)
  container.appendChild(content)

  // Loading state
  const loadingEl = document.createElement('div')
  loadingEl.style.cssText = `
    text-align: center;
    padding: 3rem;
    color: var(--text-muted);
  `
  loadingEl.textContent = t('common.loading')
  content.appendChild(loadingEl)

  // ── Search input events ──
  let suggestAbortController: AbortController | null = null
  let suggestTimer: ReturnType<typeof setTimeout> | null = null

  const fetchSuggestions = async (prefix: string, kind: 'tag' | 'user') => {
    if (suggestAbortController) suggestAbortController.abort()
    const controller = new AbortController()
    suggestAbortController = controller
    try {
      const url = kind === 'tag'
        ? `/api/tags/suggest?q=${encodeURIComponent(prefix)}`
        : `/api/users/suggest?q=${encodeURIComponent(prefix)}`
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) return
      if (kind === 'tag') {
        const data = await res.json() as { tags: { tag: string; count: number }[] }
        renderSuggestions((data.tags || []).map(t => ({ type: 'tag' as const, label: t.tag, count: t.count })))
      } else {
        const data = await res.json() as { users: { username: string; display_name: string; avatar_key: string }[] }
        renderSuggestions((data.users || []).map(u => ({ type: 'user' as const, label: u.username, display: u.display_name, avatar: u.avatar_key })))
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') console.error('Suggest error:', err)
    }
  }

  const renderSuggestions = (items: SuggestionItem[]) => {
    suggestDropdown.innerHTML = ''
    if (items.length === 0) {
      suggestDropdown.style.display = 'none'
      return
    }
    suggestDropdown.style.display = 'block'
    for (const it of items) {
      const item = document.createElement('div')
      item.style.cssText = `
        padding: 0.6rem 0.75rem;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        transition: background 0.15s;
      `
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))' })
      item.addEventListener('mouseleave', () => { item.style.background = 'none' })

      if (it.type === 'tag') {
        const tagName = document.createElement('span')
        tagName.textContent = `# ${it.label}`
        tagName.style.cssText = 'font-weight: 600; color: var(--accent); font-size: 0.875rem;'
        const count = document.createElement('span')
        count.textContent = `${it.count}`
        count.style.cssText = 'margin-left: auto; color: var(--text-muted); font-size: 0.75rem;'
        item.appendChild(tagName)
        item.appendChild(count)
        item.addEventListener('click', () => {
          suggestDropdown.style.display = 'none'
          window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(it.label)}`)
          window.location.reload()
        })
      } else {
        const avatar = document.createElement('div')
        avatar.style.cssText = `
          width: 28px; height: 28px; border-radius: 50%;
          background: var(--accent); color: var(--bg-primary);
          display: flex; align-items: center; justify-content: center;
          font-weight: bold; font-size: 0.7rem; flex-shrink: 0;
        `
        avatar.textContent = (it.display || it.label)[0].toUpperCase()
        const info = document.createElement('div')
        info.style.cssText = 'display: flex; flex-direction: column;'
        const name = document.createElement('span')
        name.textContent = `@${it.label}`
        name.style.cssText = 'font-weight: 600; color: var(--text-primary); font-size: 0.85rem;'
        const display = document.createElement('span')
        display.textContent = it.display
        display.style.cssText = 'font-size: 0.75rem; color: var(--text-muted);'
        info.appendChild(name)
        info.appendChild(display)
        item.appendChild(avatar)
        item.appendChild(info)
        item.addEventListener('click', () => {
          suggestDropdown.style.display = 'none'
          window.history.pushState({}, '', `/profile/${encodeURIComponent(it.label)}`)
          window.dispatchEvent(new CustomEvent('spaNavigate', {
            detail: { view: 'profile', username: it.label }
          }))
        })
      }
      suggestDropdown.appendChild(item)
    }
  }

  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      const q = input.value.trim()
      suggestAbortController?.abort()
      suggestDropdown.style.display = 'none'
      if (q.startsWith('#')) {
        const afterHash = q.slice(1).trim()
        const spaceIdx = afterHash.indexOf(' ')
        if (spaceIdx === -1 && afterHash) {
          window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(afterHash)}`)
          window.location.reload()
          return
        }
      }
      if (q && q !== query) {
        window.history.pushState({}, '', `/search?q=${encodeURIComponent(q)}&type=${type}`)
        window.dispatchEvent(new CustomEvent('spaNavigate', {
          detail: { view: 'search', searchQuery: q, searchType: type }
        }))
      }
    }
  })

  input.addEventListener('input', () => {
    const val = input.value
    if (suggestAbortController) suggestAbortController.abort()
    if (suggestTimer) clearTimeout(suggestTimer)
    if (val.length < 2 || val.includes(' ')) {
      suggestDropdown.style.display = 'none'
      return
    }
    if (val.startsWith('#')) {
      const prefix = val.slice(1)
      if (!prefix) { suggestDropdown.style.display = 'none'; return }
      suggestTimer = setTimeout(() => fetchSuggestions(prefix, 'tag'), 200)
      return
    }
    if (val.startsWith('@')) {
      const prefix = val.slice(1)
      if (!prefix) { suggestDropdown.style.display = 'none'; return }
      suggestTimer = setTimeout(() => fetchSuggestions(prefix, 'user'), 200)
      return
    }
    suggestDropdown.style.display = 'none'
  })

  input.addEventListener('blur', () => {
    setTimeout(() => { suggestDropdown.style.display = 'none' }, 200)
  })

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      suggestDropdown.style.display = 'none'
      input.blur()
    }
  })

  // ── Fetch search results ──
  const loadSearchResults = async () => {
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&type=${type}&limit=20`)
      const data = await response.json() as { results: any[]; users?: any[] }
      const results = data.results || []
      const matchedUsers = (type === 'posts' ? data.users : []) || []

      content.removeChild(loadingEl)

      const hasPosts = results.length > 0
      const hasUsers = matchedUsers.length > 0

      if (!hasPosts && !hasUsers) {
        const empty = document.createElement('div')
        empty.style.cssText = "text-align: center; padding: 3rem; color: var(--text-muted); font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;"
        empty.textContent = t('search.no_results', { query })
        content.appendChild(empty)
        return
      }

      if (type === 'users') {
        renderUsers(results)
      } else {
        if (hasUsers) {
          const sectionTitle = document.createElement('div')
          sectionTitle.textContent = t('search.users')
          sectionTitle.style.cssText = 'font-weight: 600; font-size: 0.9rem; color: var(--text-muted); margin-bottom: 0.5rem; padding: 0 0.25rem;'
          content.appendChild(sectionTitle)
          renderUsers(matchedUsers, content)
        }
        if (hasPosts) {
          if (hasUsers) {
            const divider = document.createElement('div')
            divider.style.cssText = 'height: 1px; background: var(--border); margin: 1rem 0;'
            content.appendChild(divider)
          }
          const sectionTitle = document.createElement('div')
          sectionTitle.textContent = t('search.posts')
          sectionTitle.style.cssText = 'font-weight: 600; font-size: 0.9rem; color: var(--text-muted); margin-bottom: 0.5rem; padding: 0 0.25rem;'
          content.appendChild(sectionTitle)
          renderPosts(results)
        }
      }
    } catch (error) {
      console.error('Search error:', error)
      content.removeChild(loadingEl)
      const errorEl = document.createElement('div')
      errorEl.style.cssText = 'text-align: center; padding: 3rem; color: var(--danger);'
      errorEl.textContent = t('common.error')
      content.appendChild(errorEl)
    }
  }

  const renderUsers = (users: any[], containerEl?: HTMLElement) => {
    const parent = containerEl || content
    users.forEach(user => {
      const userItem = document.createElement('div')
      userItem.style.cssText = `
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.75rem;
        border-radius: 0.25rem;
        cursor: pointer;
        transition: background-color 0.2s ease;
      `
      userItem.onmouseover = () => userItem.style.background = 'var(--bg-secondary)'
      userItem.onmouseout = () => userItem.style.background = 'transparent'

      userItem.onclick = () => {
        window.history.pushState({ username: user.username }, '', `/profile/${user.username}`)
        window.dispatchEvent(new CustomEvent('spaNavigate', {
          detail: { view: 'profile', username: user.username }
        }))
      }

      const avatar = document.createElement('div')
      avatar.style.cssText = `
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: var(--accent);
        color: var(--bg-primary);
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: bold;
        font-size: 0.875rem;
        flex-shrink: 0;
      `
      avatar.textContent = user.display_name?.[0]?.toUpperCase() || user.username[0].toUpperCase()

      const userInfo = document.createElement('div')

      const usernameEl = document.createElement('div')
      usernameEl.style.cssText = 'font-weight: 600; color: var(--text-primary);'
      usernameEl.textContent = `@${user.username}`

      const displayNameEl = document.createElement('div')
      displayNameEl.style.cssText = 'font-size: 0.875rem; color: var(--text-muted);'
      displayNameEl.textContent = user.display_name || ''

      userInfo.appendChild(usernameEl)
      userInfo.appendChild(displayNameEl)

      userItem.appendChild(avatar)
      userItem.appendChild(userInfo)
      parent.appendChild(userItem)
    })
  }

  const renderPosts = (posts: any[]) => {
    posts.forEach(post => {
      const postItem = document.createElement('div')
      postItem.style.cssText = `
        padding: 1rem;
        border: 1px solid var(--border);
        border-radius: 0.25rem;
        margin-bottom: 0.75rem;
        cursor: pointer;
        transition: background-color 0.2s ease;
      `
      postItem.onmouseover = () => postItem.style.background = 'var(--bg-secondary)'
      postItem.onmouseout = () => postItem.style.background = 'transparent'

      postItem.onclick = () => {
        window.history.pushState({ postId: post.id }, '', `/thread/${post.id}`)
        window.dispatchEvent(new CustomEvent('spaNavigate', {
          detail: { view: 'thread', postId: post.id }
        }))
      }

      const postHeader = document.createElement('div')
      postHeader.style.cssText = `
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 0.5rem;
      `

      const postUser = document.createElement('span')
      postUser.style.cssText = 'font-weight: 600; color: var(--text-primary);'
      postUser.textContent = `@${post.username}`

      const postDate = document.createElement('span')
      postDate.style.cssText = 'font-size: 0.75rem; color: var(--text-muted);'
      postDate.textContent = new Date(post.created_at).toLocaleDateString()

      postHeader.appendChild(postUser)
      postHeader.appendChild(postDate)

      if (type === 'arcade' || post.swf_key || post.payload_key) {
        const badge = document.createElement('span')
        badge.style.cssText = 'margin-left: 0.5rem; padding: 0.1rem 0.4rem; background: var(--accent); color: white; border-radius: 4px; font-size: 0.7rem; vertical-align: middle;'
        badge.textContent = post.swf_key ? t('search.media_flash') : post.payload_key?.startsWith('dos/') ? t('search.media_dos') : t('search.media_game')
        postHeader.appendChild(badge)
      }

      const postText = document.createElement('div')
      postText.style.cssText = `
        color: var(--text-primary);
        line-height: 1.4;
        font-family: inherit;
        font-size: 0.875rem;
      `
      postText.textContent = post.text

      postItem.appendChild(postHeader)
      postItem.appendChild(postText)
      content.appendChild(postItem)
    })
  }

  // Start loading
  loadSearchResults()

  return {
    getElement: () => container,
    destroy: () => {
      container.remove()
    }
  }
}
