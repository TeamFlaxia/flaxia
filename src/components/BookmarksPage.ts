import { createPostCard } from './PostCard.js'
import { Post } from '../types/post.js'
import { createSkeletonCard } from './SkeletonCard.js'
import { t } from '../lib/i18n.js'
import { openPostModal } from '../lib/post-modal.js'

export interface BookmarksPageProps {
  sandboxOrigin: string
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null
}

export class BookmarksPage {
  private element: HTMLElement
  private props: BookmarksPageProps
  private posts: Post[] = []
  private cursor?: string
  private loading = false
  private hasMore = true
  private error: string | null = null
  private intersectionObserver: IntersectionObserver | null = null
  private loadMoreSentinel: HTMLElement | null = null
  private fabButton: HTMLElement | null = null

  constructor(props: BookmarksPageProps) {
    this.props = props
    this.element = this.createElement()
    this.loadContent()
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'bookmarks-page'

    const header = document.createElement('div')
    header.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 1rem;
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--bg-primary);
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
    `
    backBtn.addEventListener('mouseenter', () => { backBtn.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))' })
    backBtn.addEventListener('mouseleave', () => { backBtn.style.background = 'none' })
    backBtn.addEventListener('click', () => window.history.back())

    const title = document.createElement('h1')
    title.textContent = t('nav.bookmarks')
    title.style.cssText = `
      margin: 0;
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--text-primary);
    `

    header.appendChild(backBtn)
    header.appendChild(title)
    container.appendChild(header)

    const postsContainer = document.createElement('div')
    postsContainer.className = 'bookmarks-posts'
    postsContainer.style.width = '100%'
    container.appendChild(postsContainer)

    const loadingContainer = document.createElement('div')
    loadingContainer.className = 'bookmarks-loading'
    loadingContainer.style.display = 'none'
    container.appendChild(loadingContainer)

    this.loadMoreSentinel = document.createElement('div')
    this.loadMoreSentinel.className = 'bookmarks-sentinel'
    this.loadMoreSentinel.style.cssText = 'height: 100px; width: 100%;'
    container.appendChild(this.loadMoreSentinel)

    if (this.props.currentUser) {
      this.fabButton = document.createElement('button')
      this.fabButton.className = 'timeline-fab visible'
      this.fabButton.textContent = '+'
      this.fabButton.addEventListener('click', () => {
        openPostModal({
          currentUser: this.props.currentUser,
          onPostCreated: () => {}
        })
      })
      container.appendChild(this.fabButton)
    }

    return container
  }

  private async loadContent(): Promise<void> {
    if (this.loading) return
    this.loading = true
    this.error = null
    this.hideError()
    this.updateLoadingState(true)

    try {
      let url = `/api/bookmarks?limit=10`
      if (this.cursor) url += `&cursor=${encodeURIComponent(this.cursor)}`

      const response = await fetch(url, { credentials: 'include' })
      if (!response.ok) throw new Error('Failed to load bookmarks')

      const data = await response.json() as { posts: Post[]; nextCursor?: string }
      const newPosts = data.posts || []

      if (newPosts.length > 0) {
        this.posts.push(...newPosts)
        this.cursor = newPosts[newPosts.length - 1].created_at
        this.hasMore = newPosts.length === 10
        this.renderPosts()
        if (!this.intersectionObserver) this.setupIntersectionObserver()
      } else {
        this.hasMore = false
        if (this.posts.length === 0) this.showEmpty()
      }
    } catch (error) {
      console.error('Failed to load bookmarks:', error)
      this.error = t('bookmarks.error') || 'Failed to load bookmarks. Please try again.'
      this.showError()
    } finally {
      this.loading = false
      this.updateLoadingState(false)
    }
  }

  private renderPosts(): void {
    const postsContainer = this.element.querySelector('.bookmarks-posts') as HTMLElement
    if (!postsContainer) return

    const fragment = document.createDocumentFragment()
    const startIndex = postsContainer.children.length

    for (let i = startIndex; i < this.posts.length; i++) {
      try {
        const postCard = createPostCard({
          post: this.posts[i],
          sandboxOrigin: this.props.sandboxOrigin,
          currentUser: this.props.currentUser || undefined,
          depth: this.posts[i].depth
        })
        fragment.appendChild(postCard.getElement())
      } catch (err) {
        console.error('Failed to render bookmark post:', err)
      }
    }

    postsContainer.appendChild(fragment)
  }

  private showEmpty(): void {
    const postsContainer = this.element.querySelector('.bookmarks-posts') as HTMLElement
    const empty = document.createElement('div')
    empty.style.cssText = `
      text-align: center;
      padding: 48px 24px;
      color: var(--text-muted);
    `
    empty.textContent = t('bookmarks.empty') || 'No bookmarks yet'
    if (postsContainer) {
      postsContainer.appendChild(empty)
    } else {
      this.element.appendChild(empty)
    }
  }

  private showError(): void {
    const existing = this.element.querySelector('.bookmarks-error')
    if (existing) return

    const errorEl = document.createElement('div')
    errorEl.className = 'bookmarks-error'
    errorEl.style.cssText = `
      text-align: center;
      padding: 48px 24px;
      color: var(--text-muted);
    `
    const msg = document.createElement('p')
    msg.textContent = this.error
    msg.style.marginBottom = '16px'

    const retryBtn = document.createElement('button')
    retryBtn.textContent = t('bookmarks.retry') || 'Retry'
    retryBtn.style.cssText = `
      padding: 8px 20px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--bg-primary);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 0.875rem;
      transition: background 0.2s;
    `
    retryBtn.addEventListener('mouseenter', () => { retryBtn.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))' })
    retryBtn.addEventListener('mouseleave', () => { retryBtn.style.background = 'var(--bg-primary)' })
    retryBtn.addEventListener('click', () => {
      this.posts = []
      this.cursor = undefined
      this.hasMore = true
      const postsContainer = this.element.querySelector('.bookmarks-posts')
      if (postsContainer) postsContainer.innerHTML = ''
      this.loadContent()
    })

    errorEl.appendChild(msg)
    errorEl.appendChild(retryBtn)
    this.element.appendChild(errorEl)
  }

  private hideError(): void {
    const el = this.element.querySelector('.bookmarks-error')
    if (el) el.remove()
  }

  private updateLoadingState(isLoading: boolean): void {
    const loadingElement = this.element.querySelector('.bookmarks-loading') as HTMLElement
    if (loadingElement) {
      loadingElement.style.display = isLoading ? 'block' : 'none'
      if (isLoading && this.posts.length === 0) {
        loadingElement.innerHTML = ''
        for (let i = 0; i < 2; i++) {
          loadingElement.appendChild(createSkeletonCard())
        }
      }
    }
  }

  private setupIntersectionObserver(): void {
    if (!this.loadMoreSentinel) return
    if (this.intersectionObserver) this.intersectionObserver.disconnect()

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !this.loading && this.hasMore) {
          this.loadContent()
        }
      },
      { rootMargin: '300px', threshold: 0.1 }
    )

    this.intersectionObserver.observe(this.loadMoreSentinel)
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public destroy(): void {
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect()
      this.intersectionObserver = null
    }
  }
}

export function createBookmarksPage(props: BookmarksPageProps): BookmarksPage {
  return new BookmarksPage(props)
}
