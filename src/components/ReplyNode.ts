import { Post, PostCardProps } from '../types/post.js'
import { PostNode } from '../lib/thread.js'
import { createPostCard, PostCard as PostCardClass } from './PostCard.js'
import { createReplyComposer, ReplyComposer } from './ReplyComposer.js'

export interface ReplyNodeProps {
  node: PostNode
  sandboxOrigin: string
  onReplyCreated: (newReply: Post) => void
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null
  postIndexMap?: Map<string, number>
}

export class ReplyNode {
  private element: HTMLElement
  private props: ReplyNodeProps
  private postCard?: PostCardClass
  private replyComposer?: ReplyComposer
  private childReplyNodes: ReplyNode[] = []
  private isReplyComposerOpen: boolean = false
  private globalReplyListener?: (e: Event) => void
  private isExpanded: boolean = false
  private expandButton?: HTMLButtonElement
  private childrenContainer?: HTMLElement

  constructor(props: ReplyNodeProps) {
    this.props = props
    this.element = this.createElement()
    this.setupEventListeners()
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'reply-node'
    container.style.cssText = `
      margin-bottom: 0.75rem;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      ${this.props.node.post.depth > 0 ? 'padding-left: 1rem;' : ''}
    `

    const nodeIndex = this.props.postIndexMap?.get(this.props.node.post.id)

    // Post card for this reply
    this.postCard = createPostCard({
      post: this.props.node.post,
      sandboxOrigin: this.props.sandboxOrigin,
      currentUser: this.props.currentUser || undefined,
      onDelete: () => {},
      disableReplyComposer: true,
      depth: this.props.node.post.depth,
      postIndex: nodeIndex,
      enablePostRefs: true,
      stripLeadingPostRef: true
    })
    
    // Create wrapper for post card and expand button
    const postWrapper = document.createElement('div')
    postWrapper.style.cssText = 'position: relative;'
    postWrapper.appendChild(this.postCard.getElement())
    
    // Add expand button if this reply has children and depth > 0
    if (this.props.node.children.length > 0 && this.props.node.post.depth > 0) {
      this.expandButton = document.createElement('button')
      this.expandButton.className = 'expand-button'
      this.expandButton.innerHTML = '▶'
      this.expandButton.style.cssText = `
        position: absolute;
        left: -1.5rem;
        top: 0.5rem;
        background: none;
        border: none;
        color: #64748b;
        cursor: pointer;
        font-size: 0.75rem;
        padding: 0.25rem;
        border-radius: 0.25rem;
        transition: all 0.2s ease;
        width: 1.25rem;
        height: 1.25rem;
        display: flex;
        align-items: center;
        justify-content: center;
      `
      this.expandButton.addEventListener('click', () => this.toggleExpanded())
      this.expandButton.addEventListener('mouseenter', () => {
        this.expandButton!.style.backgroundColor = '#f1f5f9'
        this.expandButton!.style.color = '#334155'
      })
      this.expandButton.addEventListener('mouseleave', () => {
        this.expandButton!.style.backgroundColor = 'none'
        this.expandButton!.style.color = '#64748b'
      })
      postWrapper.appendChild(this.expandButton)
    }
    
    container.appendChild(postWrapper)

    // Reply composer (hidden by default)
    const prefill = nodeIndex !== undefined ? `>>${nodeIndex} ` : undefined
    this.replyComposer = createReplyComposer({
      postId: this.props.node.post.id,
      sandboxOrigin: this.props.sandboxOrigin,
      onReplyCreated: (newReply) => this.handleReplyCreated(newReply),
      onCancel: () => this.hideReplyComposer(),
      prefillText: prefill
    })
    this.replyComposer.getElement().style.display = 'none'
    container.appendChild(this.replyComposer.getElement())

    // Children replies (hidden by default for depth >= 1)
    if (this.props.node.children.length > 0) {
      this.childrenContainer = document.createElement('div')
      this.childrenContainer.className = 'reply-children'
      this.childrenContainer.style.cssText = `
        margin-top: 0.75rem;
        padding-left: 1rem;
        border-left: 2px solid #e2e8f0;
        display: ${this.props.node.post.depth > 0 ? 'none' : 'block'};
      `

      this.props.node.children.forEach(childNode => {
        const childReplyNode = new ReplyNode({
          node: childNode,
          sandboxOrigin: this.props.sandboxOrigin,
          currentUser: this.props.currentUser,
          onReplyCreated: (newReply) => this.props.onReplyCreated(newReply),
          postIndexMap: this.props.postIndexMap
        })
        this.childReplyNodes.push(childReplyNode)
        this.childrenContainer!.appendChild(childReplyNode.getElement())
      })

      container.appendChild(this.childrenContainer)
    }

    return container
  }

  private setupEventListeners(): void {
    if (this.postCard) {
      // Listen for reply toggle events on the post card
      this.postCard.getElement().addEventListener('replyToggle', (e: any) => {
        if (e.detail.postId === this.props.node.post.id) {
          this.toggleReplyComposer()
        }
      })
    }

    // Listen for global reply composer open events to close other composers
    this.globalReplyListener = (e: any) => {
      if (e.detail.postId !== this.props.node.post.id && this.isReplyComposerOpen) {
        this.hideReplyComposer()
      }
    }
    document.addEventListener('replyComposerOpen', this.globalReplyListener)
  }

  private toggleReplyComposer(): void {
    if (this.isReplyComposerOpen) {
      this.hideReplyComposer()
    } else {
      this.showReplyComposer()
    }
  }

  private showReplyComposer(): void {
    if (this.replyComposer) {
      // Dispatch global event to close other reply composers
      document.dispatchEvent(new CustomEvent('replyComposerOpen', {
        detail: { postId: this.props.node.post.id }
      }))
      
      this.replyComposer.getElement().style.display = 'block'
      this.isReplyComposerOpen = true
    }
  }

  private hideReplyComposer(): void {
    if (this.replyComposer) {
      this.replyComposer.getElement().style.display = 'none'
      this.isReplyComposerOpen = false
    }
  }

  private toggleExpanded(): void {
    this.isExpanded = !this.isExpanded
    if (this.expandButton) {
      this.expandButton.innerHTML = this.isExpanded ? '▼' : '▶'
    }
    if (this.childrenContainer) {
      this.childrenContainer.style.display = this.isExpanded ? 'block' : 'none'
    }
  }

  private handleReplyCreated(newReply: Post): void {
    // Hide reply composer after successful reply
    this.hideReplyComposer()
    
    // Notify parent
    this.props.onReplyCreated(newReply)

    // Update this post's reply count
    if (this.postCard) {
      this.postCard.updatePost({
        reply_count: (this.props.node.post.reply_count || 0) + 1
      })
    }
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public destroy(): void {
    // Cleanup global event listener
    if (this.globalReplyListener) {
      document.removeEventListener('replyComposerOpen', this.globalReplyListener)
      this.globalReplyListener = undefined
    }

    // Cleanup child reply nodes
    this.childReplyNodes.forEach(node => node.destroy())
    this.childReplyNodes = []

    // Cleanup post card
    if (this.postCard) {
      this.postCard.destroy()
      this.postCard = undefined
    }

    // Cleanup reply composer
    if (this.replyComposer) {
      this.replyComposer.destroy()
      this.replyComposer = undefined
    }

    this.element.remove()
  }
}

// Factory function for easier usage
export function createReplyNode(props: ReplyNodeProps): ReplyNode {
  return new ReplyNode(props)
}
