import { createPostCard } from './PostCard.js'
import { Post } from '../types/post.js'
import { createSkeletonCard } from './SkeletonCard.js'
import { t } from '../lib/i18n.js'
import { openPostModal } from '../lib/post-modal.js'

export interface ExplorePageProps {
  tag?: string
  sandboxOrigin: string
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null
}

export class ExplorePage {
  private element: HTMLElement
  private props: ExplorePageProps
  private posts: Post[] = []
  private cursor?: string
  private loading = false
  private hasMore = true
  private intersectionObserver: IntersectionObserver | null = null
  private loadMoreSentinel: HTMLElement | null = null
  private retryCount = 0
  private maxRetries = 3
  private searchFilter: 'posts' | 'users' | 'arcade' = 'posts'
  private fabButton: HTMLElement | null = null
  private tagCountEl: HTMLElement | null = null
  private suggestAbortController: AbortController | null = null

  constructor(props: ExplorePageProps) {
    this.props = props
    this.element = this.createElement()
    this.setupEventListeners()
    this.loadContent()
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'explore-page'

    // Add search section
    const searchSection = this.createSearchSection()
    container.appendChild(searchSection)

    if (this.props.tag) {
      // Tag view
      const tagHeader = document.createElement('div')
      tagHeader.className = 'explore-header explore-tag-header'
      tagHeader.style.cssText = `
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 1rem;
        border-bottom: 1px solid var(--border);
      `

      const backBtn = document.createElement('button')
      backBtn.className = 'explore-tag-back'
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
      `
      backBtn.addEventListener('mouseenter', () => { backBtn.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))' })
      backBtn.addEventListener('mouseleave', () => { backBtn.style.background = 'none' })
      backBtn.addEventListener('click', () => {
        window.history.pushState({}, '', '/explore')
        window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'explore' } }))
      })

      const tagInfo = document.createElement('div')
      tagInfo.style.cssText = 'display: flex; flex-direction: column;'

      const tagTitle = document.createElement('span')
      tagTitle.className = 'explore-title'
      tagTitle.textContent = `# ${this.props.tag}`
      tagTitle.style.cssText = `
        font-size: 1.25rem;
        font-weight: 700;
        color: var(--text-primary);
        line-height: 1.3;
      `

      this.tagCountEl = document.createElement('span')
      this.tagCountEl.className = 'explore-tag-count'
      this.tagCountEl.textContent = t('explore.tag_count', { count: 0 })
      this.tagCountEl.style.cssText = `
        font-size: 0.8rem;
        color: var(--text-muted);
      `

      tagInfo.appendChild(tagTitle)
      tagInfo.appendChild(this.tagCountEl)
      tagHeader.appendChild(backBtn)
      tagHeader.appendChild(tagInfo)
      container.appendChild(tagHeader)

      const postsContainer = document.createElement('div')
      postsContainer.className = 'explore-posts'
      container.appendChild(postsContainer)
    } else {
      const contentContainer = document.createElement('div')
      contentContainer.className = 'explore-content'

      const trendingTagsContainer = document.createElement('div')
      trendingTagsContainer.className = 'explore-trending-tags'
      contentContainer.appendChild(trendingTagsContainer)

      const postsContainer = document.createElement('div')
      postsContainer.className = 'explore-posts'
      contentContainer.appendChild(postsContainer)

      container.appendChild(contentContainer)
    }

    // Add loading container
    const loadingContainer = document.createElement('div')
    loadingContainer.className = 'explore-loading'
    loadingContainer.style.cssText = 'display: none;'
    container.appendChild(loadingContainer)
    
    // Add sentinel for intersection observer
    this.loadMoreSentinel = document.createElement('div')
    this.loadMoreSentinel.className = 'explore-sentinel'
    this.loadMoreSentinel.style.cssText = `
      height: 100px;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-top: 1rem;
    `
    container.appendChild(this.loadMoreSentinel)

    if (this.props.currentUser) {
      this.fabButton = document.createElement('button')
      this.fabButton.className = 'timeline-fab visible'
      this.fabButton.textContent = '+'
      this.fabButton.addEventListener('click', () => {
        openPostModal({
          currentUser: this.props.currentUser,
          onPostCreated: (post) => this.handleNewPost(post)
        })
      })
      container.appendChild(this.fabButton)
    }

    return container
  }

  private createSearchSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'explore-search-section'
    section.style.cssText = `
      padding: 1rem;
      border-bottom: 1px solid var(--border);
    `

