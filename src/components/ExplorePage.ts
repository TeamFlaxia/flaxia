import { createPostCard } from './PostCard.js'
import { Post } from '../types/post.js'
import { createSkeletonCard } from './SkeletonCard.js'
import { t } from '../lib/i18n.js'

export interface ExplorePageProps {
  tag?: string
  sandboxOrigin: string
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
  private currentTab: 'recommended' | 'trending' = 'recommended'
  private searchFilter: 'posts' | 'users' | 'arcade' = 'posts'

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
      tagHeader.className = 'explore-header'
      const tagTitle = document.createElement('h1')
      tagTitle.className = 'explore-title'
      tagTitle.textContent = t('explore.tag_title', { tag: this.props.tag })
      tagHeader.appendChild(tagTitle)
      container.appendChild(tagHeader)
      
      const postsContainer = document.createElement('div')
      postsContainer.className = 'explore-posts'
      container.appendChild(postsContainer)
    } else {
      // Explore tabs
      const tabsContainer = document.createElement('div')
      tabsContainer.className = 'explore-tabs'
      tabsContainer.style.cssText = `
        display: flex;
        border-bottom: 1px solid var(--border);
      `
      
      const recTab = this.createTab(t('explore.tab_for_you'), 'recommended')
      const trendTab = this.createTab(t('explore.tab_trending'), 'trending')
      
      tabsContainer.appendChild(recTab)
      tabsContainer.appendChild(trendTab)
      container.appendChild(tabsContainer)

      // Content container
      const contentContainer = document.createElement('div')
      contentContainer.className = 'explore-content'
      
      // Trending tags section (initially hidden or shown depending on tab)
      const trendingTagsContainer = document.createElement('div')
      trendingTagsContainer.className = 'explore-trending-tags'
      trendingTagsContainer.style.display = 'none'
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
    
    return container
  }

  private createTab(label: string, id: 'recommended' | 'trending'): HTMLElement {
    const tab = document.createElement('div')
    tab.className = `explore-tab ${this.currentTab === id ? 'active' : ''}`
    tab.textContent = label
    tab.style.cssText = `
      flex: 1;
      text-align: center;
      padding: 1rem;
      cursor: pointer;
      font-weight: ${this.currentTab === id ? 'bold' : 'normal'};
      color: ${this.currentTab === id ? 'var(--text-primary)' : 'var(--text-muted)'};
      border-bottom: 2px solid ${this.currentTab === id ? 'var(--accent)' : 'transparent'};
      transition: all 0.2s ease;
    `
    
    tab.onclick = () => {
      if (this.currentTab === id) return
      this.currentTab = id
      this.resetAndReload()
      
      // Update UI
      this.element.querySelectorAll('.explore-tab').forEach(t => {
        const h = t as HTMLElement
        h.classList.remove('active')
        h.style.fontWeight = 'normal'
        h.style.color = 'var(--text-muted)'
        h.style.borderBottomColor = 'transparent'
      })
      tab.classList.add('active')
      tab.style.fontWeight = 'bold'
      tab.style.color = 'var(--text-primary)'
      tab.style.borderBottomColor = 'var(--accent)'
    }
    
    return tab
  }

  private createSearchSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'explore-search-section'
    section.style.cssText = `
      padding: 1rem;
      border-bottom: 1px solid var(--border);
    `
    
    section.innerHTML = `
      <div class="search-box" style="position: relative; margin-bottom: 1rem;">
        <input 
          type="text" 
          class="search-input" 
          placeholder="${t('explore.search_placeholder')}"
          style="width: 100%; padding: 0.75rem 1rem 0.75rem 2.5rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 9999px; color: var(--text-primary); font-family: inherit; font-size: 0.875rem; outline: none; transition: border-color 0.2s ease;"
        />
        <span class="search-icon" style="position: absolute; left: 0.75rem; top: 50%; transform: translateY(-50%); color: var(--text-muted); font-size: 0.875rem;">🔍</span>
      </div>
      <div class="search-filters" style="display: flex; gap: 0.5rem; overflow-x: auto; padding-bottom: 0.25rem;">
        <button class="filter-btn active" data-filter="posts">${t('explore.filter_posts')}</button>
        <button class="filter-btn" data-filter="users">${t('explore.filter_users')}</button>
        <button class="filter-btn" data-filter="arcade">${t('explore.filter_arcade')}</button>
      </div>
    `

    // Style filter buttons
    const filterBtns = section.querySelectorAll('.filter-btn')
    filterBtns.forEach(btn => {
      const b = btn as HTMLElement
      const isActive = b.dataset.filter === this.searchFilter
      b.style.cssText = `
        padding: 0.4rem 1rem;
        border-radius: 999px;
        border: 1px solid ${isActive ? 'var(--accent)' : 'var(--border)'};
        background: ${isActive ? 'var(--accent)' : 'transparent'};
        color: ${isActive ? 'white' : 'var(--text-muted)'};
        font-size: 0.8rem;
        cursor: pointer;
        white-space: nowrap;
        transition: all 0.2s ease;
      `
      
      b.onclick = () => {
        this.searchFilter = b.dataset.filter as any
        filterBtns.forEach(other => {
          const o = other as HTMLElement
          const isNowActive = o.dataset.filter === this.searchFilter
          o.style.border = `1px solid ${isNowActive ? 'var(--accent)' : 'var(--border)'}`
          o.style.background = isNowActive ? 'var(--accent)' : 'transparent'
          o.style.color = isNowActive ? 'white' : 'var(--text-muted)'
        })
      }
    })

    return section
  }

  private setupEventListeners(): void {
    // Search functionality
    const searchInput = this.element.querySelector('.search-input') as HTMLInputElement
    if (searchInput) {
      searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          const query = searchInput.value.trim()
          if (query) {
            this.performSearch(query)
          }
        }
      })
    }

    // Setup intersection observer for infinite scroll
    this.setupIntersectionObserver()
  }

  private resetAndReload(): void {
    this.posts = []
    this.cursor = undefined
    this.hasMore = true
    const postsContainer = this.element.querySelector('.explore-posts')
    if (postsContainer) postsContainer.innerHTML = ''
    this.loadContent()

    // Re-setup intersection observer
    this.setupIntersectionObserver()
  }

  private async loadContent(): Promise<void> {
    if (this.loading) return
    this.loading = true
    this.updateLoadingState(true)

    try {
      if (this.props.tag) {
        await this.loadTagPosts()
      } else if (this.currentTab === 'recommended') {
        await this.loadRecommendedPosts()
      } else {
        await this.loadTrendingContent()
      }
    } catch (error) {
      console.error('Failed to load explore content:', error)
    } finally {
      this.loading = false
      this.updateLoadingState(false)
    }
  }

  private async loadMorePosts(): Promise<void> {
    if (this.loading || !this.hasMore) return

    this.loading = true
    this.updateLoadingState(true)

    try {
      let url = ''
      if (this.props.tag) {
        url = `/api/posts?hashtag=${encodeURIComponent(this.props.tag)}&limit=10`
      } else if (this.currentTab === 'trending') {
        url = `/api/posts/trending?limit=10`
      } else {
        url = `/api/posts/recommended?limit=10`
      }

      if (this.cursor) {
        // Ensure legacy date-based cursors aren't sent to the recommended or trending endpoints
        if ((this.currentTab === 'recommended' || this.currentTab === 'trending') && !this.cursor.includes(',')) {
          this.cursor = undefined
        } else {
          url += `&cursor=${encodeURIComponent(this.cursor)}`
        }
      }

      console.log('Fetching URL:', url);
      const response = await fetch(url)
      if (!response.ok) throw new Error('Failed to load more posts')
      
      const data = await response.json() as { posts: Post[] }
      const newPosts = data.posts || []

      if (newPosts.length > 0) {
        this.posts.push(...newPosts)
        // If recommended or trending, use score,created_at as cursor
        if (!this.props.tag && (this.currentTab === 'recommended' || this.currentTab === 'trending')) {
          const lastPost = newPosts[newPosts.length - 1] as any
          this.cursor = `${lastPost.score},${lastPost.created_at}`
        } else {
          this.cursor = newPosts[newPosts.length - 1].created_at
        }
        this.hasMore = newPosts.length === 10
        this.renderPosts()
      } else {
        this.hasMore = false
        this.showEndOfPosts()
      }
    } catch (error) {
      console.error('Failed to load more posts:', error)
      this.showLoadError()
    } finally {
      this.loading = false
      this.updateLoadingState(false)
    }
  }

  private async loadTagPosts(): Promise<void> {
    let url = `/api/posts?hashtag=${encodeURIComponent(this.props.tag!)}&limit=10`
    if (this.cursor) {
      url += `&cursor=${encodeURIComponent(this.cursor)}`
    }
    const response = await fetch(url)
    if (!response.ok) throw new Error('Failed to load tag posts')
    const data = await response.json() as { posts: Post[] }
    this.handleNewPosts(data.posts)
  }

  private async loadRecommendedPosts(): Promise<void> {
    const url = `/api/posts/recommended?limit=10`
    const response = await fetch(url)
    if (!response.ok) throw new Error('Failed to load recommended posts')
    const data = await response.json() as { posts: Post[] }
    this.handleNewPosts(data.posts)
  }

  private async loadTrendingContent(): Promise<void> {
    // Load both trending tags and trending posts
    const [tagsRes, postsRes] = await Promise.all([
      fetch('/api/tags/trending'),
      fetch('/api/posts/trending?limit=10')
    ])

    if (tagsRes.ok) {
      const tagsData = await tagsRes.json()
      this.renderTrendingTags(tagsData.tags || [])
    }

    if (postsRes.ok) {
      const postsData = await postsRes.json()
      this.handleNewPosts(postsData.posts || [])
    }
  }

  private handleNewPosts(newPosts: Post[]): void {
    if (newPosts.length > 0) {
      this.posts.push(...newPosts)
      this.cursor = newPosts[newPosts.length - 1].created_at
      this.hasMore = newPosts.length === 10
      this.renderPosts()
    } else {
      this.hasMore = false
      if (this.posts.length > 0) this.showEndOfPosts()
    }
  }

  private performSearch(query: string): void {
    window.history.pushState({}, '', `/search?q=${encodeURIComponent(query)}&type=${this.searchFilter}`)
    window.dispatchEvent(new CustomEvent('spaNavigate', {
      detail: { view: 'search', searchQuery: query, searchType: this.searchFilter }
    }))
  }

  private renderPosts(): void {
    const postsContainer = this.element.querySelector('.explore-posts') as HTMLElement
    if (!postsContainer) return

    // If initial load, clear container
    if (this.posts.length <= 10 && postsContainer.children.length > 0 && !this.cursor) {
      postsContainer.innerHTML = ''
    }

    const fragment = document.createDocumentFragment()
    const startIndex = postsContainer.children.length
    
    this.posts.slice(startIndex).forEach(post => {
      const postCard = createPostCard({
        post,
        sandboxOrigin: this.props.sandboxOrigin,
        depth: post.depth
      })
      fragment.appendChild(postCard.getElement())
    })
    
    postsContainer.appendChild(fragment)
  }

  private renderTrendingTags(tags: any[]): void {
    const container = this.element.querySelector('.explore-trending-tags') as HTMLElement
    if (!container) return

    container.innerHTML = `<h2 style="padding: 1rem; font-size: 1.25rem; border-bottom: 1px solid var(--border);">${t('explore.trending_tags')}</h2>`
    container.style.display = this.currentTab === 'trending' ? 'block' : 'none'
    container.style.background = 'var(--bg-secondary)'
    container.style.marginBottom = '1rem'

    tags.forEach(({ tag, percentage }) => {
      const item = document.createElement('div')
      item.className = 'trending-item'
      item.style.cssText = `
        padding: 0.75rem 1rem;
        cursor: pointer;
        transition: background-color 0.2s ease;
        border-bottom: 1px solid var(--border);
      `
      item.innerHTML = `
        <div style="color: var(--accent); font-weight: 600;"># ${tag}</div>
        <div style="font-size: 0.8rem; color: var(--text-muted);">${t('explore.trending_percent', { percentage })}</div>
      `
      item.onclick = () => {
        window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(tag)}`)
        window.location.reload()
      }
      container.appendChild(item)
    })
  }

  private updateLoadingState(isLoading: boolean): void {
    const loadingElement = this.element.querySelector('.explore-loading') as HTMLElement
    if (loadingElement) {
      loadingElement.style.display = isLoading ? 'block' : 'none'
      if (isLoading) {
        // Show skeleton cards while loading more posts
        loadingElement.innerHTML = ''
        for (let i = 0; i < 2; i++) {
          loadingElement.appendChild(createSkeletonCard())
        }
      }
    }
  }

  private showEndOfPosts(): void {
    const loadingElement = this.element.querySelector('.explore-loading') as HTMLElement
    if (loadingElement) {
      loadingElement.style.display = 'block'
      loadingElement.innerHTML = ''
      const wrapper = document.createElement('div')
      wrapper.style.cssText = "text-align: center; padding: 2rem; color: var(--text-muted); font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;"

      const icon = document.createElement('div')
      icon.style.cssText = 'font-size: 1.5rem; margin-bottom: 0.5rem;'
      icon.textContent = t('explore.end_icon')

      const title = document.createElement('div')
      title.textContent = t('explore.end_message')

      const subtitle = document.createElement('div')
      subtitle.style.cssText = 'font-size: 0.875rem; margin-top: 0.5rem;'
      subtitle.textContent = t('explore.end_subtitle', { tag: this.props.tag ?? '' })

      wrapper.appendChild(icon)
      wrapper.appendChild(title)
      wrapper.appendChild(subtitle)
      loadingElement.appendChild(wrapper)
    }
  }

  private showLoadError(): void {
    const loadingElement = this.element.querySelector('.explore-loading') as HTMLElement
    if (loadingElement) {
      loadingElement.style.display = 'block'
      loadingElement.innerHTML = ''

      const wrapper = document.createElement('div')
      wrapper.style.cssText = "text-align: center; padding: 2rem; color: var(--text-muted); font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;"

      const icon = document.createElement('div')
      icon.style.cssText = 'font-size: 1.5rem; margin-bottom: 0.5rem;'
      icon.textContent = '⚠️'

      const title = document.createElement('div')
      title.textContent = t('explore.load_error')

      const retryBtn = document.createElement('button')
      retryBtn.textContent = t('common.retry')
      retryBtn.style.cssText = 'margin-top: 1rem; padding: 0.5rem 1rem; background: var(--accent); color: white; border: none; border-radius: 4px; cursor: pointer; font-family: inherit;'
      retryBtn.addEventListener('click', () => {
        loadingElement.style.display = 'none'
        this.retryCount = 0
        void this.loadMorePosts()
      })

      wrapper.appendChild(icon)
      wrapper.appendChild(title)
      wrapper.appendChild(retryBtn)
      loadingElement.appendChild(wrapper)
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

  private setupSwipeDetection(): void {
    // Mobile left nav gestures are disabled. Navigation is opened only by the explicit menu button.
    return
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public destroy(): void {
    // Cleanup intersection observer
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect()
      this.intersectionObserver = null
    }
    
    // Cleanup scroll event listeners (if any remain)
    window.removeEventListener('scroll', () => {})
  }
}

// Factory function for easier usage
export function createExplorePage(props: ExplorePageProps): ExplorePage {
  return new ExplorePage(props)
}
