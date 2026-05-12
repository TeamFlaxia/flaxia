import { createSearchResults } from './SearchResults.js'
import { safeRemoveFromBody } from '../lib/dom-utils.js'

export interface RightPanelProps {
  onSearch?: (query: string) => void
  onFollowUser?: (userId: string) => void
}

export interface UserSuggestion {
  id: string
  username: string
  display_name: string
  avatar_key?: string
}

export class RightPanel {
  private element: HTMLElement
  private props: RightPanelProps
  private trendingTags: Array<{ tag: string; count: number; percentage: number }> = []
  private userSuggestions: UserSuggestion[] = []

  constructor(props: RightPanelProps = {}) {
    this.props = props
    this.element = this.createElement()
    this.setupEventListeners()
    this.loadTrendingTags()
    this.loadUserSuggestions()
  }

  private createElement(): HTMLElement {
    const container = document.createElement('aside')
    container.className = 'right-panel'

    // Search box
    const searchSection = this.createSearchSection()
    container.appendChild(searchSection)

    // Trending hashtags
    const trendingSection = this.createTrendingSection()
    container.appendChild(trendingSection)

    // Who to follow
    const followSection = this.createFollowSection()
    container.appendChild(followSection)

    // Admax ad section
    //const adSection = this.createAdSection()
    //container.appendChild(adSection)

    return container
  }

  private createSearchSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'search-section'

    const searchBox = document.createElement('div')
    searchBox.className = 'search-box'

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'search-input'
    input.placeholder = 'Search Flaxia'

    const icon = document.createElement('span')
    icon.className = 'search-icon'
    icon.textContent = '🔍'

    searchBox.appendChild(input)
    searchBox.appendChild(icon)
    section.appendChild(searchBox)

