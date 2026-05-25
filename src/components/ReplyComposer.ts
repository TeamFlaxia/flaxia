import { Post } from '../types/post.js'
import DOMPurify from 'dompurify'
import { t } from '../lib/i18n.js'

export interface ReplyComposerProps {
  postId: string
  sandboxOrigin: string
  onReplyCreated: (newReply: Post) => void
  onCancel: () => void
  prefillText?: string
}

export class ReplyComposer {
  private element: HTMLElement
  private props: ReplyComposerProps
  private textarea!: HTMLTextAreaElement
  private fileInput!: HTMLInputElement
  private submitButton!: HTMLButtonElement
  private cancelButton!: HTMLButtonElement
  private charCount!: HTMLSpanElement
  private selectedFile: File | null = null
  private isSubmitting = false
  private mentionDropdown!: HTMLElement
  private mentionTimeout: ReturnType<typeof setTimeout> | null = null
  private mentionQuery: string = ''
  private mentionStartPos: number = -1

  constructor(props: ReplyComposerProps) {
    this.props = props
    this.element = this.createElement()
    this.setupEventListeners()
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'reply-composer'
    container.style.cssText = `
      border: 1px solid #e2e8f0;
      border-radius: 0;
      padding: 1rem;
      margin-top: 0.75rem;
      background: #ffffff;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `
    
    container.innerHTML = `
      <div class="reply-composer-body">
        <div class="reply-composer-header">
          <div class="reply-composer-avatar"></div>
          <textarea 
            class="reply-composer-textarea" 
            placeholder="${t('reply_composer.placeholder')}"
            maxlength="200"
          ></textarea>
        </div>
        <div class="reply-composer-file-dropzone" style="display: none;">
          <div class="dropzone-content">
            <span class="dropzone-icon">📎</span>
            <span class="dropzone-text">${t('reply_composer.file_hint')}</span>
          </div>
        </div>
        <div class="reply-composer-divider"></div>
        <div class="reply-composer-footer">
          <div class="reply-composer-actions">
            <input type="file" class="reply-composer-file-input" accept=".gif,.png,.jpg,.jpeg,.mp3,.wav,.ogg,.m4a,.webm" />
            <button class="reply-composer-file-button" type="button" style="
              background: none;
              border: none;
              color: #94a3b8;
              cursor: pointer;
              padding: 0.25rem;
              font-size: 1rem;
            ">
              📎
            </button>
            <span class="reply-composer-char-count" style="color: #94a3b8; font-size: 0.75rem;">0/200</span>
          </div>
          <div class="reply-composer-buttons">
            <button class="reply-composer-cancel" type="button" style="
              background: none;
              border: 1px solid #22c55e;
              color: #22c55e;
              padding: 0.375rem 0.75rem;
              border-radius: 0;
              font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              font-size: 0.75rem;
              cursor: pointer;
              margin-right: 0.5rem;
            ">${t('reply_composer.cancel')}</button>
            <button class="reply-composer-submit" type="button" disabled style="
              background: #22c55e;
              border: 1px solid #22c55e;
              color: #000;
              padding: 0.375rem 0.75rem;
              border-radius: 0;
              font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              font-size: 0.75rem;
              font-weight: bold;
              cursor: pointer;
            ">${t('reply_composer.reply')}</button>
          </div>
        </div>
        <div class="reply-composer-file-preview" style="display: none;">
          <div class="file-info">
            <span class="file-name"></span>
            <button class="file-remove" type="button" style="
              background: transparent;
              border: none;
              color: #64748b;
              cursor: pointer;
              font-size: 0.875rem;
              padding: 0.25rem;
              border-radius: 0.25rem;
            ">✕</button>
          </div>
        </div>
      </div>
    `

    // Cache element references
    this.textarea = container.querySelector('.reply-composer-textarea')!
    this.fileInput = container.querySelector('.reply-composer-file-input')!
    this.submitButton = container.querySelector('.reply-composer-submit')!
    this.cancelButton = container.querySelector('.reply-composer-cancel')!
    this.charCount = container.querySelector('.reply-composer-char-count')!

    // Pre-fill text if provided
    if (this.props.prefillText) {
      this.textarea.value = this.props.prefillText
      this.charCount.textContent = `${this.props.prefillText.length}/200`
    }

    // Create mention suggestion dropdown
    this.mentionDropdown = document.createElement('div')
    this.mentionDropdown.className = 'mention-dropdown'
    this.mentionDropdown.style.cssText = `
      position: absolute;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 100;
      max-height: 200px;
      overflow-y: auto;
      display: none;
      min-width: 200px;
    `
    const composerHeader = container.querySelector('.reply-composer-header')
    if (composerHeader) {
      composerHeader.style.position = 'relative'
      composerHeader.appendChild(this.mentionDropdown)
    }

    return container
  }

