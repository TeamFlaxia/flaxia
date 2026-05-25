import { t } from '../lib/i18n.js'
import { PostCardProps, PostCardMode } from '../types/post.js'
import { createPostHeader } from './PostHeader.js'
import { createPostText } from './PostText.js'
import { createPostStage, updatePostStage } from './PostStage.js'
import { createPostActions } from './PostActions.js'
import { createReplyComposer, ReplyComposer } from './ReplyComposer.js'
import { createShareModal } from './ShareModal.js'
import { useSandboxBridge } from '../lib/sandbox-bridge.js'
import { showSignInPrompt } from './SignInPrompt.js'
import { impressionTracker } from '../lib/impression-tracker.js'
import { registerModal } from '../lib/modal-state.js'

export class PostCard {
  private element: HTMLElement
  private props: PostCardProps
  private mode: PostCardMode
  private isFreshed: boolean
  private freshCount: number
  private replyCount: number
  private impressions: number
  private impressionTracked: boolean = false
  private postStageElement?: HTMLElement
  private sandboxBridge?: ReturnType<typeof useSandboxBridge>
  private replyComposer?: ReplyComposer
  private isReplyComposerOpen: boolean = false
  private menuDropdown?: HTMLElement
  private freshLoading: boolean = false

  constructor(props: PostCardProps) {
    this.props = props
    this.mode = props.initialMode || PostCardMode.PREVIEW
    // Use is_freshed from API response if available, otherwise default to false
    this.isFreshed = props.post.is_freshed || false
    this.freshCount = props.post.fresh_count
    this.replyCount = props.post.reply_count || 0
    this.impressions = props.post.impressions || 0
    this.element = this.createElement()
    this.setupEventListeners()
  }

  private createElement(): HTMLElement {
    const container = document.createElement('article')
    container.className = 'post-card'
    container.setAttribute('data-post-id', this.props.post.id)
    if (this.props.postIndex !== undefined) {
      container.setAttribute('data-post-index', String(this.props.postIndex))
    }
    container.style.cursor = 'pointer'

    // Header container with ... menu
    const headerContainer = document.createElement('div')
    headerContainer.style.cssText = `
      display: flex;
      align-items: flex-start;
      position: relative;
    `

    // Post index (left side)
    if (this.props.postIndex !== undefined) {
      const indexEl = document.createElement('span')
      indexEl.textContent = `${this.props.postIndex}`
      indexEl.style.cssText = `
        color: #94a3b8;
        font-size: 0.8125rem;
        font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        margin-right: 0.5rem;
        flex-shrink: 0;
      `
      headerContainer.appendChild(indexEl)
    }

    // Post header
    const header = createPostHeader({
      username: this.props.post.username,
      display_name: this.props.post.display_name,
      avatar_key: this.props.post.avatar_key,
      createdAt: this.props.post.created_at
    })
    headerContainer.appendChild(header)

    // ... menu button
    const isOwnPost = this.props.currentUser?.username === this.props.post.username
    const menuButton = this.createMenuButton(isOwnPost)
    menuButton.style.marginLeft = 'auto'
    headerContainer.appendChild(menuButton)

    container.appendChild(headerContainer)

    // Post text - 優先的にプレーンテキストで表示
    const textElement = document.createElement('div')
    textElement.className = 'post-text'
    textElement.style.cssText = `
      margin-bottom: 1rem;
      line-height: 1.6;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: var(--text-primary);
      white-space: pre-wrap;
      word-break: break-word;
    `
    // まずプレーンテキストで即時表示
    textElement.textContent = this.props.post.text
    container.appendChild(textElement)
    
    // 非同期でMarkdown処理（リッチな表示は後から）
    if ('requestIdleCallback' in window) {
      (window as any).requestIdleCallback(async () => {
        try {
          const richText = await createPostText({
            text: this.props.post.text,
            mentions: this.props.post.mentions,
            enablePostRefs: this.props.enablePostRefs
          })
          // リッチテキストに置き換え
          textElement.replaceWith(richText)
        } catch (error) {
          console.error('Failed to create rich post text:', error)
          // エラー時はプレーンテキストのまま
        }
      }, { timeout: 2000 })
    } else {
      // フォールバック
      setTimeout(async () => {
        try {
          const richText = await createPostText({
            text: this.props.post.text,
            mentions: this.props.post.mentions,
            enablePostRefs: this.props.enablePostRefs
          })
          textElement.replaceWith(richText)
        } catch (error) {
          console.error('Failed to create rich post text:', error)
        }
      }, 500)
    }

    // Tag chips (between text and PostStage)
    const hashtags = this.parseHashtags(this.props.post.hashtags)
    if (hashtags.length > 0) {
      const tagChips = this.createTagChips(hashtags)
      container.appendChild(tagChips)
    }

    // Poll section
    if (this.props.post.poll) {
      const pollEl = this.createPollElement(this.props.post.poll)
      container.appendChild(pollEl)
    }

    // Post stage (16:9 container for GIF/iframe) - only show if has attachments
    if (this.props.post.gif_key || this.props.post.payload_key || this.props.post.swf_key) {
      this.postStageElement = createPostStage({
        post: this.props.post,
        mode: this.mode,
        sandboxOrigin: this.props.sandboxOrigin,
        onModeChange: (newMode) => this.handleModeChange(newMode)
      })
      container.appendChild(this.postStageElement)
    }

    // Post actions (only if reply is not disabled)
    if (!this.props.disableReply) {
      const actions = createPostActions({
        postId: this.props.post.id,
        freshCount: this.freshCount,
        replyCount: this.replyCount,
        impressions: this.impressions,
        isFreshed: this.isFreshed,
        depth: this.props.depth ?? this.props.post.depth,
        onFreshToggle: () => this.handleFreshToggle(),
        onReplyToggle: () => this.handleReplyToggle(),
        onShare: () => this.handleShare()
      })
      container.appendChild(actions)
    }

    // Reply composer (hidden by default, only if reply composer is not disabled)
    if (!this.props.disableReply && !this.props.disableReplyComposer) {
      this.replyComposer = createReplyComposer({
        postId: this.props.post.id,
        sandboxOrigin: this.props.sandboxOrigin,
        onReplyCreated: (newReply) => this.handleReplyCreated(newReply),
        onCancel: () => this.hideReplyComposer()
      })
      this.replyComposer.getElement().style.display = 'none'
      container.appendChild(this.replyComposer.getElement())
    }

    return container
  }