    const searchBox = document.createElement('div')
    searchBox.className = 'search-box'
    searchBox.style.cssText = 'position: relative; margin-bottom: 1rem;'

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'search-input'
    input.placeholder = t('explore.search_placeholder')
    input.style.cssText = 'width: 100%; padding: 0.75rem 1rem 0.75rem 2.5rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 9999px; color: var(--text-primary); font-family: inherit; font-size: 0.875rem; outline: none; transition: border-color 0.2s ease; box-sizing: border-box;'

    const icon = document.createElement('span')
    icon.className = 'search-icon'
    icon.style.cssText = 'position: absolute; left: 0.75rem; top: 50%; transform: translateY(-50%); color: var(--text-muted); font-size: 0.875rem; pointer-events: none;'
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

    section.appendChild(searchBox)

    return section
  }

  private setupEventListeners(): void {
    const searchInput = this.element.querySelector('.search-input') as HTMLInputElement
    const suggestDropdown = this.element.querySelector('.tag-suggest-dropdown') as HTMLElement

    if (searchInput && suggestDropdown) {
      const fetchSuggestions = async (prefix: string, type: 'tag' | 'user') => {
        if (this.suggestAbortController) this.suggestAbortController.abort()
        const controller = new AbortController()
        this.suggestAbortController = controller
        try {
          const url = type === 'tag'
            ? `/api/tags/suggest?q=${encodeURIComponent(prefix)}`
            : `/api/users/suggest?q=${encodeURIComponent(prefix)}`
          const res = await fetch(url, { signal: controller.signal })
          if (!res.ok) return
          if (type === 'tag') {
            const data = await res.json() as { tags: { tag: string; count: number }[] }
            this.renderSuggestions(suggestDropdown, (data.tags || []).map(t => ({ type: 'tag' as const, label: t.tag, count: t.count })))
          } else {
            const data = await res.json() as { users: { username: string; display_name: string; avatar_key: string }[] }
            this.renderSuggestions(suggestDropdown, (data.users || []).map(u => ({ type: 'user' as const, label: u.username, display: u.display_name, avatar: u.avatar_key })))
          }
        } catch (err: any) {
          if (err?.name !== 'AbortError') console.error('Suggest error:', err)
        }
      }

      searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          const query = searchInput.value.trim()
          this.suggestAbortController?.abort()
          suggestDropdown.style.display = 'none'

          if (query.startsWith('#')) {
            const afterHash = query.slice(1).trim()
            const spaceIdx = afterHash.indexOf(' ')
            if (spaceIdx === -1 && afterHash) {
              window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(afterHash)}`)
              window.location.reload()
              return
            }
          }

          if (query.startsWith('@')) {
            this.performSearch(query)
            return
          }

          this.performSearch(query)
        }
      })

      let suggestTimer: ReturnType<typeof setTimeout> | null = null

      searchInput.addEventListener('input', () => {
        const val = searchInput.value

        if (this.suggestAbortController) this.suggestAbortController.abort()
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

      searchInput.addEventListener('blur', () => {
        setTimeout(() => { suggestDropdown.style.display = 'none' }, 200)
      })

      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          suggestDropdown.style.display = 'none'
          searchInput.blur()
        }
      })
  }
}

  private setupIntersectionObserver(): void {
    if (!this.loadMoreSentinel) return

    // Disconnect existing observer if any
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect()
    }

    // Create new intersection observer optimized for mobile
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry.isIntersecting && !this.loading && this.hasMore) {
          // Immediate loading for better mobile performance
          this.loadMorePosts()
        }
      },
      {
        root: null, // Use viewport as root
        rootMargin: '300px', // Start loading 300px before sentinel comes into view (better for mobile)
        threshold: 0.1 // Trigger when 10% is visible (more reliable than 0.01)
      }
    )

    // Start observing sentinel
    this.intersectionObserver.observe(this.loadMoreSentinel)
  }

  private handleNewPost(post: Post): void {
    this.posts = [post, ...this.posts]
    const postsContainer = this.element.querySelector('.explore-posts') as HTMLElement
    if (postsContainer) {
      postsContainer.insertBefore(
        createPostCard({ post, sandboxOrigin: this.props.sandboxOrigin, currentUser: this.props.currentUser || undefined }).getElement(),
        postsContainer.firstChild
      )
    }
    this.updateTagCount()
  }

  private updateTagCount(): void {
    if (this.tagCountEl && this.props.tag) {
      this.tagCountEl.textContent = t('explore.tag_count', { count: this.posts.length })
    }
  }

  private setupSwipeDetection(): void {
    return
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public destroy(): void {
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect()
      this.intersectionObserver = null
    }
    window.removeEventListener('scroll', () => {})
  }
}

// Factory function for easier usage
export function createExplorePage(props: ExplorePageProps): ExplorePage {
  return new ExplorePage(props)
}