  private setupEventListeners(): void {
    // Textarea input handling
    this.textarea.addEventListener('input', () => {
      const length = this.textarea.value.length
      this.charCount.textContent = `${length}/200`
      if (length > 180) {
        this.charCount.style.color = length >= 200 ? '#ef4444' : '#22c55e'
      } else {
        this.charCount.style.color = '#94a3b8'
      }
      this.updateSubmitButton()
      this.handleMentionInput()
    })

    // Keyboard shortcuts
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.mentionDropdown.style.display !== 'none') {
          this.hideMentionDropdown()
          return
        }
        this.props.onCancel()
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !this.submitButton.disabled) {
        e.preventDefault()
        this.handleSubmit()
        return
      }
      if (this.mentionDropdown.style.display !== 'none') {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          this.navigateMention(e.key === 'ArrowDown' ? 1 : -1)
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const selected = this.mentionDropdown.querySelector('.mention-item--active') as HTMLElement
          if (selected) selected.click()
        }
      }
    })

    // File button click
    const fileButton = this.element.querySelector('.reply-composer-file-button')!
    fileButton.addEventListener('click', () => {
      this.fileInput.click()
    })

    // File selection
    this.fileInput.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) {
        this.handleFileSelection(file)
      }
    })

    // File removal
    const fileRemove = this.element.querySelector('.file-remove')!
    fileRemove.addEventListener('click', () => {
      this.clearFileSelection()
    })

    // Submit button
    this.submitButton.addEventListener('click', () => {
      this.handleSubmit()
    })

    // Cancel button
    this.cancelButton.addEventListener('click', () => {
      this.props.onCancel()
    })

    // Add missing event listeners
    this.textarea.addEventListener('paste', (e) => {
      this.handlePaste(e)
    })

    this.element.addEventListener('dragover', (e) => {
      console.log('Dragover event:', e)
    })

    this.element.addEventListener('drop', (e) => {
      console.log('Drop event:', e)
    })
  }

  private handleMentionInput(): void {
    const text = this.textarea.value
    const pos = this.textarea.selectionStart
    const textBeforeCursor = text.slice(0, pos)
    const atMatch = textBeforeCursor.match(/@([a-zA-Z0-9_]*)$/)

    if (atMatch && atMatch[1] !== undefined) {
      this.mentionQuery = atMatch[1]
      this.mentionStartPos = pos - atMatch[0].length
      if (this.mentionTimeout) clearTimeout(this.mentionTimeout)
      this.mentionTimeout = setTimeout(() => {
        this.fetchMentionSuggestions(this.mentionQuery || '')
      }, 200)
    } else {
      this.hideMentionDropdown()
    }
  }

  private async fetchMentionSuggestions(query: string): Promise<void> {
    try {
      const url = query ? `/api/search?type=users&q=${encodeURIComponent(query)}&limit=5` : '/api/search?type=users&q=a&limit=5'
      const response = await fetch(url, { credentials: 'include' })
      if (!response.ok) return
      const data = await response.json() as { results: Array<{ username: string; display_name: string; avatar_key: string | null }> }
      this.showMentionDropdown(data.results || [])
    } catch {
      this.hideMentionDropdown()
    }
  }

  private showMentionDropdown(users: Array<{ username: string; display_name: string; avatar_key: string | null }>): void {
    if (users.length === 0) { this.hideMentionDropdown(); return }
    this.mentionDropdown.innerHTML = ''
    users.forEach((user, index) => {
      const item = document.createElement('div')
      item.className = `mention-item ${index === 0 ? 'mention-item--active' : ''}`
      item.style.cssText = `padding: 8px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px;`
      const avatarSpan = document.createElement('span')
      avatarSpan.style.cssText = `width: 24px; height: 24px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; color: white; font-size: 0.7rem; font-weight: bold; flex-shrink: 0;`
      avatarSpan.textContent = user.username.charAt(0).toUpperCase()
      if (user.avatar_key) {
        avatarSpan.style.backgroundImage = `url(/api/images/${user.avatar_key})`
        avatarSpan.style.backgroundSize = 'cover'
        avatarSpan.style.backgroundPosition = 'center'
        avatarSpan.textContent = ''
      }
      const textSpan = document.createElement('span')
      textSpan.style.cssText = 'display: flex; flex-direction: column;'
      const nameSpan = document.createElement('span')
      nameSpan.style.cssText = 'color: var(--text-primary); font-size: 0.875rem; font-weight: 500;'
      nameSpan.textContent = user.display_name || user.username
      const handleSpan = document.createElement('span')
      handleSpan.style.cssText = 'color: var(--text-muted); font-size: 0.75rem;'
      handleSpan.textContent = `@${user.username}`
      textSpan.appendChild(nameSpan); textSpan.appendChild(handleSpan)
      item.appendChild(avatarSpan); item.appendChild(textSpan)
      item.addEventListener('click', () => this.selectMention(user.username))
      item.addEventListener('mouseenter', () => {
        this.mentionDropdown.querySelectorAll('.mention-item--active').forEach(el => el.classList.remove('mention-item--active'))
        item.classList.add('mention-item--active')
      })
      this.mentionDropdown.appendChild(item)
    })
    this.mentionDropdown.style.display = 'block'
  }

  private hideMentionDropdown(): void {
    this.mentionDropdown.style.display = 'none'
    if (this.mentionTimeout) { clearTimeout(this.mentionTimeout); this.mentionTimeout = null }
  }

  private navigateMention(direction: number): void {
    const items = this.mentionDropdown.querySelectorAll('.mention-item')
    if (items.length === 0) return
    const active = this.mentionDropdown.querySelector('.mention-item--active')
    let nextIndex = 0
    if (active) {
      const currentIndex = Array.from(items).indexOf(active)
      active.classList.remove('mention-item--active')
      nextIndex = (currentIndex + direction + items.length) % items.length
    }
    items[nextIndex].classList.add('mention-item--active')
  }

  private selectMention(username: string): void {
    if (this.mentionStartPos < 0) return
    const text = this.textarea.value
    const before = text.slice(0, this.mentionStartPos)
    const after = text.slice(this.textarea.selectionStart)
    this.textarea.value = `${before}@${username} ${after}`
    const newPos = this.mentionStartPos + username.length + 2
    this.textarea.setSelectionRange(newPos, newPos)
    this.textarea.focus()
    this.hideMentionDropdown()
    this.charCount.textContent = `${this.textarea.value.length}/200`
    this.updateSubmitButton()
  }

  private handlePaste(e: ClipboardEvent): void {
    const items = e.clipboardData?.items
    if (!items) return

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.type.indexOf('image') !== -1) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) {
          this.handleFileSelection(file)
        }
        break
      }
    }
  }

  private handleFileSelection(file: File): void {
    // Check file size (25MB limit)
    if (file.size > 25 * 1024 * 1024) {
      alert(t('reply_composer.error_file_size'))
      this.clearFileSelection()
      return
    }

    // Check if file is an accepted format
    const allowedTypes = ['image/gif', 'image/png', 'image/jpeg', 'image/jpg', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/webm']
    if (!allowedTypes.includes(file.type)) {
      alert(t('reply_composer.error_file_type'))
      this.clearFileSelection()
      return
    }

    this.selectedFile = file
    this.showFilePreview(file)
    this.updateSubmitButton()
  }

  private clearFileSelection(): void {
    this.selectedFile = null
    this.fileInput.value = ''
    this.hideFilePreview()
    this.updateSubmitButton()
  }

  private showFilePreview(file: File): void {
    const preview = this.element.querySelector('.reply-composer-file-preview')! as HTMLElement
    const fileName = preview.querySelector('.file-name')!
    
    fileName.textContent = `${file.name} (${this.formatFileSize(file.size)})`
    preview.style.display = 'block'
  }

  private hideFilePreview(): void {
    const preview = this.element.querySelector('.reply-composer-file-preview')! as HTMLElement
    preview.style.display = 'none'
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return t('file_size.bytes', { size: bytes })
    if (bytes < 1024 * 1024) return t('file_size.kb', { size: (bytes / 1024).toFixed(1) })
    return t('file_size.mb', { size: (bytes / (1024 * 1024)).toFixed(1) })
  }

  private updateSubmitButton(): void {
    const hasContent = this.textarea.value.trim().length > 0
    this.submitButton.disabled = !hasContent || this.isSubmitting
    this.submitButton.textContent = this.isSubmitting ? t('reply_composer.replying') : t('reply_composer.reply')
    
    if (this.submitButton.disabled) {
      this.submitButton.style.background = '#e2e8f0'
      this.submitButton.style.borderColor = '#e2e8f0'
      this.submitButton.style.color = '#64748b'
      this.submitButton.style.cursor = 'not-allowed'
    } else {
      this.submitButton.style.background = '#22c55e'
      this.submitButton.style.borderColor = '#22c55e'
      this.submitButton.style.color = '#000'
      this.submitButton.style.cursor = 'pointer'
    }
  }

  private async handleSubmit(): Promise<void> {
    if (this.isSubmitting) return

    const text = this.textarea.value.trim()
    if (!text) return

    this.isSubmitting = true
    this.updateSubmitButton()

    try {
      let gifKey: string | undefined
      let replyId: string | undefined

      // Step 1: Prepare reply if file is selected
      if (this.selectedFile) {
        const prepareResult = await this.prepareReply(this.selectedFile)
        if (!prepareResult) {
          throw new Error('Failed to prepare reply')
        }
        
        replyId = prepareResult.replyId
        gifKey = prepareResult.gifKey

        // Step 2: Upload file directly to R2
        const uploadSuccess = await this.uploadFileDirect(this.selectedFile, prepareResult.gifUploadUrl)
        if (!uploadSuccess) {
          throw new Error('Failed to upload file')
        }
      }

      // Step 3: Commit reply
      const commitResult = await this.commitReply(replyId, gifKey, text)
      
      if (!commitResult) {
        throw new Error('Failed to commit reply')
      }

      // Clear form
      this.textarea.value = ''
      this.charCount.textContent = '0/200'
      this.clearFileSelection()

      // Notify parent
      if (this.props.onReplyCreated && commitResult.reply) {
        this.props.onReplyCreated(commitResult.reply)
      }

    } catch (error: any) {
      console.error('Failed to create reply:', error)
      const errorMessage = error?.message || t('composer.error_create_failed')
      alert(`${errorMessage}${error?.details ? ` (${error.details})` : ''}`)
    } finally {
      this.isSubmitting = false
      this.updateSubmitButton()
    }
  }

  private async prepareReply(file: File): Promise<{ replyId: string; gifUploadUrl: string; gifKey: string } | null> {
    try {
      const response = await fetch(`/api/posts/${this.props.postId}/replies/prepare`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type
        })
      })

      if (!response.ok) {
        throw new Error('Failed to prepare reply')
      }

      return await response.json() as { replyId: string; gifUploadUrl: string; gifKey: string }
    } catch (error) {
      console.error('Prepare reply failed:', error)
      return null
    }
  }

  private async uploadFileDirect(file: File, uploadUrl: string): Promise<boolean> {
    try {
      console.log('Uploading file to:', uploadUrl, 'Type:', file.type, 'Size:', file.size)
      
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type
        },
        credentials: 'include'
      })

      console.log('Upload response status:', response.status, response.statusText)

      if (!response.ok) {
        const responseText = await response.text()
        console.error('Upload failed response:', responseText)
        
        // Try to parse as JSON, fallback to text if it fails
        let error
        try {
          error = JSON.parse(responseText)
        } catch {
          error = { error: responseText }
        }
        
        console.error('Upload failed parsed error:', error)
        return false
      }

      const responseText = await response.text()
      console.log('Upload success response:', responseText)
      
      return true
    } catch (error) {
      console.error('File upload failed:', error)
      return false
    }
  }

  private async commitReply(replyId: string | undefined, gifKey: string | undefined, text: string): Promise<{ reply: Post } | null> {
    try {
      // Extract hashtags from text
      const hashtagRegex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu
      const hashtagSet = new Set<string>()
      let match
      while ((match = hashtagRegex.exec(text)) !== null) {
        hashtagSet.add(match[1])
      }
      const hashtags = Array.from(hashtagSet)

      const response = await fetch(`/api/posts/${this.props.postId}/replies/commit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          replyId: replyId || crypto.randomUUID(), // Generate ID for text-only replies
          gifKey: gifKey,
          text,
          hashtags
        })
      })

      if (!response.ok) {
        const error = await response.json() as any
        throw new Error(error?.error || 'Failed to commit reply')
      }

      return await response.json() as { reply: Post }
    } catch (error) {
      console.error('Commit reply failed:', error)
      return null
    }
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public focus(): void {
    this.textarea.focus()
  }

  public destroy(): void {
    this.element.remove()
  }
}

// Factory function for easier usage
export function createReplyComposer(props: ReplyComposerProps): ReplyComposer {
  return new ReplyComposer(props)
}
