import { t } from '../lib/i18n.js'

interface SearchPageProps {
  query: string
  type?: 'posts' | 'users' | 'arcade'
  currentUser: { username: string } | null
  sandboxOrigin: string
}

export function createSearchPage({ query, type = 'posts', currentUser, sandboxOrigin }: SearchPageProps) {
  const container = document.createElement('div')
  container.className = 'search-page'

  const header = document.createElement('div')
  header.className = 'search-page-header'
  header.style.cssText = `
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--bg-primary);
    z-index: 10;
  `

  const title = document.createElement('h2')
  title.textContent = t('search.results_for', { query })
  title.style.cssText = `
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary);
  `
  header.appendChild(title)

  const content = document.createElement('div')
  content.className = 'search-page-content'
  content.style.cssText = `
    padding: 1rem 1.5rem;
  `

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

  // Fetch search results
  const loadSearchResults = async () => {
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&type=${type}&limit=20`)
      const data = await response.json() as { results: any[] }
      const results = data.results || []

      content.removeChild(loadingEl)

      if (results.length === 0) {
        const empty = document.createElement('div')
        empty.style.cssText = "text-align: center; padding: 3rem; color: var(--text-muted); font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;"
        empty.textContent = t('search.no_results', { query })
        content.appendChild(empty)
        return
      }

      if (type === 'users') {
        renderUsers(results)
      } else {
        renderPosts(results)
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

  const renderUsers = (users: any[]) => {
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
      content.appendChild(userItem)
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
        badge.textContent = post.swf_key ? t('search.media_flash') : t('search.media_game')
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