  private setupEventListeners(): void {
    // Setup sandbox bridge when iframe is available
    this.setupSandboxBridge()
    
    // Setup impression tracking using Intersection Observer
    this.setupImpressionTracking()
    
    // Add click handler for post navigation (but not for buttons/inputs or during text selection)
    this.element.addEventListener('click', (e) => {
      console.log('PostCard clicked, target:', e.target)
      
      // Don't navigate if clicking on buttons, inputs, or links
      const target = e.target as HTMLElement
      const closestButton = target.closest('button')
      const closestInput = target.closest('input')
      const closestTextarea = target.closest('textarea')
      const closestLink = target.closest('a')
      
      // Check if text is being selected
      const selection = window.getSelection()
      const isSelectingText = selection && selection.toString().length > 0
      
      console.log('Checking if should prevent navigation:', {
        closestButton,
        closestInput,
        closestTextarea,
        closestLink,
        isSelectingText,
        selectedText: selection?.toString()
      })
      
      if (closestButton || closestInput || closestTextarea || closestLink || isSelectingText) {
        console.log('Navigation prevented - clicked on interactive element or text is being selected')
        return
      }
      
      console.log('Navigating to thread for post:', this.props.post.id)
      // Navigate to thread page
      this.handlePostClick()
    })
  }

  private setupSandboxBridge(): void {
    // Find the iframe in the post stage
    const iframe = this.element.querySelector('.sandbox-frame') as HTMLIFrameElement
    
    if (iframe) {
      this.sandboxBridge = useSandboxBridge({
        iframe,
        post: this.props.post,
        onFreshRequest: () => this.handleFreshToggle()
      })
    } else {
      // Iframe might not be ready yet, try again after a delay
      setTimeout(() => this.setupSandboxBridge(), 100)
    }
  }

