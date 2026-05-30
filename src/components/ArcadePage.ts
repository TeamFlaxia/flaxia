import { executeFlash } from './FlashPlayer.js'
import { executeDos } from './DosPlayer.js'
import { executeWvfsZip } from '../lib/wvfs-zip-client.js'
import type { Game, ArcadePageProps, GameType } from '../types/game.js'
import type { Post } from '../types/post.js'
import { t } from '../lib/i18n.js'
import { formatCount } from '../lib/format.js'
import { showSignInPrompt } from './SignInPrompt.js'
import { createReplyComposer } from './ReplyComposer.js'
import { createPostCard } from './PostCard.js'
import { registerModal } from '../lib/modal-state.js'

export interface ArcadePageHandle {
  destroy: () => void
  getElement: () => HTMLElement
}

export class ArcadePage {
  private element: HTMLElement
  private props: ArcadePageProps
  private games: Game[] = []
  private currentIndex: number = 0
  private isLoading: boolean = false
  private hasMore: boolean = true
  private shuffleToken: string | null = null
  private shuffleOffset: number = 0
  private hasMoreShuffle: boolean = true
  private isLoadingMore: boolean = false
  private gameContainer: HTMLElement
  private floatingActions: HTMLElement | null = null
  private currentGameHandle: { destroy: () => void } | null = null
  private touchStartY: number = 0
  private touchEndY: number = 0
  private touchStartX: number = 0
  private touchEndX: number = 0
  private touchStartTime: number = 0
  private isTransitioning: boolean = false
  private isDragging: boolean = false
  private dragStartY: number = 0
  private currentTranslateY: number = 0
  private prevTranslateY: number = 0
  private animationID: number | null = null
  private swipeVelocity: number = 0
  private currentViewport: HTMLElement | null = null
  private initialGameId: string | undefined
  private tutorialEl: HTMLElement | null = null

  private static TUTORIAL_SEEN_KEY = 'flaxia_tutorial_seen'
  
  // Store bound event handlers for proper cleanup
  private boundHandleTouchStart: (e: TouchEvent) => void
  private boundHandleTouchMove: (e: TouchEvent) => void
  private boundHandleTouchEnd: (e: TouchEvent) => void
  private boundHandleMouseDown: (e: MouseEvent) => void
  private boundHandleMouseMove: (e: MouseEvent) => void
  private boundHandleMouseUp: (e: MouseEvent) => void
  private boundHandleMouseLeave: (e: MouseEvent) => void

  constructor(props: ArcadePageProps) {
    this.props = props
    this.initialGameId = props.initialGameId
    this.element = this.createElement()
    this.gameContainer = this.element.querySelector('.arcade-game-container') as HTMLElement
    
    // Initialize bound event handlers for proper cleanup
    this.boundHandleTouchStart = this.handleTouchStart.bind(this)
    this.boundHandleTouchMove = this.handleTouchMove.bind(this)
    this.boundHandleTouchEnd = this.handleTouchEnd.bind(this)
    this.boundHandleMouseDown = this.handleMouseDown.bind(this)
    this.boundHandleMouseMove = this.handleMouseMove.bind(this)
    this.boundHandleMouseUp = this.handleMouseUp.bind(this)
    this.boundHandleMouseLeave = this.handleMouseUp.bind(this)
    
    this.setupEventListeners()
    this.setupLeftNavSwipeDetection()
    this.loadGames()

    if (!localStorage.getItem(ArcadePage.TUTORIAL_SEEN_KEY)) {
      this.showTutorial()
    }
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'arcade-page'
    container.style.cssText = `
      flex: 1;
      display: flex;
      flex-direction: column;
      height: 100vh;
      height: 100dvh;
      overflow: hidden;
      background: var(--bg-primary);
      position: relative;
    `

    // Header
    const header = document.createElement('div')
    header.className = 'arcade-header'
    header.style.cssText = `
      padding: 1rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    `

    if (this.props.onBack) {
      const backBtn = document.createElement('button')
      backBtn.className = 'arcade-back-btn'
      backBtn.textContent = '←'
      backBtn.title = t('common.back')
      backBtn.style.cssText = `
        background: none;
        border: none;
        font-size: 1.5rem;
        cursor: pointer;
        color: var(--text-primary);
        padding: 0.25rem 0.5rem;
        border-radius: 4px;
        line-height: 1;
        transition: background 0.2s;
      `
      backBtn.addEventListener('mouseenter', () => { backBtn.style.background = 'var(--bg-hover, rgba(255,255,255,0.1))' })
      backBtn.addEventListener('mouseleave', () => { backBtn.style.background = 'none' })
      backBtn.addEventListener('click', () => this.props.onBack?.())
      header.appendChild(backBtn)
    }

    const titleGroup = document.createElement('div')
    titleGroup.style.cssText = 'display: flex; flex-direction: column;'

    const title = document.createElement('h1')
    title.textContent = t('arcade.title')
    title.style.cssText = `
      margin: 0;
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
    `

    const subtitle = document.createElement('span')
    subtitle.textContent = t('arcade.subtitle')
    subtitle.style.cssText = `
      font-size: 0.875rem;
      white-space: nowrap;
      color: var(--text-muted);
    `

    titleGroup.appendChild(title)
    titleGroup.appendChild(subtitle)
    header.appendChild(titleGroup)

    // Spacer to push tutorial button to the right
    const headerSpacer = document.createElement('div')
    headerSpacer.style.cssText = 'flex: 1;'

    // Tutorial button
    const tutorialBtn = document.createElement('button')
    tutorialBtn.textContent = t('arcade.tutorial_btn')
    tutorialBtn.title = 'Tutorial'
    tutorialBtn.style.cssText = `
      background: none;
      border: none;
      font-size: 1.2rem;
      cursor: pointer;
      color: var(--text-muted);
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      line-height: 1;
      transition: color 0.2s, background 0.2s;
    `
    tutorialBtn.addEventListener('mouseenter', () => {
      tutorialBtn.style.color = 'var(--text-primary)'
      tutorialBtn.style.background = 'var(--bg-hover, rgba(255,255,255,0.1))'
    })
    tutorialBtn.addEventListener('mouseleave', () => {
      tutorialBtn.style.color = 'var(--text-muted)'
      tutorialBtn.style.background = 'none'
    })
    tutorialBtn.addEventListener('click', () => this.showTutorial())

    header.appendChild(headerSpacer)
    header.appendChild(tutorialBtn)

    // Game container (vertical scroll area)
    const gameContainer = document.createElement('div')
    gameContainer.className = 'arcade-game-container'
    gameContainer.style.cssText = `
      flex: 1;
      position: relative;
      overflow: hidden;
    `

    // Navigation arrows
    const navUp = document.createElement('button')
    navUp.className = 'arcade-nav arcade-nav-up'
    navUp.innerHTML = '▲'
    navUp.style.cssText = `
      position: absolute;
      top: 1rem;
      left: 50%;
      transform: translateX(-50%);
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: none;
      background: rgba(0, 0, 0, 0.5);
      color: white;
      font-size: 1.25rem;
      cursor: pointer;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.7;
      transition: opacity 0.2s;
    `
    navUp.addEventListener('mouseenter', () => navUp.style.opacity = '1')
    navUp.addEventListener('mouseleave', () => navUp.style.opacity = '0.7')
    navUp.addEventListener('click', () => this.navigateToPrevious())

    const navDown = document.createElement('button')
    navDown.className = 'arcade-nav arcade-nav-down'
    navDown.innerHTML = '▼'
    navDown.style.cssText = `
      position: absolute;
      bottom: 1rem;
      left: 50%;
      transform: translateX(-50%);
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: none;
      background: rgba(0, 0, 0, 0.5);
      color: white;
      font-size: 1.25rem;
      cursor: pointer;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.7;
      transition: opacity 0.2s;
    `
    navDown.addEventListener('mouseenter', () => navDown.style.opacity = '1')
    navDown.addEventListener('mouseleave', () => navDown.style.opacity = '0.7')
    navDown.addEventListener('click', () => this.navigateToNext())

    // Loading indicator
    const loadingIndicator = document.createElement('div')
    loadingIndicator.className = 'arcade-loading'
    loadingIndicator.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 1.5rem;
      color: var(--text-muted);
      display: none;
    `
    loadingIndicator.textContent = t('arcade.loading')

    gameContainer.appendChild(navUp)
    gameContainer.appendChild(navDown)
    gameContainer.appendChild(loadingIndicator)

    // Empty state
    const emptyState = document.createElement('div')
    emptyState.className = 'arcade-empty'
    emptyState.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      color: var(--text-muted);
      display: none;
    `
    emptyState.innerHTML = `
      <div style="font-size: 4rem; margin-bottom: 1rem;">🎮</div>
      <div style="font-size: 1.25rem; margin-bottom: 0.5rem;">${t('arcade.no_games_title')}</div>
      <div style="font-size: 0.875rem;">${t('arcade.no_games_subtitle')}</div>
    `
    gameContainer.appendChild(emptyState)

    container.appendChild(header)
    container.appendChild(gameContainer)

    return container
  }

