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
  private gameContainer: HTMLElement
  private floatingActions: HTMLElement | null = null
  private currentGameHandle: { destroy: () => void } | null = null
  private touchStartY: number = 0
  private touchEndY: number = 0
  private isTransitioning: boolean = false

  constructor(props: ArcadePageProps) {
    this.props = props
    this.element = this.createElement()
    this.gameContainer = this.element.querySelector('.arcade-game-container') as HTMLElement
    this.setupEventListeners()
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
    subtitle.textContent = '0-second play'
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
    // Touch/swipe support
    this.gameContainer.addEventListener('touchstart', (e) => {
      this.touchStartY = e.touches[0].clientY
    }, { passive: true })

    this.gameContainer.addEventListener('touchend', (e) => {
      this.touchEndY = e.changedTouches[0].clientY
      this.handleSwipe()
    }, { passive: true })

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

  private handleSwipe(): void {
    const diff = this.touchStartY - this.touchEndY
    const threshold = 50

    if (Math.abs(diff) > threshold) {
      if (diff > 0) {
        this.navigateToNext()
      } else {
        this.navigateToPrevious()
      }
    }
  }

  private async loadGames(): Promise<void> {
    if (this.isLoading) return
    this.isLoading = true

    const loadingIndicator = this.element.querySelector('.arcade-loading') as HTMLElement
    loadingIndicator.style.display = 'block'

    try {
      const response = await fetch('/api/games?trending=true', { credentials: 'include' })
      if (response.ok) {
        const data = await response.json() as { games: Game[]; hasMore?: boolean }
        this.games = data.games || []
        this.hasMore = data.hasMore || false

        if (this.games.length > 0) {
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

    // Create game viewport
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

    // Execute the game
    this.executeGame(game, gameArea)

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
      bottom: 100px;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      z-index: 10;
    `

    // Like button
    const likeBtn = this.createActionButton(
      game.isFreshed ? '❤️' : '🤍',
      game.freshCount.toString(),
      () => this.handleLike(game.id)
    )
    likeBtn.classList.add('arcade-like-btn')

    // Share button
    const shareBtn = this.createActionButton('📤', 'Share', () => this.handleShare(game.id))

    // Details button
    const detailsBtn = this.createActionButton('ℹ️', 'Details', () => this.handleDetails(game.id))

    // Fullscreen button
    const fullscreenBtn = this.createActionButton('⛶', 'Fullscreen', () => this.handleFullscreen())

    container.appendChild(likeBtn)
    container.appendChild(shareBtn)
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
      container.innerHTML = `
        <div style="
          color: white;
          text-align: center;
          padding: 2rem;
        ">
          <div style="font-size: 3rem; margin-bottom: 1rem;">⚠️</div>
          <div>Failed to load game</div>
        </div>
      `
    }
  }

  private clearCurrentGame(): void {
    // Remove current game viewport
    const viewport = this.gameContainer.querySelector('.arcade-viewport')
    if (viewport) {
      viewport.remove()
    }

    // Destroy game handle
    if (this.currentGameHandle) {
      this.currentGameHandle.destroy()
      this.currentGameHandle = null
    }

    this.floatingActions = null
  }

  private preloadNextGame(): void {
    // Preload logic can be implemented here
    // For now, we'll just ensure smooth transitions
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

  private async handleLike(gameId: string): Promise<void> {
    try {
      const response = await fetch(`/api/posts/${gameId}/fresh`, {
        method: 'POST',
        credentials: 'include'
      })
      
      if (response.ok) {
        // Update UI
        const likeBtn = this.floatingActions?.querySelector('.arcade-like-btn') as HTMLElement
        if (likeBtn) {
          const icon = likeBtn.querySelector('span:first-child')
          if (icon) icon.textContent = '❤️'
        }
      }
    } catch (error) {
      console.error('Failed to like game:', error)
    }
  }

  private handleShare(gameId: string): void {
    const url = `${window.location.origin}/thread/${gameId}`
    
    if (navigator.share) {
      navigator.share({
        title: 'Check out this game on Flaxia Arcade!',
        url
      })
    } else {
      navigator.clipboard.writeText(url)
      // Could show a toast notification here
    }
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