  private setupImpressionTracking(): void {
    // Track impressions when post becomes visible in viewport
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            // Post is visible, track impression
            this.trackImpression()
            // Only track once per post view
            observer.unobserve(entry.target)
          }
        })
      },
      {
        threshold: 0.5 // Track when 50% of post is visible
      }
    )

    observer.observe(this.element)
  }

  private trackImpression(): void {
    // Prevent duplicate tracking
    if (this.impressionTracked) return
    
    this.impressionTracked = true
    
    // Use global batch tracker
    impressionTracker.trackImpression(this.props.post.id)
    
    // Optimistically update impression count
    this.impressions += 1
    this.updateActions()
  }

  private handleModeChange(newMode: PostCardMode): void {
    this.mode = newMode
    if (this.postStageElement) {
      updatePostStage(this.postStageElement, {
        post: this.props.post,
        mode: this.mode,
        sandboxOrigin: this.props.sandboxOrigin,
        onModeChange: (newMode) => this.handleModeChange(newMode)
      })
    }
  }

  private async handleFreshToggle(): Promise<void> {
    // Prevent concurrent fresh requests
    if (this.freshLoading) return

    // Check if user is logged in
    if (!this.props.currentUser) {
      showSignInPrompt(
        'fresh',
        () => { window.history.pushState({}, '', '/login'); window.dispatchEvent(new PopStateEvent('popstate')) },
        () => { window.history.pushState({}, '', '/register'); window.dispatchEvent(new PopStateEvent('popstate')) }
      )
      return
    }

    const previousFreshed = this.isFreshed
    const previousCount = this.freshCount

    // Optimistic update
    this.isFreshed = !previousFreshed
    this.freshCount = previousFreshed ? previousCount - 1 : previousCount + 1

    // Update UI immediately
    this.updateActions()

    this.freshLoading = true

    try {
      const response = await fetch(`/api/posts/${this.props.post.id}/fresh`, {
        method: 'POST',
        credentials: 'include'
      })

      if (!response.ok) {
        throw new Error('Failed to toggle fresh')
      }

      const result = await response.json() as { freshed: boolean; fresh_count: number }
      
      // Sync with server response (use authoritative fresh_count from server)
      this.isFreshed = result.freshed
      this.freshCount = result.fresh_count

    } catch (error) {
      // Rollback on error
      this.isFreshed = previousFreshed
      this.freshCount = previousCount
      console.error('Failed to toggle fresh:', error)
    } finally {
      this.freshLoading = false
    }

    this.updateActions()
  }


  private handleReplyToggle(): void {
    // Check if user is logged in
    if (!this.props.currentUser) {
      showSignInPrompt(
        'reply',
        () => { window.history.pushState({}, '', '/login'); window.dispatchEvent(new PopStateEvent('popstate')) },
        () => { window.history.pushState({}, '', '/register'); window.dispatchEvent(new PopStateEvent('popstate')) }
      )
      return
    }

    // Emit custom event for thread view toggle (legacy, now handled inline)
    const event = new CustomEvent('replyToggle', {
      detail: { postId: this.props.post.id }
    })
    this.element.dispatchEvent(event)

    // Toggle inline reply composer
    this.toggleReplyComposer()
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
      this.replyComposer.getElement().style.display = 'block'
      this.isReplyComposerOpen = true
      this.replyComposer.focus()
    }
  }

  private hideReplyComposer(): void {
    if (this.replyComposer) {
      this.replyComposer.getElement().style.display = 'none'
      this.isReplyComposerOpen = false
    }
  }

  private handleReplyCreated(newReply: any): void {
    // Hide reply composer after successful reply
    this.hideReplyComposer()
    
    // Update reply count
    this.replyCount++
    this.updatePost({ reply_count: this.replyCount })
    this.updateActions()
  }

  public handleReplyTogglePublic(): void {
    this.handleReplyToggle()
  }

  private handleShare(): void {
    createShareModal({
      post: {
        id: this.props.post.id,
        text: this.props.post.text,
        username: this.props.post.username,
        display_name: this.props.post.display_name
      },
      onClose: () => {}
    })
  }

  private handlePostClick(): void {
    console.log('handlePostClick called for post:', this.props.post.id)
    
    // Navigate to thread page using SPA navigation
    const threadUrl = `/thread/${this.props.post.id}`
    console.log('Pushing state to URL:', threadUrl)
    window.history.pushState({ postId: this.props.post.id }, '', threadUrl)
    
    // Use SPA navigation event
    console.log('Dispatching SPA navigation event')
    window.dispatchEvent(new CustomEvent('spaNavigate', { 
      detail: { view: 'thread', postId: this.props.post.id } 
    }))
    
    // Also emit custom event for navigation (backup)
    console.log('Emitting navigateToThread event')
    const customEvent = new CustomEvent('navigateToThread', {
      detail: { postId: this.props.post.id }
    })
    this.element.dispatchEvent(customEvent)
    console.log('Event dispatched')
  }

  private updateActions(): void {
    const actionsContainer = this.element.querySelector('.post-actions')
    if (actionsContainer) {
      const newActions = createPostActions({
        postId: this.props.post.id,
        freshCount: this.freshCount,
        replyCount: this.replyCount,
        impressions: this.impressions,
        isFreshed: this.isFreshed,
        depth: this.props.depth ?? this.props.post.depth,
        onFreshToggle: () => this.handleFreshToggle(),
        onReplyToggle: () => this.handleReplyToggle(),
        onShare: () => this.handleShare()
      })
      actionsContainer.replaceWith(newActions)
    }
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public updatePost(post: Partial<typeof this.props.post>): void {
    if (post.reply_count !== undefined) {
      this.replyCount = post.reply_count
    }
    if (post.fresh_count !== undefined) {
      this.freshCount = post.fresh_count
    }
    if (post.is_freshed !== undefined) {
      this.isFreshed = post.is_freshed
    }
    this.props.post = { ...this.props.post, ...post }
    this.updateActions()
  }

  private createMenuButton(isOwnPost: boolean): HTMLElement {
    const menuButton = document.createElement('button')
    menuButton.className = 'post-menu-button'
    menuButton.textContent = '⋯'
    menuButton.style.cssText = `
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 18px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      transition: color 0.2s ease;
    `

    menuButton.addEventListener('mouseenter', () => {
      menuButton.style.color = 'var(--text-primary)'
    })
    menuButton.addEventListener('mouseleave', () => {
      menuButton.style.color = 'var(--text-muted)'
    })

    menuButton.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleMenu(isOwnPost)
    })

    return menuButton
  }

  private toggleMenu(isOwnPost: boolean): void {
    if (this.menuDropdown) {
      this.menuDropdown.remove()
      this.menuDropdown = undefined
      return
    }

    const dropdown = document.createElement('div')
    dropdown.className = 'post-menu-dropdown'
    dropdown.style.cssText = `
      position: absolute;
      top: 30px;
      right: 0;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      z-index: 100;
      min-width: 120px;
    `

    if (isOwnPost) {
      const deleteItem = document.createElement('button')
      deleteItem.style.cssText = `
        display: block;
        width: 100%;
        padding: 10px 16px;
        background: none;
        border: none;
        color: var(--danger, #e74c3c);
        text-align: left;
        cursor: pointer;
        font-size: 14px;
        transition: background 0.2s;
      `
      deleteItem.textContent = t('post.menu_delete')
      deleteItem.addEventListener('mouseenter', () => {
        deleteItem.style.background = 'var(--bg-secondary)'
      })
      deleteItem.addEventListener('mouseleave', () => {
        deleteItem.style.background = 'none'
      })
      deleteItem.addEventListener('click', (e) => {
        e.stopPropagation()
        this.showDeleteConfirmation()
        dropdown.remove()
        this.menuDropdown = undefined
      })
      dropdown.appendChild(deleteItem)
    } else {
      const reportItem = document.createElement('button')
      reportItem.style.cssText = `
        display: block;
        width: 100%;
        padding: 10px 16px;
        background: none;
        border: none;
        color: var(--text-primary);
        text-align: left;
        cursor: pointer;
        font-size: 14px;
        transition: background 0.2s;
      `
      reportItem.textContent = t('post.menu_report')
      reportItem.addEventListener('mouseenter', () => {
        reportItem.style.background = 'var(--bg-secondary)'
      })
      reportItem.addEventListener('mouseleave', () => {
        reportItem.style.background = 'none'
      })
      reportItem.addEventListener('click', (e) => {
        e.stopPropagation()
        dropdown.remove()
        this.menuDropdown = undefined
        // Check if user is logged in before showing report modal
        if (!this.props.currentUser) {
          showSignInPrompt(
            'report',
            () => { window.history.pushState({}, '', '/login'); window.dispatchEvent(new PopStateEvent('popstate')) },
            () => { window.history.pushState({}, '', '/register'); window.dispatchEvent(new PopStateEvent('popstate')) }
          )
          return
        }
        this.showReportModal()
      })
      dropdown.appendChild(reportItem)
    }

    const headerContainer = this.element.querySelector('.post-menu-button')?.parentElement
    if (headerContainer) {
      headerContainer.style.position = 'relative'
      headerContainer.appendChild(dropdown)
    }

    this.menuDropdown = dropdown

    const closeMenu = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node)) {
        dropdown.remove()
        this.menuDropdown = undefined
        document.removeEventListener('click', closeMenu)
      }
    }
    setTimeout(() => document.addEventListener('click', closeMenu), 0)
  }

  private showDeleteConfirmation(): void {
    const overlay = document.createElement('div')
    const unregister = registerModal()
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    `

    const dialog = document.createElement('div')
    dialog.style.cssText = `
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 24px;
      max-width: 400px;
      width: 90%;
    `

    const title = document.createElement('h3')
    title.style.cssText = 'margin: 0 0 16px 0; font-size: 18px; color: var(--text-primary);'
    title.textContent = t('post.delete_title')

    const message = document.createElement('p')
    message.style.cssText = 'margin: 0 0 24px 0; color: var(--text-muted); font-size: 14px;'
    message.textContent = t('post.delete_message')

    const buttonRow = document.createElement('div')
    buttonRow.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end;'

    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'cancel-btn'
    cancelBtn.style.cssText = 'padding: 8px 16px; background: none; border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary); cursor: pointer;'
    cancelBtn.textContent = t('common.cancel')

    const deleteBtn = document.createElement('button')
    deleteBtn.className = 'delete-btn'
    deleteBtn.style.cssText = 'padding: 8px 16px; background: var(--danger, #e74c3c); border: none; border-radius: 4px; color: #fff; cursor: pointer;'
    deleteBtn.textContent = t('common.delete')

    buttonRow.appendChild(cancelBtn)
    buttonRow.appendChild(deleteBtn)

    dialog.appendChild(title)
    dialog.appendChild(message)
    dialog.appendChild(buttonRow)

    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    cancelBtn.addEventListener('click', () => {
      unregister()
      overlay.remove()
    })

    deleteBtn.addEventListener('click', async () => {
      unregister()
      overlay.remove()
      await this.deletePost()
    })

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        unregister()
        overlay.remove()
      }
    })
  }

  private async deletePost(): Promise<void> {
    try {
      const response = await fetch(`/api/posts/${this.props.post.id}`, {
        method: 'DELETE',
        credentials: 'include'
      })

      if (!response.ok) {
        throw new Error('Failed to delete post')
      }

      this.props.onDelete?.(this.props.post.id)

      this.element.style.transition = 'opacity 0.3s, transform 0.3s'
      this.element.style.opacity = '0'
      this.element.style.transform = 'translateX(-100%)'
      setTimeout(() => {
        this.destroy()
      }, 300)

      this.showToast(t('post.deleted'))
    } catch (error) {
      console.error('Delete post error:', error)
      this.showToast(t('post.delete_failed'), true)
    }
  }

  private showReportModal(): void {
    const overlay = document.createElement('div')
    const unregister = registerModal()
    overlay.className = 'report-modal-overlay'
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    `

    const dialog = document.createElement('div')
    dialog.style.cssText = `
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 24px;
      max-width: 420px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
    `

    const categories = [
      { value: 'spam', label: t('post.report_category_spam') },
      { value: 'harassment', label: t('post.report_category_harassment') },
      { value: 'hate_speech', label: t('post.report_category_hate_speech') },
      { value: 'inappropriate', label: t('post.report_category_inappropriate') },
      { value: 'misinformation', label: t('post.report_category_misinformation') },
      { value: 'privacy', label: t('post.report_category_privacy') },
      { value: 'copyright', label: t('post.report_category_copyright') },
      { value: 'malware', label: t('post.report_category_malware') },
      { value: 'csam', label: t('post.report_category_csam') },
      { value: 'other', label: t('post.report_category_other') }
    ]

    dialog.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="margin: 0; font-size: 18px; color: var(--text-primary);">${t('post.report_title')}</h3>
        <button class="close-btn" style="
          background: none;
          border: none;
          color: var(--text-muted);
          font-size: 20px;
          cursor: pointer;
        ">✕</button>
      </div>
      <p style="margin: 0 0 16px 0; color: var(--text-muted); font-size: 14px;">${t('post.report_question')}</p>
      <div class="categories" style="margin-bottom: 24px;">
        ${categories.map(c => `
          <label style="
            display: flex;
            align-items: center;
            padding: 10px 0;
            cursor: pointer;
            color: var(--text-primary);
          ">
            <input type="radio" name="report-category" value="${c.value}" style="margin-right: 12px;">
            <span>${c.label}</span>
          </label>
        `).join('')}
      </div>
      <div class="dmca-section" style="display: none; margin-bottom: 24px; padding: 16px; background: var(--bg-secondary); border-radius: 8px;">
        <h4 style="margin: 0 0 12px 0; font-size: 14px; color: var(--text-primary);">${t('post.report_dmca_title')}</h4>
        <div style="margin-bottom: 12px;">
          <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.report_dmca_work_label')}</label>
          <input type="text" class="dmca-work" style="
            width: 100%;
            padding: 8px;
            border: 1px solid var(--border);
            border-radius: 4px;
            background: var(--bg-primary);
            color: var(--text-primary);
            font-size: 14px;
            box-sizing: border-box;
          " placeholder="${t('post.report_dmca_work_placeholder')}">
        </div>
        <div style="margin-bottom: 12px;">
          <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.report_dmca_email_label')}</label>
          <input type="email" class="dmca-email" style="
            width: 100%;
            padding: 8px;
            border: 1px solid var(--border);
            border-radius: 4px;
            background: var(--bg-primary);
            color: var(--text-primary);
            font-size: 14px;
            box-sizing: border-box;
          " placeholder="${t('post.report_dmca_email_placeholder')}">
        </div>
        <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer;">
          <input type="checkbox" class="dmca-sworn" style="margin-top: 2px;">
          <span style="font-size: 12px; color: var(--text-muted);">${t('post.report_dmca_swear')}</span>
        </label>
      </div>
      <div style="display: flex; justify-content: flex-end;">
        <button class="submit-btn" disabled style="
          padding: 10px 24px;
          background: var(--accent);
          border: none;
          border-radius: 9999px;
          color: #000;
          font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 14px;
          cursor: pointer;
          opacity: 0.5;
        ">${t('common.submit')}</button>
      </div>
    `

    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    const submitBtn = dialog.querySelector('.submit-btn') as HTMLButtonElement
    const closeBtn = dialog.querySelector('.close-btn')
    const radioInputs = dialog.querySelectorAll('input[name="report-category"]')
    const dmcaSection = dialog.querySelector('.dmca-section') as HTMLElement
    const dmcaWorkInput = dialog.querySelector('.dmca-work') as HTMLInputElement
    const dmcaEmailInput = dialog.querySelector('.dmca-email') as HTMLInputElement
    const dmcaSwornCheckbox = dialog.querySelector('.dmca-sworn') as HTMLInputElement

    let selectedCategory: string | null = null

    radioInputs.forEach(input => {
      input.addEventListener('change', (e) => {
        selectedCategory = (e.target as HTMLInputElement).value
        submitBtn.disabled = false
        submitBtn.style.opacity = '1'

        // Show/hide DMCA section
        if (selectedCategory === 'copyright') {
          dmcaSection.style.display = 'block'
        } else {
          dmcaSection.style.display = 'none'
        }
      })
    })

    const checkSubmitEnabled = () => {
      if (!selectedCategory) {
        return false
      }
      if (selectedCategory === 'copyright') {
        const workDescription = dmcaWorkInput.value.trim()
        const email = dmcaEmailInput.value.trim()
        const sworn = dmcaSwornCheckbox.checked
        return workDescription.length > 0 && email.length > 0 && sworn
      }
      return true
    }

    dmcaWorkInput?.addEventListener('input', () => {
      submitBtn.disabled = !checkSubmitEnabled()
      submitBtn.style.opacity = checkSubmitEnabled() ? '1' : '0.5'
    })

    dmcaEmailInput?.addEventListener('input', () => {
      submitBtn.disabled = !checkSubmitEnabled()
      submitBtn.style.opacity = checkSubmitEnabled() ? '1' : '0.5'
    })

    dmcaSwornCheckbox?.addEventListener('change', () => {
      submitBtn.disabled = !checkSubmitEnabled()
      submitBtn.style.opacity = checkSubmitEnabled() ? '1' : '0.5'
    })

    closeBtn?.addEventListener('click', () => {
      unregister()
      overlay.remove()
    })

    submitBtn?.addEventListener('click', async () => {
      if (!selectedCategory) return

      let dmcaData: { work_description: string; reporter_email: string; sworn: boolean } | undefined
      if (selectedCategory === 'copyright') {
        dmcaData = {
          work_description: dmcaWorkInput.value.trim(),
          reporter_email: dmcaEmailInput.value.trim(),
          sworn: dmcaSwornCheckbox.checked
        }
      }

      unregister()
      overlay.remove()
      await this.submitReport(selectedCategory, dmcaData)
    })

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        unregister()
        overlay.remove()
      }
    })
  }

  private async submitReport(category: string, dmcaData?: { work_description: string; reporter_email: string; sworn: boolean }): Promise<void> {
    try {
      const body: any = { post_id: this.props.post.id, category }
      if (dmcaData) {
        body.dmca = dmcaData
      }

      const response = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body)
      })

      if (response.status === 409) {
        this.showToast(t('post.report_already'))
        return
      }

      if (!response.ok) {
        const errorData = await response.json() as { error?: string }
        throw new Error(errorData?.error || 'Failed to submit report')
      }

      this.showToast(t('post.report_submitted'))
    } catch (error) {
      console.error('Report error:', error)
      console.error('Error details:', {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace',
        post_id: this.props.post.id,
        category: category || 'unknown'
      })
      this.showToast(t('post.report_failed'), true)
    }
  }

  private showToast(message: string, isError: boolean = false): void {
    const toast = document.createElement('div')
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: ${isError ? 'var(--danger, #e74c3c)' : 'var(--accent)'};
      color: ${isError ? '#fff' : '#000'};
      padding: 12px 24px;
      border-radius: 4px;
      font-size: 14px;
      z-index: 2000;
      animation: fadeInUp 0.3s ease;
    `
    toast.textContent = message
    document.body.appendChild(toast)

    setTimeout(() => {
      toast.style.animation = 'fadeOut 0.3s ease'
      setTimeout(() => toast.remove(), 300)
    }, 3000)
  }

  public destroy(): void {
    // Cleanup sandbox bridge
    if (this.sandboxBridge) {
      this.sandboxBridge.destroy()
      this.sandboxBridge = undefined
    }

    // Cleanup reply composer
    if (this.replyComposer) {
      this.replyComposer.destroy()
      this.replyComposer = undefined
    }

    // Cleanup menu dropdown
    if (this.menuDropdown) {
      this.menuDropdown.remove()
      this.menuDropdown = undefined
    }

    // Cleanup event listeners
    this.element.remove()
  }

  private parseHashtags(hashtagsString: string): string[] {
    try {
      const parsed = JSON.parse(hashtagsString)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  private createTagChips(hashtags: string[]): HTMLElement {
    const container = document.createElement('div')
    container.className = 'post-tag-chips'
    container.style.cssText = `
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 12px 0;
    `

    hashtags.forEach(tag => {
      const chip = document.createElement('a')
      chip.className = 'post-tag-chip'
      chip.href = `/explore?tag=${encodeURIComponent(tag)}`
      chip.textContent = `#${tag}`
      chip.style.cssText = `
        display: inline-block;
        padding: 4px 12px;
        background: var(--bg-secondary);
        color: var(--accent);
        font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        border-radius: 9999px;
        text-decoration: none;
        transition: all 0.2s ease;
      `
      
      chip.addEventListener('mouseenter', () => {
        chip.style.background = 'var(--accent)'
        chip.style.color = '#000'
      })
      
      chip.addEventListener('mouseleave', () => {
        chip.style.background = 'var(--bg-secondary)'
        chip.style.color = 'var(--accent)'
      })

      container.appendChild(chip)
    })

    return container
  }

  private createPollElement(poll: any): HTMLElement {
    const totalVotes = poll.options.reduce((sum: number, opt: any) => sum + (opt.votes_count || 0), 0)
    const hasVoted = !!poll.userVote
    const container = document.createElement('div')
    container.className = 'post-poll'
    container.style.cssText = `margin: 12px 0; padding: 12px; background: var(--bg-secondary); border-radius: 8px;`

    const question = document.createElement('div')
    question.className = 'poll-question'
    question.style.cssText = `font-weight: 600; margin-bottom: 8px; color: var(--text-primary);`
    question.textContent = poll.question
    container.appendChild(question)

    poll.options.forEach((opt: any) => {
      const optEl = document.createElement('div')
      optEl.className = 'poll-option'
      const pct = totalVotes > 0 ? Math.round((opt.votes_count / totalVotes) * 100) : 0
      optEl.style.cssText = `
        position: relative; padding: 8px 12px; margin-bottom: 6px; border-radius: 6px;
        cursor: ${hasVoted ? 'default' : 'pointer'};
        background: var(--bg-primary); overflow: hidden;
        transition: opacity 0.2s; border: 1px solid var(--border);
        ${hasVoted || opt.votes_count > 0 ? '' : 'opacity: 0.9;'}
      `

      const bar = document.createElement('div')
      bar.className = 'poll-bar'
      bar.style.cssText = `
        position: absolute; top: 0; left: 0; height: 100%; 
        background: ${opt.id === poll.userVote ? 'var(--accent)' : 'var(--bg-hover)'};
        width: ${hasVoted ? pct : 0}%; transition: width 0.5s ease; border-radius: 5px;
        opacity: ${opt.id === poll.userVote ? '0.2' : '0.5'};
      `
      optEl.appendChild(bar)

      const label = document.createElement('span')
      label.className = 'poll-option-label'
      label.style.cssText = `position: relative; z-index: 1; display: flex; justify-content: space-between; align-items: center;`
      const textSpan = document.createElement('span')
      textSpan.textContent = opt.label
      const countSpan = document.createElement('span')
      countSpan.style.cssText = `font-size: 0.8rem; color: var(--text-muted); margin-left: 8px;`
      countSpan.textContent = hasVoted ? `${pct}%` : ''
      label.appendChild(textSpan)
      label.appendChild(countSpan)
      optEl.appendChild(label)

      if (!hasVoted) {
        optEl.addEventListener('click', async () => {
          try {
            const response = await fetch(`/api/polls/${poll.id}/vote`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ optionId: opt.id })
            })
            if (response.status === 409) {
              return
            }
            if (!response.ok) return
            const data = await response.json()
            // Re-render with results
            const newPoll = { ...poll, options: data.options, userVote: data.userVote }
            container.replaceWith(this.createPollElement(newPoll))
          } catch (e) {
            console.error('Vote failed:', e)
          }
        })
        optEl.addEventListener('mouseenter', () => {
          optEl.style.borderColor = 'var(--accent)'
        })
        optEl.addEventListener('mouseleave', () => {
          optEl.style.borderColor = 'var(--border)'
        })
      }
      container.appendChild(optEl)
    })

    const footer = document.createElement('div')
    footer.style.cssText = `font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;`
    footer.textContent = `${totalVotes} vote${totalVotes !== 1 ? 's' : ''}${hasVoted ? ' · Voted' : ''}`
    container.appendChild(footer)

    return container
  }
}

// Factory function for easier usage
export function createPostCard(props: PostCardProps): PostCard {
  return new PostCard(props)
}
