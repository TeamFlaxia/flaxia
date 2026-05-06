import { createPostCard } from './PostCard.js'
import { Post } from '../types/post.js'
import { safeRemoveFromBody } from '../lib/dom-utils.js'
import { createSkeletonCard } from './SkeletonCard.js'

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
  private touchStartX = 0
  private touchStartY = 0
  private touchStartTime = 0

  constructor(props: ExplorePageProps) {
    this.props = props
    this.element = this.createElement()
    this.setupEventListeners()
    this.setupSwipeDetection()
    this.loadPosts()
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
      tagTitle.textContent = `# ${this.props.tag}`
      tagHeader.appendChild(tagTitle)
      container.appendChild(tagHeader)
      const postsContainer = document.createElement('div')
      postsContainer.className = 'explore-posts'
      container.appendChild(postsContainer)
    } else {
      // Trending view
      const exploreHeader = document.createElement('div')
      exploreHeader.className = 'explore-header'
      const title = document.createElement('h1')
      title.className = 'explore-title'
      title.textContent = 'Explore'
      exploreHeader.appendChild(title)
      container.appendChild(exploreHeader)
      const trendingContainer = document.createElement('div')
      trendingContainer.className = 'explore-trending'
      container.appendChild(trendingContainer)
    }

    // Add loading container
    const loadingContainer = document.createElement('div')
    loadingContainer.className = 'explore-loading'
    loadingContainer.style.cssText = 'display: none;'
    container.appendChild(loadingContainer)
    
    // Add sentinel for intersection observer (outside posts container like Timeline)
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
          placeholder="Search Flaxia"
          style="width: 100%; padding: 0.75rem 1rem 0.75rem 2.5rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 9999px; color: var(--text-primary); font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 0.875rem; outline: none; transition: border-color 0.2s ease;"
        />
        <span class="search-icon" style="position: absolute; left: 0.75rem; top: 50%; transform: translateY(-50%); color: var(--text-muted); font-size: 0.875rem;">🔍</span>
      </div>
    `

    return section
  }

  private setupEventListeners(): void {
    // Search functionality
    const searchInput = this.element.querySelector('.search-input') as HTMLInputElement
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        // Just update input value, no auto-search
      })

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

  private async performSearch(query: string): Promise<void> {
    try {
      console.log('Searching for:', query)
      
      // Show loading state
      const searchBox = this.element.querySelector('.search-box')
      if (searchBox) {
        searchBox.classList.add('searching')
      }

      // Search posts
      const postsResponse = await fetch(`/api/search?q=${encodeURIComponent(query)}&type=posts&limit=10`)
      const postsData = postsResponse.ok ? await postsResponse.json() as { results: any[] } : { results: [] }

      // Search users
      const usersResponse = await fetch(`/api/search?q=${encodeURIComponent(query)}&type=users&limit=5`)
      const usersData = usersResponse.ok ? await usersResponse.json() as { results: any[] } : { results: [] }

      // Remove loading state
      if (searchBox) {
        searchBox.classList.remove('searching')
      }

      // Import and show search results
      const { createSearchResults } = await import('./SearchResults.js')
      const searchResults = createSearchResults({
        query,
        posts: postsData.results || [],
        users: usersData.results || [],
        onClose: () => {
          safeRemoveFromBody(searchResults)
        }
      })

      document.body.appendChild(searchResults)

    } catch (error) {
      console.error('Search error:', error)
      
      // Remove loading state
      const searchBox = this.element.querySelector('.search-box')
      if (searchBox) {
        searchBox.classList.remove('searching')
      }
    }
  }

  private async loadPosts(): Promise<void> {
    if (this.loading) return

    this.loading = true
    this.updateLoadingState(true)

    try {
      if (this.props.tag) {
        // Load posts with this tag
        let url = `/api/posts?hashtag=${encodeURIComponent(this.props.tag)}&limit=10`
        if (this.cursor) {
          url += `&cursor=${encodeURIComponent(this.cursor)}`
        }

        const response = await fetch(url)
        if (!response.ok) {
          throw new Error('Failed to load posts')
        }

        const data = await response.json() as { posts: Post[] }
        this.posts = data.posts || []
        this.hasMore = this.posts.length === 10 && this.posts.length > 0
        this.cursor = this.posts.length > 0 ? this.posts[this.posts.length - 1].created_at : undefined

        this.renderPosts()
      } else {
        // Load trending tags
        await this.loadTrendingTags()
      }
    } catch (error) {
      console.error('Failed to load explore content:', error)
    } finally {
      this.loading = false
      this.updateLoadingState(false)
    }
  }

  private async loadMorePosts(): Promise<void> {
    if (this.loading || !this.hasMore || !this.props.tag) return

    this.loading = true
    this.updateLoadingState(true)

    try {
      let url = `/api/posts?hashtag=${encodeURIComponent(this.props.tag)}&limit=10`
      if (this.cursor) {
        url += `&cursor=${encodeURIComponent(this.cursor)}`
      }

      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Failed to load more posts: ${response.status}`)
      }

      const data = await response.json() as { posts: Post[] }
      const newPosts = data.posts || []

      if (newPosts.length > 0) {
        this.posts.push(...newPosts)
        this.cursor = newPosts[newPosts.length - 1].created_at
        this.hasMore = newPosts.length === 10 && newPosts.length > 0
        this.appendNewPosts(newPosts)
        this.retryCount = 0 // Reset retry count on success
      } else {
        this.hasMore = false
        this.showEndOfPosts()
      }
    } catch (error) {
      console.error('Failed to load more posts:', error)
      this.retryCount++
      
      if (this.retryCount < this.maxRetries) {
        // Retry with exponential backoff
        const delay = Math.pow(2, this.retryCount) * 1000
        setTimeout(() => this.loadMorePosts(), delay)
      } else {
        this.showLoadError()
      }
    } finally {
      this.loading = false
      this.updateLoadingState(false)
    }
  }

  private async loadTrendingTags(): Promise<void> {
    try {
      const response = await fetch('/api/tags/trending')
      if (!response.ok) {
        throw new Error('Failed to load trending tags')
      }

      const data = await response.json() as { tags: Array<{ tag: string; count: number; percentage: number }> }
      const tags = data.tags || []

      this.renderTrendingTags(tags)
    } catch (error) {
      console.error('Failed to load trending tags:', error)
    }
  }

  private renderPosts(): void {
    const postsContainer = this.element.querySelector('.explore-posts') as HTMLElement
    if (!postsContainer) return

    // Only clear and re-render if this is the initial load or if we need to refresh
    // For infinite scroll, we'll append new posts instead
    if (this.cursor === undefined || postsContainer.children.length === 0) {
      postsContainer.innerHTML = ''
      
      // Use document fragment for better performance
      const fragment = document.createDocumentFragment()
      
      this.posts.forEach(post => {
        const postCard = createPostCard({
          post,
          sandboxOrigin: this.props.sandboxOrigin
        })
        fragment.appendChild(postCard.getElement())
      })
      
      postsContainer.appendChild(fragment)
    }
  }

  private appendNewPosts(newPosts: Post[]): void {
    const postsContainer = this.element.querySelector('.explore-posts') as HTMLElement
    if (!postsContainer) return

    // Use document fragment for better performance
    const fragment = document.createDocumentFragment()
    
    newPosts.forEach(post => {
      const postCard = createPostCard({
        post,
        sandboxOrigin: this.props.sandboxOrigin
      })
      fragment.appendChild(postCard.getElement())
    })
    
    postsContainer.appendChild(fragment)
  }

  private renderTrendingTags(tags: Array<{ tag: string; count: number; percentage: number }>): void {
    const trendingContainer = this.element.querySelector('.explore-trending') as HTMLElement
    if (!trendingContainer) return

    trendingContainer.innerHTML = ''

    if (tags.length === 0) {
      trendingContainer.innerHTML = `
        <div style="text-align: center; padding: 2rem; color: var(--text-muted); font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
          No trending tags yet
        </div>
      `
      return
    }

    tags.forEach(({ tag, percentage }) => {
      const item = document.createElement('div')
      item.className = 'trending-item'
      item.style.cssText = `
        padding: 1rem;
        border-bottom: 1px solid var(--border);
        cursor: pointer;
        transition: background-color 0.2s ease;
      `

      const tagEl = document.createElement('div')
      tagEl.style.cssText = "font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: var(--accent); font-size: 1rem; font-weight: 600; margin-bottom: 0.25rem;"
      tagEl.textContent = `# ${tag}`

      const percentageEl = document.createElement('div')
      percentageEl.style.cssText = "font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: var(--text-muted); font-size: 0.875rem;"
      percentageEl.textContent = `${percentage}% trending`

      item.appendChild(tagEl)
      item.appendChild(percentageEl)

      item.onmouseover = () => item.style.background = 'var(--bg-secondary)'
      item.onmouseout = () => item.style.background = 'transparent'
      
      item.onclick = () => {
        window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(tag)}`)
        window.location.reload()
      }

      trendingContainer.appendChild(item)
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
      icon.textContent = '🎉'

      const title = document.createElement('div')
      title.textContent = "You've reached the end!"

      const subtitle = document.createElement('div')
      subtitle.style.cssText = 'font-size: 0.875rem; margin-top: 0.5rem;'
      subtitle.textContent = `No more posts with #${this.props.tag ?? ''}`

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
      title.textContent = 'Failed to load more posts'

      const retryBtn = document.createElement('button')
      retryBtn.textContent = 'Retry'
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
    // Only enable on mobile (< 768px)
    if (window.innerWidth > 768) return

    const SWIPE_THRESHOLD = 80 // Minimum horizontal distance
    const EDGE_THRESHOLD = 50  // Must start within this distance from left edge
    const MAX_VERTICAL_DEVIATION = 100 // Maximum vertical movement allowed
    const MAX_TIME = 500 // Maximum swipe duration in ms
    const TAP_THRESHOLD = 10 // Maximum movement for tap
    const TAP_TIME = 200 // Maximum time for tap

    this.element.addEventListener('touchstart', (e) => {
      const touch = e.touches[0]
      this.touchStartX = touch.clientX
      this.touchStartY = touch.clientY
      this.touchStartTime = Date.now()
    }, { passive: true })

    this.element.addEventListener('touchend', (e) => {
      const touch = e.changedTouches[0]
      const deltaX = touch.clientX - this.touchStartX
      const deltaY = touch.clientY - this.touchStartY
      const deltaTime = Date.now() - this.touchStartTime

      // Check if it's a valid right swipe from left edge
      if (
        deltaX > SWIPE_THRESHOLD && // Moving right
        Math.abs(deltaY) < MAX_VERTICAL_DEVIATION && // Not too much vertical movement
        deltaTime < MAX_TIME && // Quick swipe
        this.touchStartX < EDGE_THRESHOLD // Started near left edge
      ) {
        // Emit event to open left nav
        this.element.dispatchEvent(new CustomEvent('openLeftNav', {
          bubbles: true
        }))
        return
      }

      // Check if it's a tap at the left edge
      if (
        Math.abs(deltaX) < TAP_THRESHOLD && // Minimal horizontal movement
        Math.abs(deltaY) < TAP_THRESHOLD && // Minimal vertical movement
        deltaTime < TAP_TIME && // Quick tap
        this.touchStartX < EDGE_THRESHOLD // Tapped near left edge
      ) {
        // Emit event to open left nav
        this.element.dispatchEvent(new CustomEvent('openLeftNav', {
          bubbles: true
        }))
      }
    }, { passive: true })
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
