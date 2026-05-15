import { executeFlash } from './FlashPlayer.js'
import { executeWvfsZip } from '../lib/wvfs-zip-client.js'
import type { Game, ArcadePageProps, GameType } from '../types/game.js'

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
  private cache: Map<string, { games: Game[]; timestamp: number; hasMore: boolean }> = new Map()
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes
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
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'arcade-page'
    container.style.cssText = `
      flex: 1;
      display: flex;
      flex-direction: column;
      height: 100vh;
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
      justify-content: space-between;
    `

    const title = document.createElement('h1')
    title.textContent = '🕹️ Shot Arcade'
    title.style.cssText = `
      margin: 0;
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text-primary);
    `

    const subtitle = document.createElement('span')
    subtitle.textContent = 'Play web as Shorts!'
    subtitle.style.cssText = `
      font-size: 0.875rem;
      color: var(--text-muted);
    `

    header.appendChild(title)
    header.appendChild(subtitle)

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
    loadingIndicator.textContent = 'Loading games...'

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
      <div style="font-size: 1.25rem; margin-bottom: 0.5rem;">No games yet</div>
      <div style="font-size: 0.875rem;">Upload SWF or ZIP files to share games!</div>
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

  private handleTouchStart(e: TouchEvent): void {
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
      const cacheKey = 'trending:first'
      const cached = this.cache.get(cacheKey)
      const now = Date.now()
      
      // Check cache first
      if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
        console.log('Using cached games data')
        this.games = cached.games
        this.hasMore = cached.hasMore
        
        if (this.games.length > 0) {
          // Handle initialGameId if provided
          if (this.initialGameId) {
            const gameIndex = this.games.findIndex(game => game.id === this.initialGameId)
            if (gameIndex !== -1) {
              this.currentIndex = gameIndex
              console.log(`Found game ${this.initialGameId} at index ${gameIndex}`)
            } else {
              console.warn(`Game ${this.initialGameId} not found, showing first game`)
            }
          }
          this.renderCurrentGame()
        } else {
          this.showEmptyState()
        }
        
        this.isLoading = false
        loadingIndicator.style.display = 'none'
        return
      }

      const response = await fetch('/api/games?trending=true', { credentials: 'include' })
      if (response.ok) {
        const data = await response.json() as { games: Game[]; hasMore?: boolean }
        this.games = data.games || []
        this.hasMore = data.hasMore || false

        // Cache the response
        this.cache.set(cacheKey, {
          games: [...this.games], // Create a copy
          timestamp: now,
          hasMore: this.hasMore
        })

        if (this.games.length > 0) {
          // Handle initialGameId if provided
          if (this.initialGameId) {
            const gameIndex = this.games.findIndex(game => game.id === this.initialGameId)
            if (gameIndex !== -1) {
              this.currentIndex = gameIndex
              console.log(`Found game ${this.initialGameId} at index ${gameIndex}`)
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
    gameTitle.textContent = game.title || `Game by @${game.username}`

    const gameAuthor = document.createElement('div')
    gameAuthor.style.cssText = `
      font-size: 0.875rem;
      opacity: 0.9;
    `
    gameAuthor.textContent = `@${game.username}`

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

    // Details button
    const detailsBtn = this.createActionButton('ℹ️', 'Details', () => this.handleDetails(game.id))

    // Fullscreen button
    const fullscreenBtn = this.createActionButton('⛶', 'Fullscreen', () => this.handleFullscreen())

    container.appendChild(detailsBtn)
    container.appendChild(fullscreenBtn)

    return container
  }

  private createActionButton(icon: string, label: string, onClick: () => void): HTMLElement {
    const btn = document.createElement('button')
    btn.className = 'arcade-action-btn'
    btn.style.cssText = `
      width: 56px;
      height: 56px;
      border-radius: 50%;
      border: none;
      background: rgba(255, 255, 255, 0.15);
      backdrop-filter: blur(10px);
      color: white;
      font-size: 1.5rem;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      transition: transform 0.2s, background 0.2s;
    `
    
    const iconSpan = document.createElement('span')
    iconSpan.textContent = icon
    iconSpan.style.fontSize = '1.25rem'
    
    const labelSpan = document.createElement('span')
    labelSpan.textContent = label
    labelSpan.style.fontSize = '0.625rem'
    
    btn.appendChild(iconSpan)
    if (label !== 'Share' && label !== 'Details' && label !== 'Fullscreen') {
      btn.appendChild(labelSpan)
    }

    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.1)'
      btn.style.background = 'rgba(255, 255, 255, 0.25)'
    })
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)'
      btn.style.background = 'rgba(255, 255, 255, 0.15)'
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
        const handle = await executeFlash(game.postId, container, `/api/swf/${game.postId}`)
        this.currentGameHandle = handle
      } else if (game.type === 'zip' && game.payloadKey) {
        // Use WVFS for ZIP execution
        const handle = await executeWvfsZip(game.postId, container)
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
      message.textContent = 'Failed to load game'

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
      // Don't reset - just show boundary feedback
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
    if (this.isTransitioning || this.currentIndex >= this.games.length - 1) return
    
    this.isTransitioning = true
    this.currentIndex++
    this.renderCurrentGame()
    
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

  public destroy(): void {
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