  private setupEventListeners(): void {
    // Enhanced touch/swipe support - listen on entire document
    document.addEventListener('touchstart', this.boundHandleTouchStart, { passive: true })

    document.addEventListener('touchmove', this.boundHandleTouchMove, { passive: false })

    document.addEventListener('touchend', this.boundHandleTouchEnd, { passive: true })

    // Mouse support for desktop testing - listen on entire document
    document.addEventListener('mousedown', this.boundHandleMouseDown, { passive: true })

    document.addEventListener('mousemove', this.boundHandleMouseMove, { passive: false })

    document.addEventListener('mouseup', this.boundHandleMouseUp, { passive: true })

    document.addEventListener('mouseleave', this.boundHandleMouseLeave, { passive: true })

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (this.tutorialEl) return
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        this.navigateToPrevious()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        this.navigateToNext()
      }
    })

    // Wheel/trackpad support with debouncing
    let wheelTimeout: number | null = null
    this.gameContainer.addEventListener('wheel', (e) => {
      if (this.tutorialEl) return
      if (this.isTransitioning) return
      
      e.preventDefault()
      
      if (wheelTimeout) {
        clearTimeout(wheelTimeout)
      }
      
      wheelTimeout = window.setTimeout(() => {
        if (e.deltaY > 0) {
          this.navigateToNext()
        } else if (e.deltaY < 0) {
          this.navigateToPrevious()
        }
      }, 50)
    }, { passive: false })
  }

  private setupLeftNavSwipeDetection(): void {
    // This method is no longer needed as left nav detection is integrated into existing touch handlers
  }

  private isLeftNavOpen(): boolean {
    const leftNav = document.querySelector('.left-nav')
    return leftNav?.classList.contains('left-nav--open') ?? false
  }

  private handleTouchStart(e: TouchEvent): void {
    if (this.commentPanel) return
    if (this.isLeftNavOpen()) return
    if (this.tutorialEl) return
    this.touchStartY = e.touches[0].clientY
    this.touchStartX = e.touches[0].clientX
    this.touchStartTime = Date.now()
    this.isDragging = true
    this.dragStartY = this.touchStartY
    this.currentViewport = this.gameContainer.querySelector('.arcade-viewport') as HTMLElement
    
    if (this.currentViewport) {
      this.prevTranslateY = this.currentTranslateY
      this.cancelAnimation()
    }
  }

  private handleTouchMove(e: TouchEvent): void {
    if (this.commentPanel) return
    if (this.isLeftNavOpen()) return
    if (this.tutorialEl) return
    if (!this.isDragging || this.isTransitioning) return
    
    e.preventDefault()
    const currentY = e.touches[0].clientY
    const diff = currentY - this.dragStartY
    
    // Add visual feedback during swipe
    if (this.currentViewport) {
      this.currentTranslateY = this.prevTranslateY + diff
      this.updateViewportTransform()
    }
    
    // Calculate velocity for momentum
    const currentTime = Date.now()
    const timeDiff = currentTime - this.touchStartTime
    if (timeDiff > 0) {
      this.swipeVelocity = diff / timeDiff
    }
  }

  private handleTouchEnd(e: TouchEvent): void {
    if (this.commentPanel) return
    if (this.isLeftNavOpen()) return
    if (this.tutorialEl) return
    if (!this.isDragging) return
    
    this.touchEndY = e.changedTouches[0].clientY
    this.touchEndX = e.changedTouches[0].clientX
    this.isDragging = false
    
    const touchDuration = Date.now() - this.touchStartTime
    const diffY = this.touchStartY - this.touchEndY
    const diffX = this.touchStartX - this.touchEndX
    
    // Left edge gestures for opening navigation are disabled on mobile.
    // Navigation should be opened only by the explicit menu button.
    if (window.innerWidth <= 768) {
      // No-op.
    }
    
    // Enhanced swipe detection with velocity and distance thresholds
    const minDistance = 30
    const minVelocity = 0.3
    
    if (Math.abs(diffY) > minDistance || Math.abs(this.swipeVelocity) > minVelocity) {
      // Prioritize vertical swipe
      if (Math.abs(diffY) > Math.abs(diffX)) {
        if (diffY > 0 || this.swipeVelocity < -minVelocity) {
          // Swipe up (下から上) - go to next game
          this.animateToNext()
        } else {
          // Swipe down (上から下) - go to previous game
          this.animateToPrevious()
        }
      } else {
        // Horizontal swipe - could be used for other actions
        this.resetViewportPosition()
      }
    } else {
      // Not a valid swipe - animate back to position
      this.resetViewportPosition()
    }
    
    this.swipeVelocity = 0
  }

  private handleMouseDown(e: MouseEvent): void {
    if (this.commentPanel) return
    if (this.isLeftNavOpen()) return
    if (this.tutorialEl) return
    this.touchStartY = e.clientY
    this.touchStartX = e.clientX
    this.touchStartTime = Date.now()
    this.isDragging = true
    this.dragStartY = this.touchStartY
    this.currentViewport = this.gameContainer.querySelector('.arcade-viewport') as HTMLElement
    
    if (this.currentViewport) {
      this.prevTranslateY = this.currentTranslateY
      this.cancelAnimation()
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    if (this.commentPanel) return
    if (this.isLeftNavOpen()) return
    if (this.tutorialEl) return
    if (!this.isDragging || this.isTransitioning) return
    
    e.preventDefault()
    const currentY = e.clientY
    const diff = currentY - this.dragStartY
    
    if (this.currentViewport) {
      this.currentTranslateY = this.prevTranslateY + diff
      this.updateViewportTransform()
    }
    
    const currentTime = Date.now()
    const timeDiff = currentTime - this.touchStartTime
    if (timeDiff > 0) {
      this.swipeVelocity = diff / timeDiff
    }
  }

  private handleMouseUp(e: MouseEvent): void {
    if (this.commentPanel) return
    if (this.isLeftNavOpen()) return
    if (this.tutorialEl) return
    if (!this.isDragging) return
    
    this.touchEndY = e.clientY
    this.touchEndX = e.clientX
    this.isDragging = false
    
    const touchDuration = Date.now() - this.touchStartTime
    const diffY = this.touchStartY - this.touchEndY
    const diffX = this.touchStartX - this.touchEndX
    
    const minDistance = 30
    const minVelocity = 0.3
    
    if (Math.abs(diffY) > minDistance || Math.abs(this.swipeVelocity) > minVelocity) {
      if (Math.abs(diffY) > Math.abs(diffX)) {
        if (diffY > 0 || this.swipeVelocity < -minVelocity) {
          // Swipe up (下から上) - go to next game
          this.animateToNext()
        } else {
          // Swipe down (上から下) - go to previous game
          this.animateToPrevious()
        }
      } else {
        this.resetViewportPosition()
      }
    } else {
      this.resetViewportPosition()
    }
    
    this.swipeVelocity = 0
  }

  private async loadGames(): Promise<void> {
    if (this.isLoading) return
    this.isLoading = true

    const loadingIndicator = this.element.querySelector('.arcade-loading') as HTMLElement
    loadingIndicator.style.display = 'block'

    try {
      let url = '/api/games?shuffle=true'
      if (this.initialGameId) {
        url += `&initialId=${encodeURIComponent(this.initialGameId)}`
      }
      const response = await fetch(url, { credentials: 'include' })
      if (response.ok) {
        const data = await response.json() as { games: Game[]; hasMore?: boolean; token?: string; offset?: number }
        this.games = data.games || []
        this.hasMore = data.hasMore || false
        this.shuffleToken = data.token || null
        this.shuffleOffset = data.offset || 0
        this.hasMoreShuffle = data.hasMore || false

        if (this.games.length > 0) {
          if (this.initialGameId) {
            const gameIndex = this.games.findIndex(game => game.id === this.initialGameId)
            if (gameIndex !== -1) {
              this.currentIndex = gameIndex
            } else {
              console.warn(`Game ${this.initialGameId} not found, showing first game`)
            }
          }
          this.renderCurrentGame()
        } else {
          this.showEmptyState()
        }
      } else {
        this.showEmptyState()
      }
    } catch (error) {
      console.error('Failed to load games:', error)
      this.showEmptyState()
    } finally {
      this.isLoading = false
      loadingIndicator.style.display = 'none'
    }
  }

  private async loadMoreGames(): Promise<void> {
    if (this.isLoadingMore || !this.hasMoreShuffle) return
    this.isLoadingMore = true

    try {
      const response = await fetch(
        `/api/games?shuffle=true&token=${this.shuffleToken}&offset=${this.shuffleOffset}`,
        { credentials: 'include' }
      )
      if (response.ok) {
        const data = await response.json() as { games: Game[]; hasMore?: boolean; token?: string; offset?: number }
        if (data.games && data.games.length > 0) {
          this.games.push(...data.games)
        }
        this.shuffleToken = data.token || null
        this.shuffleOffset = data.offset || 0
        this.hasMoreShuffle = data.hasMore || false
      }
    } catch (error) {
      console.error('Failed to load more games:', error)
    } finally {
      this.isLoadingMore = false
    }
  }

  private showEmptyState(): void {
    const emptyState = this.element.querySelector('.arcade-empty') as HTMLElement
    emptyState.style.display = 'block'
  }

  private renderCurrentGame(): void {
    if (this.currentIndex >= this.games.length) return

    const game = this.games[this.currentIndex]
    
    // Clear previous game
    this.clearCurrentGame()

    // Create game viewport with initial animation state
    const viewport = document.createElement('div')
    viewport.className = 'arcade-viewport'
    viewport.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      flex-direction: column;
      background: #000;
      transform: translateY(100%);
      opacity: 0;
      transition: transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.4s ease;
    `

    // Game info overlay
    const infoOverlay = document.createElement('div')
    infoOverlay.className = 'arcade-game-info'
    infoOverlay.style.cssText = `
      position: absolute;
      bottom: 80px;
      left: 1rem;
      right: 100px;
      z-index: 5;
      color: white;
      text-shadow: 0 2px 4px rgba(0,0,0,0.8);
    `

    const gameTitle = document.createElement('div')
    gameTitle.style.cssText = `
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 0.25rem;
    `
    gameTitle.textContent = game.title || t('arcade.game_by', { username: game.username })

    const gameAuthor = document.createElement('div')
    gameAuthor.style.cssText = `
      font-size: 0.875rem;
      opacity: 0.9;
    `
    gameAuthor.textContent = t('arcade.game_author', { username: game.username })

    infoOverlay.appendChild(gameTitle)
    infoOverlay.appendChild(gameAuthor)

    // Game execution area
    const gameArea = document.createElement('div')
    gameArea.className = 'arcade-game-area'
    gameArea.style.cssText = `
      flex: 1;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    `

    viewport.appendChild(gameArea)
    viewport.appendChild(infoOverlay)

    // Floating action buttons
    this.floatingActions = this.createFloatingActions(game)
    viewport.appendChild(this.floatingActions)

    this.gameContainer.appendChild(viewport)
    this.currentViewport = viewport

    // Execute the game
    this.executeGame(game, gameArea)

    // Animate in the new game
    requestAnimationFrame(() => {
      viewport.style.transform = 'translateY(0)'
      viewport.style.opacity = '1'
    })

    // Preload next game if available
    if (this.currentIndex < this.games.length - 1) {
      this.preloadNextGame()
    }
  }

  private createFloatingActions(game: Game): HTMLElement {
    const container = document.createElement('div')
    container.className = 'arcade-floating-actions'
    container.style.cssText = `
      position: absolute;
      right: 1rem;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      flex-direction: column;
      gap: 1rem;
      z-index: 10;
    `

    // Fresh button
    const freshBtn = this.createActionButton('🍃', formatCount(game.freshCount || 0), () => this.handleFresh(), game.isFreshed || false, 'font-size: 0.875rem; font-weight: 700; background: rgba(255,255,255,0.12); padding: 0 6px; border-radius: 8px; line-height: 1.4;')
    freshBtn.dataset.tutorial = 'fresh'

    // Fullscreen button
    const fullscreenBtn = this.createActionButton('⛶', t('arcade.fullscreen'), () => this.handleFullscreen())
    fullscreenBtn.dataset.tutorial = 'fullscreen'

    // Comments button
    const commentsBtn = this.createActionButton('💬', formatCount(game.replyCount || 0), () => this.handleComments())
    commentsBtn.dataset.tutorial = 'comments'

    container.appendChild(freshBtn)
    container.appendChild(fullscreenBtn)
    container.appendChild(commentsBtn)

    return container
  }

  private commentPanel: HTMLElement | null = null
  private commentModalUnregister: (() => void) | null = null
  private commentPanelKeyHandler: ((e: KeyboardEvent) => void) | null = null
  private commentListEl: HTMLElement | null = null

  private handleComments(): void {
    const game = this.games[this.currentIndex]
    if (!game) return

    if (this.commentPanel) {
      this.closeCommentPanel()
      return
    }

    this.commentModalUnregister = registerModal()

    const overlay = document.createElement('div')
    this.commentPanel = overlay
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    `
    document.body.appendChild(overlay)

    const dialog = document.createElement('div')
    dialog.style.cssText = `
      background: var(--bg-primary);
      border-radius: 12px;
      max-width: 500px;
      width: 90%;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    `
    overlay.appendChild(dialog)

    // Header
    const header = document.createElement('div')
    header.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    `
    const headerTitle = document.createElement('span')
    headerTitle.style.cssText = 'font-weight: 600; font-size: 0.95rem; color: var(--text-primary);'
    headerTitle.textContent = `${t('thread_view.title')} (${formatCount(game.replyCount || 0)})`
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '✕'
    closeBtn.style.cssText = 'background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 1.1rem; padding: 0.25rem;'
    closeBtn.addEventListener('click', () => this.closeCommentPanel())
    header.appendChild(headerTitle)
    header.appendChild(closeBtn)
    dialog.appendChild(header)

    // Reply composer
    const composer = createReplyComposer({
      postId: game.postId,
      sandboxOrigin: this.props.sandboxOrigin,
      onReplyCreated: (newReply) => this.handleCommentCreated(newReply, headerTitle, composer),
      onCancel: () => {}
    })
    composer.getElement().style.cssText = 'flex-shrink: 0;'
    dialog.appendChild(composer.getElement())

    // Replies list
    const list = document.createElement('div')
    this.commentListEl = list
    list.style.cssText = 'flex: 1; overflow-y: auto; padding: 0.5rem 0;'
    const loading = document.createElement('div')
    loading.style.cssText = 'text-align: center; padding: 2rem; color: var(--text-muted); font-size: 0.85rem;'
    loading.textContent = t('common.loading')
    list.appendChild(loading)
    dialog.appendChild(list)

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        this.closeCommentPanel()
      }
    })

    // Close on Escape
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeCommentPanel()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    this.commentPanelKeyHandler = onKeyDown

    // Fetch replies
    this.loadComments(game.postId, list, headerTitle)
  }

  private async loadComments(postId: string, list: HTMLElement, headerTitle: HTMLElement): Promise<void> {
    try {
      const res = await fetch(`/api/posts/${postId}/thread`)
      if (!res.ok) throw new Error('Failed to load comments')
      const data = await res.json() as { root: Post; replies: Post[] }

      list.innerHTML = ''
      if (data.replies.length === 0) {
        const empty = document.createElement('div')
        empty.style.cssText = 'text-align: center; padding: 2rem; color: var(--text-muted); font-size: 0.85rem;'
        empty.textContent = 'No comments yet'
        list.appendChild(empty)
      } else {
        for (const reply of data.replies) {
          const card = createPostCard({
            post: reply,
            sandboxOrigin: this.props.sandboxOrigin,
            currentUser: this.props.currentUser || undefined,
            depth: reply.depth,
            onDelete: () => {}
          })
          list.appendChild(card.getElement())
        }
      }
    } catch {
      list.innerHTML = ''
      const err = document.createElement('div')
      err.style.cssText = 'text-align: center; padding: 2rem; color: var(--danger); font-size: 0.85rem;'
      err.textContent = t('common.error')
      list.appendChild(err)
    }
  }

  private handleCommentCreated(newReply: Post, headerTitle: HTMLElement, composer: any): void {
    const game = this.games[this.currentIndex]
    if (game) {
      game.replyCount = (game.replyCount || 0) + 1
      headerTitle.textContent = `${t('thread_view.title')} (${formatCount(game.replyCount)})`
      this.updateFloatingActions(game)
    }

    // Re-fetch comments to show the new reply
    if (this.commentListEl && game) {
      this.loadComments(game.postId, this.commentListEl, headerTitle)
    }
  }

  private closeCommentPanel(): void {
    if (this.commentPanel) {
      if (this.commentPanelKeyHandler) {
        document.removeEventListener('keydown', this.commentPanelKeyHandler)
        this.commentPanelKeyHandler = null
      }
      this.commentPanel.remove()
      this.commentPanel = null
      this.commentListEl = null
    }
    if (this.commentModalUnregister) {
      this.commentModalUnregister()
      this.commentModalUnregister = null
    }
  }

  private async handleFresh(): Promise<void> {
    const game = this.games[this.currentIndex]
    if (!game) return

    if (!this.props.currentUser) {
      showSignInPrompt(
        'fresh',
        () => { window.history.pushState({}, '', '/login'); window.dispatchEvent(new PopStateEvent('popstate')) },
        () => { window.history.pushState({}, '', '/register'); window.dispatchEvent(new PopStateEvent('popstate')) }
      )
      return
    }

    const wasFreshed = game.isFreshed || false

    // Optimistic update
    game.isFreshed = !wasFreshed
    game.freshCount = Math.max(0, game.freshCount + (wasFreshed ? -1 : 1))
    this.updateFloatingActions(game)

    try {
      const res = await fetch(`/api/posts/${game.postId}/fresh`, { method: 'POST', credentials: 'include' })
      if (!res.ok) throw new Error('Failed to toggle fresh')
      const data = await res.json() as { freshed: boolean; fresh_count: number }
      game.isFreshed = data.freshed
      game.freshCount = data.fresh_count
    } catch {
      // Rollback on error
      game.isFreshed = wasFreshed
      game.freshCount = Math.max(0, game.freshCount + (wasFreshed ? 1 : -1))
    }
    this.updateFloatingActions(game)
  }

  private updateFloatingActions(game: Game): void {
    if (this.floatingActions) {
      const newActions = this.createFloatingActions(game)
      this.floatingActions.replaceWith(newActions)
      this.floatingActions = newActions
    }
  }

  private createActionButton(icon: string, label: string, onClick: () => void, isActive: boolean = false, labelStyle?: string): HTMLElement {
    const btn = document.createElement('button')
    btn.className = 'arcade-action-btn'
    const bg = isActive ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.15)'
    btn.style.cssText = `
      width: 52px;
      height: 52px;
      border-radius: 50%;
      border: 1px solid ${isActive ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.08)'};
      background: ${bg};
      color: ${isActive ? 'var(--accent)' : 'rgba(255, 255, 255, 0.8)'};
      font-size: 1.25rem;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0;
      transition: all 0.2s ease;
      box-shadow: none;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
    `
    
    const iconSpan = document.createElement('span')
    iconSpan.textContent = icon
    iconSpan.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
    `
    
    const labelSpan = document.createElement('span')
    labelSpan.textContent = label
    labelSpan.style.cssText = `
      font-size: 0.6rem;
      font-weight: 600;
      color: inherit;
      margin-top: -1px;
      ${labelStyle || ''}
    `
    
    btn.appendChild(iconSpan)
    // Only show numeric labels or specific text labels if requested
    if (/^\d+$/.test(label)) {
       btn.appendChild(labelSpan)
    }

    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'rgba(255, 255, 255, 0.2)'
      btn.style.borderColor = 'rgba(255, 255, 255, 0.4)'
    })
    btn.addEventListener('mouseleave', () => {
      btn.style.background = bg
      btn.style.borderColor = isActive ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.08)'
    })
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      onClick()
    })

    return btn
  }

  private async executeGame(game: Game, container: HTMLElement): Promise<void> {
    try {
      if (game.type === 'flash' && game.swfKey) {
        const handle = await executeFlash(game.postId, container, `/api/swf/${game.postId}`, true)
        this.currentGameHandle = handle
      } else if (game.type === 'zip' && game.payloadKey) {
        // Use WVFS for ZIP execution
        const handle = await executeWvfsZip(game.postId, container, undefined, true)
        this.currentGameHandle = handle
      } else if (game.type === 'dos' && game.payloadKey) {
        const handle = await executeDos(game.postId, container, `/api/zip/${game.postId}`, true)
        this.currentGameHandle = handle
      } else if (game.type === 'html5') {
        // HTML5 games would use iframe
        const iframe = document.createElement('iframe')
        iframe.src = `/api/games/html5/${game.id}`
        iframe.style.cssText = `
          width: 100%;
          height: 100%;
          border: none;
        `
        container.appendChild(iframe)
        this.currentGameHandle = {
          destroy: () => {
            iframe.remove()
          }
        }
      }
    } catch (error) {
      console.error('Failed to execute game:', error)
      container.replaceChildren()
      const wrapper = document.createElement('div')
      wrapper.style.cssText = 'color: white; text-align: center; padding: 2rem;'

      const icon = document.createElement('div')
      icon.style.cssText = 'font-size: 3rem; margin-bottom: 1rem;'
      icon.textContent = '⚠️'

      const message = document.createElement('div')
      message.textContent = t('arcade.load_failed')

      wrapper.appendChild(icon)
      wrapper.appendChild(message)
      container.appendChild(wrapper)
    }
  }

  private clearCurrentGame(): void {
    // Remove current game viewport
    const viewport = this.gameContainer.querySelector('.arcade-viewport') as HTMLElement
    if (viewport) {
      viewport.style.transition = 'transform 0.3s ease, opacity 0.3s ease'
      viewport.style.transform = 'translateY(-100%)'
      viewport.style.opacity = '0'
      
      setTimeout(() => {
        viewport.remove()
      }, 300)
    }

    // Destroy game handle
    if (this.currentGameHandle) {
      this.currentGameHandle.destroy()
      this.currentGameHandle = null
    }

    this.floatingActions = null
    this.commentPanel = null
    this.currentViewport = null
  }

  private preloadNextGame(): void {
    // Preload logic can be implemented here
    // For now, we'll just ensure smooth transitions
  }

  private updateViewportTransform(): void {
    if (this.currentViewport) {
      this.currentViewport.style.transform = `translateY(${this.currentTranslateY}px)`
      this.currentViewport.style.transition = 'none'
      
      // Add visual feedback based on drag position
      const opacity = Math.max(0.3, 1 - Math.abs(this.currentTranslateY) / 500)
      this.currentViewport.style.opacity = opacity.toString()
    }
  }

  private resetViewportPosition(): void {
    if (!this.currentViewport) return
    
    this.currentViewport.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.3s ease'
    this.currentViewport.style.transform = 'translateY(0)'
    this.currentViewport.style.opacity = '1'
    this.currentTranslateY = 0
    this.prevTranslateY = 0
  }

  private animateToNext(): void {
    if (this.currentIndex >= this.games.length - 1) {
      if (this.hasMoreShuffle && !this.isLoadingMore) {
        this.loadMoreGames()
      }
      if (this.currentViewport) {
        this.currentViewport.style.transition = 'transform 0.2s ease, opacity 0.2s ease'
        this.currentViewport.style.transform = 'translateY(-20px)'
        setTimeout(() => {
          if (this.currentViewport) {
            this.currentViewport.style.transform = 'translateY(0)'
          }
        }, 200)
      }
      return
    }
    
    if (!this.currentViewport) return
    
    this.isTransitioning = true
    this.currentViewport.style.transition = 'transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.4s ease'
    this.currentViewport.style.transform = 'translateY(-100%)'
    this.currentViewport.style.opacity = '0'
    
    setTimeout(() => {
      this.currentIndex++
      if (this.currentIndex >= this.games.length - 5 && this.hasMoreShuffle && !this.isLoadingMore) {
        this.loadMoreGames()
      }
      this.renderCurrentGame()
      this.isTransitioning = false
      this.currentTranslateY = 0
      this.prevTranslateY = 0
    }, 400)
  }

  private animateToPrevious(): void {
    if (this.currentIndex <= 0) {
      // Don't reset - just show boundary feedback
      if (this.currentViewport) {
        this.currentViewport.style.transition = 'transform 0.2s ease, opacity 0.2s ease'
        this.currentViewport.style.transform = 'translateY(20px)'
        setTimeout(() => {
          if (this.currentViewport) {
            this.currentViewport.style.transform = 'translateY(0)'
          }
        }, 200)
      }
      return
    }
    
    if (!this.currentViewport) return
    
    this.isTransitioning = true
    this.currentViewport.style.transition = 'transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.4s ease'
    this.currentViewport.style.transform = 'translateY(100%)'
    this.currentViewport.style.opacity = '0'
    
    setTimeout(() => {
      this.currentIndex--
      this.renderCurrentGame()
      this.isTransitioning = false
      this.currentTranslateY = 0
      this.prevTranslateY = 0
    }, 400)
  }

  private cancelAnimation(): void {
    if (this.animationID) {
      cancelAnimationFrame(this.animationID)
      this.animationID = null
    }
  }

  private navigateToNext(): void {
    if (this.isTransitioning) return
    
    if (this.currentIndex >= this.games.length - 1) {
      if (this.hasMoreShuffle && !this.isLoadingMore) {
        this.loadMoreGames()
      }
      return
    }
    
    this.isTransitioning = true
    this.currentIndex++
    this.renderCurrentGame()
    
    if (this.currentIndex >= this.games.length - 5 && this.hasMoreShuffle && !this.isLoadingMore) {
      this.loadMoreGames()
    }
    
    setTimeout(() => {
      this.isTransitioning = false
    }, 300)
  }

  private navigateToPrevious(): void {
    if (this.isTransitioning || this.currentIndex <= 0) return
    
    this.isTransitioning = true
    this.currentIndex--
    this.renderCurrentGame()
    
    setTimeout(() => {
      this.isTransitioning = false
    }, 300)
  }

  private handleDetails(gameId: string): void {
    window.history.pushState({}, '', `/thread/${gameId}`)
    // Navigate to thread page
    window.dispatchEvent(new CustomEvent('spaNavigate', {
      detail: { view: 'thread', postId: gameId }
    }))
  }

  private handleFullscreen(): void {
    const viewport = this.gameContainer.querySelector('.arcade-viewport') as HTMLElement
    if (viewport) {
      if (document.fullscreenElement) {
        document.exitFullscreen()
      } else {
        viewport.requestFullscreen()
      }
    }
  }

  public getElement(): HTMLElement {
    return this.element
  }

  private showTutorial(): void {
    if (this.tutorialEl) return

    const steps = [
      { type: 'card', title: t('arcade.tutorial_welcome_title'), desc: t('arcade.tutorial_welcome_desc') },
      { type: 'demo', title: t('arcade.tutorial_step1_title'), desc: t('arcade.tutorial_step1_desc') },
      { type: 'spotlight', target: '.arcade-game-container', title: t('arcade.tutorial_step2_title'), desc: t('arcade.tutorial_step2_desc') },
      { type: 'spotlight', target: '[data-tutorial="fullscreen"]', title: t('arcade.tutorial_step3_title'), desc: t('arcade.tutorial_step3_desc') },
      { type: 'spotlight', target: '[data-tutorial="fresh"]', title: t('arcade.tutorial_step4_title'), desc: t('arcade.tutorial_step4_desc') },
      { type: 'spotlight', target: '[data-tutorial="comments"]', title: t('arcade.tutorial_step5_title'), desc: t('arcade.tutorial_step5_desc') },
      { type: 'spotlight', target: '[data-nav-id="home"]', title: t('arcade.tutorial_step6_title'), desc: t('arcade.tutorial_step6_desc') },
    ] as const

    let currentStep = 0
    let cardEl: HTMLElement | null = null
    let spotlightEl: HTMLElement | null = null
    let tooltipEl: HTMLElement | null = null
    let demoCanvas: HTMLCanvasElement | null = null
    let demoAnimId: number | null = null

    const boundBlockOutside = (e: Event) => {
      if (overlay.contains(e.target as Node)) return
      e.stopPropagation()
      e.preventDefault()
    }

    const overlay = document.createElement('div')
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2000;
      pointer-events: none;
    `
    this.tutorialEl = overlay
    document.body.appendChild(overlay)

    document.addEventListener('click', boundBlockOutside, true)
    document.addEventListener('touchstart', boundBlockOutside, true)

    const clearTutorial = () => {
      if (demoAnimId) cancelAnimationFrame(demoAnimId)
      cardEl?.remove()
      spotlightEl?.remove()
      tooltipEl?.remove()
      cardEl = null
      spotlightEl = null
      tooltipEl = null
      demoCanvas = null
    }

    const closeTutorial = () => {
      clearTutorial()
      document.removeEventListener('click', boundBlockOutside, true)
      document.removeEventListener('touchstart', boundBlockOutside, true)
      overlay.remove()
      this.tutorialEl = null
      localStorage.setItem(ArcadePage.TUTORIAL_SEEN_KEY, '1')
    }

    const buildCard = (title: string, desc: string, contentFn?: (c: HTMLElement) => void): HTMLElement => {
      const c = document.createElement('div')
      c.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: var(--bg-primary, #fff);
        border-radius: 16px;
        max-width: 420px;
        width: calc(100% - 3rem);
        padding: 2rem 1.5rem;
        box-shadow: 0 8px 40px rgba(0, 0, 0, 0.3);
        text-align: center;
        z-index: 2001;
        pointer-events: auto;
      `

      const closeBtn = document.createElement('button')
      closeBtn.textContent = '✕'
      closeBtn.style.cssText = `
        position: absolute;
        top: 0.75rem;
        right: 0.75rem;
        background: none;
        border: none;
        font-size: 1.1rem;
        cursor: pointer;
        color: var(--text-muted, #888);
        padding: 0.25rem;
        line-height: 1;
        border-radius: 4px;
      `
      closeBtn.addEventListener('click', closeTutorial)
      c.appendChild(closeBtn)

      if (contentFn) contentFn(c)

      const titleEl = document.createElement('h2')
      titleEl.textContent = title
      titleEl.style.cssText = `
        font-size: 1.2rem;
        font-weight: 700;
        margin: 0 0 0.75rem 0;
        color: var(--text-primary);
        line-height: 1.4;
      `

      const descEl = document.createElement('p')
      descEl.textContent = desc
      descEl.style.cssText = `
        font-size: 0.95rem;
        color: var(--text-secondary, #555);
        margin: 0 0 1.25rem 0;
        line-height: 1.6;
      `

      c.appendChild(titleEl)
      c.appendChild(descEl)
      return c
    }

    const startDemoGame = (canvas: HTMLCanvasElement): void => {
      const ctx = canvas.getContext('2d')!
      const w = canvas.width
      const h = canvas.height

      let score = 0
      let timeLeft = 10
      let gameOver = false
      let bx = 50, by = 50, br = 22
      let bvx = 2, bvy = 1.5
      let particles: { x: number; y: number; vx: number; vy: number; life: number; r: number }[] = []

      const draw = () => {
        ctx.clearRect(0, 0, w, h)

        ctx.fillStyle = '#1a1a2e'
        ctx.fillRect(0, 0, w, h)

        ctx.fillStyle = '#fff'
        ctx.font = 'bold 14px sans-serif'
        ctx.textAlign = 'left'
        ctx.fillText(`🍃 ${score}`, 10, 22)

        ctx.textAlign = 'right'
        ctx.fillText(`⏱ ${timeLeft}s`, w - 10, 22)

        if (gameOver) {
          ctx.textAlign = 'center'
          ctx.fillStyle = '#22c55e'
          ctx.font = 'bold 20px sans-serif'
          ctx.fillText(`✨ Score: ${score}!`, w / 2, h / 2 - 10)
          ctx.fillStyle = '#aaa'
          ctx.font = '13px sans-serif'
          ctx.fillText(t('arcade.tutorial_demo_play_again'), w / 2, h / 2 + 20)
          return
        }

        for (const p of particles) {
          ctx.globalAlpha = p.life
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
          ctx.fillStyle = '#22c55e'
          ctx.fill()
        }
        ctx.globalAlpha = 1

        ctx.beginPath()
        ctx.arc(bx, by, br, 0, Math.PI * 2)
        const grad = ctx.createRadialGradient(bx - 5, by - 5, 2, bx, by, br)
        grad.addColorStop(0, '#4ade80')
        grad.addColorStop(1, '#16a34a')
        ctx.fillStyle = grad
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.3)'
        ctx.lineWidth = 2
        ctx.stroke()

        ctx.beginPath()
        ctx.arc(bx - 8, by - 8, 6, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255,255,255,0.15)'
        ctx.fill()
      }

      const update = () => {
        if (gameOver) return

        bx += bvx
        by += bvy
        if (bx - br < 0 || bx + br > w) bvx *= -1
        if (by - br < 0 || by + br > h) bvy *= -1
        bx = Math.max(br, Math.min(w - br, bx))
        by = Math.max(br, Math.min(h - br, by))

        for (const p of particles) {
          p.x += p.vx
          p.y += p.vy
          p.life -= 0.02
          p.r *= 0.98
        }
        particles = particles.filter(p => p.life > 0)

        draw()
        demoAnimId = requestAnimationFrame(update)
      }

      const popParticles = (x: number, y: number) => {
        for (let i = 0; i < 12; i++) {
          const angle = (Math.PI * 2 / 12) * i
          particles.push({
            x, y,
            vx: Math.cos(angle) * (2 + Math.random() * 3),
            vy: Math.sin(angle) * (2 + Math.random() * 3),
            life: 1,
            r: 3 + Math.random() * 3,
          })
        }
      }

      const handleClick = (e: MouseEvent | TouchEvent) => {
        if (gameOver) {
          score = 0
          timeLeft = 10
          gameOver = false
          particles = []
          bx = 50 + Math.random() * (w - 100)
          by = 50 + Math.random() * (h - 100)
          update()
          return
        }

        const rect = canvas.getBoundingClientRect()
        const scaleX = w / rect.width
        const scaleY = h / rect.height
        let cx: number, cy: number
        if ('touches' in e) {
          cx = (e.touches[0].clientX - rect.left) * scaleX
          cy = (e.touches[0].clientY - rect.top) * scaleY
        } else {
          cx = (e.clientX - rect.left) * scaleX
          cy = (e.clientY - rect.top) * scaleY
        }

        const dist = Math.sqrt((cx - bx) ** 2 + (cy - by) ** 2)
        if (dist < br) {
          score++
          popParticles(bx, by)
          bx = 30 + Math.random() * (w - 60)
          by = 30 + Math.random() * (h - 60)
        }
      }

      canvas.addEventListener('click', handleClick)
      canvas.addEventListener('touchstart', handleClick, { passive: true })

      update()

      const timer = setInterval(() => {
        if (timeLeft > 0) {
          timeLeft--
        } else {
          gameOver = true
          clearInterval(timer)
          draw()
        }
      }, 1000)

      // Cleanup on card removal
      const observer = new MutationObserver(() => {
        if (!document.contains(canvas)) {
          clearInterval(timer)
          observer.disconnect()
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
    }

    const renderStep = () => {
      clearTutorial()
      const step = steps[currentStep]
      const isLast = currentStep === steps.length - 1
      const isWelcome = currentStep === 0

      if (step.type === 'card') {
        cardEl = buildCard(step.title, step.desc)
        const btnRow = document.createElement('div')
        btnRow.style.cssText = `
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.75rem;
          flex-wrap: wrap;
        `

        if (isWelcome) {
          const startBtn = ArcadePage.createTutorialButton(t('arcade.tutorial_start'), 'var(--accent, #22c55e)', '#fff')
          startBtn.addEventListener('click', () => { currentStep = 1; renderStep() })
          btnRow.appendChild(startBtn)

          const skipBtn = ArcadePage.createTutorialButton(t('arcade.tutorial_skip'), 'transparent', 'var(--text-muted, #888)')
          skipBtn.style.border = '1px solid var(--border, #ddd)'
          skipBtn.addEventListener('click', closeTutorial)
          btnRow.appendChild(skipBtn)
        } else {
          if (currentStep > 1) {
            const prevBtn = ArcadePage.createTutorialButton(t('arcade.tutorial_prev'), 'transparent', 'var(--text-primary)')
            prevBtn.style.border = '1px solid var(--border, #ddd)'
            prevBtn.addEventListener('click', () => { currentStep--; renderStep() })
            btnRow.appendChild(prevBtn)
          }
          if (isLast) {
            const doneBtn = ArcadePage.createTutorialButton(t('arcade.tutorial_done'), 'var(--accent, #22c55e)', '#fff')
            doneBtn.addEventListener('click', closeTutorial)
            btnRow.appendChild(doneBtn)
          } else {
            const nextBtn = ArcadePage.createTutorialButton(t('arcade.tutorial_next'), 'var(--accent, #22c55e)', '#fff')
            nextBtn.addEventListener('click', () => { currentStep++; renderStep() })
            btnRow.appendChild(nextBtn)
          }
        }

        cardEl.appendChild(btnRow)
        overlay.appendChild(cardEl)
      } else if (step.type === 'demo') {
        cardEl = buildCard(step.title, step.desc, (c) => {
          const canvas = document.createElement('canvas')
          canvas.width = 320
          canvas.height = 200
          demoCanvas = canvas
          canvas.style.cssText = `
            display: block;
            margin: 0 auto 1rem auto;
            border-radius: 10px;
            width: 100%;
            max-width: 320px;
            aspect-ratio: 320 / 200;
            cursor: pointer;
            touch-action: manipulation;
          `
          c.insertBefore(canvas, c.firstChild?.nextSibling || c.firstChild)
          startDemoGame(canvas)
        })

        const btnRow = document.createElement('div')
        btnRow.style.cssText = `
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.75rem;
          flex-wrap: wrap;
        `
        if (currentStep > 1) {
          const prevBtn = ArcadePage.createTutorialButton(t('arcade.tutorial_prev'), 'transparent', 'var(--text-primary)')
          prevBtn.style.border = '1px solid var(--border, #ddd)'
          prevBtn.addEventListener('click', () => { currentStep--; renderStep() })
          btnRow.appendChild(prevBtn)
        }
        const nextBtn = ArcadePage.createTutorialButton(t('arcade.tutorial_next'), 'var(--accent, #22c55e)', '#fff')
        nextBtn.addEventListener('click', () => { currentStep++; renderStep() })
        btnRow.appendChild(nextBtn)
        cardEl.appendChild(btnRow)
        overlay.appendChild(cardEl)
      } else if (step.type === 'spotlight' && 'target' in step) {
        if (isLast && step.target === '[data-nav-id="home"]' && window.innerWidth <= 768) {
          document.dispatchEvent(new CustomEvent('openLeftNav'))
        }
        const target = document.querySelector(step.target as string) as HTMLElement | null
        if (!target) {
          cardEl = buildCard(step.title, step.desc)
          const btnRow = document.createElement('div')
          btnRow.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.75rem;
            flex-wrap: wrap;
          `
          if (currentStep > 1) {
            const prevBtn = ArcadePage.createTutorialButton(t('arcade.tutorial_prev'), 'transparent', 'var(--text-primary)')
            prevBtn.style.border = '1px solid var(--border, #ddd)'
            prevBtn.addEventListener('click', () => { currentStep--; renderStep() })
            btnRow.appendChild(prevBtn)
          }
          if (isLast) {
            const doneBtn = ArcadePage.createTutorialButton(t('arcade.tutorial_done'), 'var(--accent, #22c55e)', '#fff')
            doneBtn.addEventListener('click', closeTutorial)
            btnRow.appendChild(doneBtn)
          } else {
            const nextBtn = ArcadePage.createTutorialButton(t('arcade.tutorial_next'), 'var(--accent, #22c55e)', '#fff')
            nextBtn.addEventListener('click', () => { currentStep++; renderStep() })
            btnRow.appendChild(nextBtn)
          }
          cardEl.appendChild(btnRow)
          overlay.appendChild(cardEl)
          return
        }

        const rect = target.getBoundingClientRect()

        spotlightEl = document.createElement('div')
        spotlightEl.style.cssText = `
          position: fixed;
          top: ${rect.top}px;
          left: ${rect.left}px;
          width: ${rect.width}px;
          height: ${rect.height}px;
          z-index: 2000;
          pointer-events: none;
          box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.65), 0 0 20px rgba(34, 197, 94, 0.3);
          border-radius: 12px;
          animation: spotlight-pulse 2s ease-in-out infinite;
        `
        overlay.appendChild(spotlightEl)

        tooltipEl = document.createElement('div')
        tooltipEl.style.cssText = `
          position: fixed;
          z-index: 2001;
          pointer-events: auto;
          background: var(--bg-primary, #fff);
          border-radius: 12px;
          padding: 1rem 1.25rem;
          max-width: 280px;
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.35);
          text-align: center;
        `

        const icon = step.title.match(/^(\S+)/)?.[0] || ''
        const cleanTitle = step.title.replace(/^\S+\s*/, '')

        const stepLabel = document.createElement('div')
        stepLabel.textContent = `${currentStep}/${steps.length - 1}`
        stepLabel.style.cssText = 'font-size: 0.7rem; color: var(--text-muted, #888); margin-bottom: 0.5rem;'

        const titleEl = document.createElement('div')
        titleEl.style.cssText = 'font-weight: 700; font-size: 1rem; margin-bottom: 0.4rem; color: var(--text-primary);'
        titleEl.textContent = `${icon} ${cleanTitle}`

        const descEl = document.createElement('div')
        descEl.textContent = step.desc
        descEl.style.cssText = 'font-size: 0.85rem; color: var(--text-secondary, #555); margin-bottom: 0.75rem; line-height: 1.5;'

        const btnRow = document.createElement('div')
        btnRow.style.cssText = 'display: flex; align-items: center; justify-content: center; gap: 0.5rem;'

        if (currentStep > 1) {
          const prevBtn = ArcadePage.createTutorialButton(t('arcade.tutorial_prev'), 'transparent', 'var(--text-primary)')
          prevBtn.style.border = '1px solid var(--border, #ddd)'
          prevBtn.style.padding = '0.4rem 0.8rem'
          prevBtn.style.fontSize = '0.8rem'
          prevBtn.addEventListener('click', () => { currentStep--; renderStep() })
          btnRow.appendChild(prevBtn)
        }

        if (isLast) {
          const doneBtn = ArcadePage.createTutorialButton(t('arcade.tutorial_done'), 'var(--accent, #22c55e)', '#fff')
          doneBtn.style.padding = '0.4rem 0.8rem'
          doneBtn.style.fontSize = '0.8rem'
          doneBtn.addEventListener('click', closeTutorial)
          btnRow.appendChild(doneBtn)
        } else {
          const nextBtn = ArcadePage.createTutorialButton(t('arcade.tutorial_next'), 'var(--accent, #22c55e)', '#fff')
          nextBtn.style.padding = '0.4rem 0.8rem'
          nextBtn.style.fontSize = '0.8rem'
          nextBtn.addEventListener('click', () => { currentStep++; renderStep() })
          btnRow.appendChild(nextBtn)
        }

        tooltipEl.appendChild(stepLabel)
        tooltipEl.appendChild(titleEl)
        tooltipEl.appendChild(descEl)
        tooltipEl.appendChild(btnRow)
        overlay.appendChild(tooltipEl)

        // Position tooltip relative to spotlight
        const vw = window.innerWidth
        const vh = window.innerHeight
        const margin = 12
        const tooltipW = Math.min(280, vw - margin * 2)
        const tooltipH = tooltipEl.offsetHeight || 160
        let tx: number, ty: number

        const centerX = rect.left + rect.width / 2
        const centerY = rect.top + rect.height / 2

        const targetInLeftNav = target.closest('.left-nav') !== null
        if (targetInLeftNav && window.innerWidth <= 768) {
          tx = Math.max(margin, centerX - tooltipW / 2)
          ty = rect.bottom + margin
        } else if (centerX < vw * 0.4) {
          tx = rect.right + margin
          ty = Math.min(centerY - tooltipH / 2, vh - tooltipH - margin)
        } else if (centerX > vw * 0.6) {
          tx = rect.left - tooltipW - margin
          ty = Math.min(centerY - tooltipH / 2, vh - tooltipH - margin)
        } else if (centerY < vh * 0.4) {
          tx = Math.max(margin, centerX - tooltipW / 2)
          ty = rect.bottom + margin
        } else {
          tx = Math.max(margin, centerX - tooltipW / 2)
          ty = rect.top - tooltipH - margin
        }

        tx = Math.max(margin, Math.min(vw - tooltipW - margin, tx))
        ty = Math.max(margin, Math.min(vh - tooltipH - margin, ty))
        tooltipEl.style.left = `${tx}px`
        tooltipEl.style.top = `${ty}px`
      }
    }

    renderStep()
  }

  private static createTutorialButton(text: string, bg: string, color: string): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.textContent = text
    btn.style.cssText = `
      background: ${bg};
      border: none;
      color: ${color};
      cursor: pointer;
      padding: 0.6rem 1.4rem;
      font-size: 0.9rem;
      font-weight: 600;
      border-radius: 8px;
      transition: opacity 0.2s;
      line-height: 1.2;
    `
    btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.85' })
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '1' })
    return btn
  }

  public destroy(): void {
    if (this.tutorialEl) {
      this.tutorialEl.remove()
      this.tutorialEl = null
    }
    // Clean up document event listeners using stored bound functions
    document.removeEventListener('touchstart', this.boundHandleTouchStart)
    document.removeEventListener('touchmove', this.boundHandleTouchMove)
    document.removeEventListener('touchend', this.boundHandleTouchEnd)
    document.removeEventListener('mousedown', this.boundHandleMouseDown)
    document.removeEventListener('mousemove', this.boundHandleMouseMove)
    document.removeEventListener('mouseup', this.boundHandleMouseUp)
    document.removeEventListener('mouseleave', this.boundHandleMouseLeave)
    
    this.clearCurrentGame()
    this.element.remove()
  }
}

export function createArcadePage(props: ArcadePageProps): ArcadePageHandle {
  const page = new ArcadePage(props)
  return {
    getElement: () => page.getElement(),
    destroy: () => page.destroy()
  }
}