    return section
  }

  private createTrendingSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'trending-section'

    const title = document.createElement('h3')
    title.className = 'section-title'
    title.textContent = 'Trending'

    const list = document.createElement('div')
    list.className = 'trending-list'

    const loading = document.createElement('div')
    loading.className = 'trending-loading'
    loading.style.cssText = 'text-align: center; padding: 20px; color: var(--text-muted);'
    loading.textContent = 'Loading...'
    list.appendChild(loading)

    section.appendChild(title)
    section.appendChild(list)

    return section
  }

  private createFollowSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'follow-section'
    section.style.display = 'none' // Hidden by default, shown when we have suggestions

    const title = document.createElement('h3')
    title.className = 'section-title'
    title.textContent = 'Who to follow'

    const list = document.createElement('div')
    list.className = 'follow-list'

    const loading = document.createElement('div')
    loading.className = 'follow-loading'
    loading.style.cssText = 'text-align: center; padding: 20px; color: var(--text-muted);'
    loading.textContent = 'Loading...'
    list.appendChild(loading)

    section.appendChild(title)
    section.appendChild(list)

    return section
  }

  private createAdSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'ad-section'
    
    // Create iframe for isolated ad environment
    const iframe = document.createElement('iframe')
    iframe.style.width = '160px'
    iframe.style.height = '600px'
    iframe.style.border = 'none'
    iframe.style.margin = '0 auto'
    iframe.style.display = 'block'
    
    // Set up iframe content with Admax script
    iframe.onload = () => {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document
        if (iframeDoc) {
          iframeDoc.open()
          iframeDoc.write(`
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="utf-8">
              <style>
                body { margin: 0; padding: 0; width: 160px; height: 600px; overflow: hidden; }
              </style>
            </head>
            <body>
              <script src="https://adm.shinobi.jp/s/3c3cb145b843f9b7f75cf28c25df7b0e"></script>
            </body>
            </html>
          `)
          iframeDoc.close()
        }
      } catch (error) {
        console.error('Failed to setup iframe:', error)
      }
    }
    
    section.appendChild(iframe)
    
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

    // Follow buttons will be set up dynamically when user suggestions are loaded
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

  private async loadTrendingTags(): Promise<void> {
    try {
      const response = await fetch('/api/tags/trending')
      if (!response.ok) {
        throw new Error('Failed to load trending tags')
      }

      const data = await response.json() as { tags: Array<{ tag: string; count: number; percentage: number }> }
      this.trendingTags = data.tags || []
      this.renderTrendingTags()
    } catch (error) {
      console.error('Failed to load trending tags:', error)
    }
  }

  private renderTrendingTags(): void {
    const trendingList = this.element.querySelector('.trending-list')
    if (!trendingList) return

    trendingList.innerHTML = ''

    if (this.trendingTags.length === 0) {
      const emptyState = document.createElement('div')
      emptyState.style.cssText = 'padding: 20px; color: var(--text-muted); text-align: center;'
      emptyState.textContent = 'No trending tags yet'
      trendingList.appendChild(emptyState)
      return
    }

    this.trendingTags.forEach(({ tag, percentage }) => {
      const item = document.createElement('div')
      item.className = 'trending-item'
      item.style.cssText = `
        padding: 12px 0;
        cursor: pointer;
        transition: background 0.2s ease;
      `

      const content = document.createElement('div')
      content.className = 'trending-content'

      const hashtag = document.createElement('div')
      hashtag.className = 'trending-hashtag'
      hashtag.style.cssText = "font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: var(--accent); font-size: 15px; font-weight: 600;"
      hashtag.textContent = `# ${tag}`

      const count = document.createElement('div')
      count.className = 'trending-count'
      count.style.cssText = "font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: var(--text-muted); font-size: 13px;"
      count.textContent = `${percentage}% trending`

      content.appendChild(hashtag)
      content.appendChild(count)
      item.appendChild(content)

      item.addEventListener('click', () => {
        window.location.href = `/explore?tag=${encodeURIComponent(tag)}`
      })

      item.addEventListener('mouseenter', () => {
        item.style.background = 'var(--bg-secondary)'
      })

      item.addEventListener('mouseleave', () => {
        item.style.background = 'transparent'
      })

      trendingList.appendChild(item)
    })
  }

  private async loadUserSuggestions(): Promise<void> {
    try {
      const response = await fetch('/api/users/suggestions')
      if (!response.ok) {
        throw new Error('Failed to load user suggestions')
      }

      const data = await response.json() as { users: UserSuggestion[] }
      this.userSuggestions = data.users || []
      this.renderUserSuggestions()
    } catch (error) {
      console.error('Failed to load user suggestions:', error)
    }
  }

  private renderUserSuggestions(): void {
    const followSection = this.element.querySelector('.follow-section') as HTMLElement
    const followList = this.element.querySelector('.follow-list')
    
    if (!followSection || !followList) return

    // Hide section for guests or when no suggestions
    if (this.userSuggestions.length === 0) {
      followSection.style.display = 'none'
      return
    }

    // Show section and render suggestions
    followSection.style.display = 'block'
    followList.innerHTML = ''

    this.userSuggestions.forEach(user => {
      const item = document.createElement('div')
      item.className = 'follow-item'
      item.dataset.userId = user.id
      
      // Create avatar element
      const avatar = document.createElement('div')
      avatar.className = 'follow-avatar'
      avatar.style.cssText = `
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: var(--bg-secondary);
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
        color: var(--text-primary);
        background-image: ${user.avatar_key ? `url('/api/images/${user.avatar_key}')` : 'none'};
        background-size: cover;
        background-position: center;
      `
      
      if (!user.avatar_key) {
        avatar.textContent = user.display_name.charAt(0).toUpperCase()
        avatar.style.background = `linear-gradient(135deg, #${Math.floor(Math.random()*16777215).toString(16)} 0%, #${Math.floor(Math.random()*16777215).toString(16)} 100%)`
      }

      // Create info container
      const info = document.createElement('div')
      info.className = 'follow-info'
      info.style.cssText = `
        flex: 1;
        min-width: 0;
      `

      const name = document.createElement('div')
      name.className = 'follow-name'
      name.style.cssText = `
        font-weight: 600;
        color: var(--text-primary);
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      `
      name.textContent = user.display_name
      name.addEventListener('click', () => {
        window.location.href = `/profile/${user.username}`
      })

      const handle = document.createElement('div')
      handle.className = 'follow-handle'
      handle.style.cssText = `
        font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: var(--text-muted);
        font-size: 13px;
      `
      handle.textContent = `@${user.username}`

      info.appendChild(name)
      info.appendChild(handle)

      // Create follow button
      const button = document.createElement('button')
      button.className = 'follow-button'
      button.style.cssText = `
        padding: 6px 16px;
        border-radius: 20px;
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s ease;
      `
      button.textContent = 'Follow'
      
      button.addEventListener('click', async (e) => {
        e.preventDefault()
        await this.followUser(user.id, item)
      })

      button.addEventListener('mouseenter', () => {
        button.style.background = 'var(--accent)'
        button.style.color = 'white'
        button.style.borderColor = 'var(--accent)'
      })

      button.addEventListener('mouseleave', () => {
        button.style.background = 'var(--bg-primary)'
        button.style.color = 'var(--text-primary)'
        button.style.borderColor = 'var(--border)'
      })

      // Assemble the item
      item.style.cssText = `
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 0;
        border-bottom: 1px solid var(--border);
        transition: opacity 0.3s ease, transform 0.3s ease;
      `
      
      item.appendChild(avatar)
      item.appendChild(info)
      item.appendChild(button)

      followList.appendChild(item)
    })
  }

  private async followUser(userId: string, itemElement: HTMLElement): Promise<void> {
    try {
      const response = await fetch(`/api/follows/${userId}`, {
        method: 'POST',
        credentials: 'include'
      })

      if (!response.ok) {
        throw new Error('Failed to follow user')
      }

      // Remove user from suggestions and fade out the item
      this.userSuggestions = this.userSuggestions.filter(user => user.id !== userId)
      
      // Fade out animation
      itemElement.style.opacity = '0'
      itemElement.style.transform = 'translateX(20px)'
      
      setTimeout(() => {
        itemElement.remove()
        
        // If no more suggestions, hide the entire section
        if (this.userSuggestions.length === 0) {
          const followSection = this.element.querySelector('.follow-section') as HTMLElement
          if (followSection) {
            followSection.style.display = 'none'
          }
        }
      }, 300)

    } catch (error) {
      console.error('Failed to follow user:', error)
    }
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public destroy(): void {
    this.element.remove()
  }
}

// Factory function for easier usage
export function createRightPanel(props: RightPanelProps = {}): RightPanel {
  return new RightPanel(props)
}
