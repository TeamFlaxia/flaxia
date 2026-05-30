import { ParentMessage, SandboxMessage, isParentMessage } from '../lib/bridge.js'
import { t } from '../lib/i18n.js'
import type { Post } from '../types/post.js'
import { registerModal } from './modal-state.js'

export interface SandboxBridgeOptions {
  iframe: HTMLIFrameElement
  post: Post
  onFreshRequest?: () => void
}

export class SandboxBridge {
  private iframe: HTMLIFrameElement
  private post: Post
  private onFreshRequest?: () => void
  private messageHandler: (event: MessageEvent) => void
  private overlay?: HTMLElement
  private toast?: HTMLElement
  private unregisterOverlay?: () => void

  constructor(options: SandboxBridgeOptions) {
    this.iframe = options.iframe
    this.post = options.post
    this.onFreshRequest = options.onFreshRequest
    this.messageHandler = this.handleMessage.bind(this)
    
    // Start listening for messages
    window.addEventListener('message', this.messageHandler)
  }

  private handleMessage(event: MessageEvent): void {
    // Validate origin first
    const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxiausercontent.com'
    const allowedOrigins = [sandboxOrigin, 'https://sandbox.flaxia.app']
    if (!allowedOrigins.includes(event.origin)) return

    const data = event.data
    if (!isParentMessage(data)) return

    switch (data.type) {
      case 'REQUEST_FULLSCREEN':
        this.handleRequestFullscreen()
        break
      case 'REQUEST_FRESH':
        this.handleRequestFresh()
        break
      case 'POST_SCORE':
        this.handlePostScore(data.score, data.label)
        break
    }
  }

  private handleRequestFullscreen(): void {
    this.showFullscreenOverlay()
  }

  private handleRequestFresh(): void {
    // Optimistic fresh - immediately call the handler
    this.onFreshRequest?.()
    
    // Send response to sandbox
    this.sendMessage({ type: 'FRESH_GRANTED' })
  }

  private handlePostScore(score: number, label: string): void {
    // Validate score
    if (typeof score !== 'number' || isNaN(score)) return

    this.showScoreToast(score, label)
    
    // Send response to sandbox
    this.sendMessage({ type: 'SCORE_SUBMITTED', score, label })
  }

  private showFullscreenOverlay(): void {
    // Remove existing overlay if any
    this.hideFullscreenOverlay()

    const overlay = document.createElement('div')
    overlay.className = 'fullscreen-overlay'
    
    const postText = this.post.text.length > 40 
      ? this.post.text.slice(0, 40) + '…' 
      : this.post.text

    overlay.innerHTML = `
      <div class="fullscreen-modal">
        <p class="fullscreen-message">${t('sandbox.fullscreen_request', { postText: this.escapeHtml(postText) })}</p>
        <div class="fullscreen-buttons">
          <button class="fullscreen-allow">${t('sandbox.allow')}</button>
          <button class="fullscreen-deny">${t('sandbox.deny')}</button>
        </div>
      </div>
    `

    // Add event listeners
    const allowBtn = overlay.querySelector('.fullscreen-allow') as HTMLButtonElement
    const denyBtn = overlay.querySelector('.fullscreen-deny') as HTMLButtonElement

    allowBtn.addEventListener('click', () => {
      this.grantFullscreen()
    })

    denyBtn.addEventListener('click', () => {
      this.denyFullscreen()
    })

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        this.denyFullscreen()
      }
    })

    document.body.appendChild(overlay)
    this.overlay = overlay
    this.unregisterOverlay = registerModal()
  }

  private hideFullscreenOverlay(): void {
    if (this.overlay) {
      this.unregisterOverlay?.()
      this.unregisterOverlay = undefined
      this.overlay.remove()
      this.overlay = undefined
    }
  }

  private grantFullscreen(): void {
    try {
      document.documentElement.requestFullscreen()
      this.sendMessage({ type: 'FULLSCREEN_GRANTED' })
    } catch (error) {
      console.error('Failed to request fullscreen:', error)
      this.sendMessage({ type: 'FULLSCREEN_DENIED' })
    }
    this.hideFullscreenOverlay()
  }

  private denyFullscreen(): void {
    this.sendMessage({ type: 'FULLSCREEN_DENIED' })
    this.hideFullscreenOverlay()
  }

  private showScoreToast(score: number, label: string): void {
    // Remove existing toast if any
    this.hideScoreToast()

    const toast = document.createElement('div')
    toast.className = 'score-toast'
    
    const formattedScore = Number(score).toLocaleString()
    
    toast.innerHTML = `
      <div class="score-content">
        <span class="score-label">${this.escapeHtml(label)}</span>
        <span class="score-value">${formattedScore}</span>
      </div>
    `

    // Position toast relative to the iframe
    const iframeRect = this.iframe.getBoundingClientRect()
    toast.style.position = 'fixed'
    toast.style.top = `${iframeRect.top + 10}px`
    toast.style.left = `${iframeRect.left + 10}px`
    toast.style.zIndex = '1000'

    document.body.appendChild(toast)
    this.toast = toast

    // Auto-hide after 3 seconds
    setTimeout(() => {
      this.hideScoreToast()
    }, 3000)
  }

  private hideScoreToast(): void {
    if (this.toast) {
      this.toast.remove()
      this.toast = undefined
    }
  }

  private sendMessage(message: SandboxMessage): void {
    const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxiausercontent.com'
    this.iframe.contentWindow?.postMessage(message, sandboxOrigin)
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  public destroy(): void {
    window.removeEventListener('message', this.messageHandler)
    this.hideFullscreenOverlay()
    this.hideScoreToast()
  }
}

// Factory function for easier usage
export function useSandboxBridge(options: SandboxBridgeOptions): SandboxBridge {
  return new SandboxBridge(options)
}
