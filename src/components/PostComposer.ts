export interface PostComposerProps {
  onPostCreated?: (post: any) => void
  currentUser?: { username: string; display_name?: string; avatar_key?: string } | null
}

import { t } from '../lib/i18n.js'
import { getMimeType } from '../lib/file-extensions.js'
import DOMPurify from 'dompurify'

async function detectZipType(file: File): Promise<'html5' | 'dos' | null> {
  try {
    const buffer = await file.arrayBuffer()
    const view = new DataView(buffer)
    let eocdOffset = buffer.byteLength - 22
    while (eocdOffset >= 0) {
      if (view.getUint32(eocdOffset, true) === 0x06054b50) break
      eocdOffset--
    }
    if (eocdOffset < 0) return null
    const cdOffset = view.getUint32(eocdOffset + 16, true)
    const numEntries = view.getUint16(eocdOffset + 10, true)
    let hasIndexHtml = false
    let hasExe = false
    let offset = cdOffset
    for (let i = 0; i < numEntries; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) break
      const nameLen = view.getUint16(offset + 28, true)
      const extraLen = view.getUint16(offset + 30, true)
      const commentLen = view.getUint16(offset + 32, true)
      let name = ''
      for (let j = 0; j < nameLen; j++) name += String.fromCharCode(view.getUint8(offset + 46 + j))
      const lower = name.toLowerCase()
      if (lower === 'index.html' || lower === 'index.htm') hasIndexHtml = true
      if (lower.endsWith('.exe') || lower.endsWith('.bat') || lower.endsWith('.com')) hasExe = true
      offset += 46 + nameLen + extraLen + commentLen
    }
    if (hasIndexHtml) return 'html5'
    if (hasExe) return 'dos'
    return null
  } catch { return null }
}

export class PostComposer {
  private element: HTMLElement
  private props: PostComposerProps
  private textarea!: HTMLTextAreaElement
  private fileInput!: HTMLInputElement
  private thumbnailInput!: HTMLInputElement
  private submitButton!: HTMLButtonElement
  private charCount!: HTMLSpanElement
  private selectedFile: File | null = null
  private selectedThumbnail: File | null = null
  private zipType: 'html5' | 'dos' | null = null
  private isSubmitting = false
  private dragCounter = 0
  private errorDisplay!: HTMLElement
  private mentionDropdown!: HTMLElement
  private mentionTimeout: ReturnType<typeof setTimeout> | null = null
  private mentionQuery: string = ''
  private mentionStartPos: number = -1
  private pollActive: boolean = false
  private pollQuestion: string = ''
  private pollOptionsArr: string[] = ['', '']

  constructor(props: PostComposerProps) {
    this.props = props
    this.element = this.createElement()
    this.setupEventListeners()
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'post-composer'
    
    container.innerHTML = `
      <div class="composer-body">
        <div class="composer-header">
          <div class="composer-avatar"></div>
          <textarea 
            class="composer-textarea" 
            placeholder="${t('composer.placeholder')}"
            maxlength="200"
          ></textarea>
        </div>
        <div class="composer-file-dropzone" style="display: none;">
          <div class="dropzone-content">
            <span class="dropzone-icon">📎</span>
            <span class="dropzone-text">${t('composer.file_hint')}</span>
          </div>
        </div>
        <div class="composer-divider"></div>
        <div class="composer-footer">
          <div class="composer-actions">
            <input type="file" class="composer-file-input" accept=".js,.wasm,.html,.gif,.png,.jpg,.jpeg,.mp3,.wav,.ogg,.m4a,.webm,.zip,.swf,.jsdos" />
            <button class="composer-file-button" type="button">
              📎
            </button>
            <button class="composer-poll-button" type="button" title="Add poll">
              📊
            </button>
            <span class="composer-char-count">${t('composer.char_count', { current: 0, max: 200 })}</span>
          </div>
          <button class="composer-submit" type="button" disabled>
            ${t('composer.post_button')}
          </button>
        </div>
        <div class="composer-poll-section" style="display: none;">
          <div class="poll-form">
            <input type="text" class="poll-question-input" placeholder="Ask a question..." maxlength="100" />
            <div class="poll-options-list"></div>
            <button class="poll-add-option" type="button">+ Add option</button>
          </div>
        </div>
        <div class="composer-file-preview" style="display: none;">
          <div class="file-info">
            <span class="file-name"></span>
            <button class="file-remove" type="button">✕</button>
          </div>
        </div>
        <div class="composer-thumbnail-section" style="display: none;">
          <div class="thumbnail-header">
            <span>${t('composer.thumbnail_label')}</span>
          </div>
          <div class="thumbnail-input-area">
            <input type="file" class="composer-thumbnail-input" accept=".jpg,.jpeg,.png,.gif" />
            <button class="thumbnail-button" type="button">
              ${t('composer.thumbnail_button')}
            </button>
            <span class="thumbnail-hint">${t('composer.thumbnail_hint')}</span>
          </div>
          <div class="thumbnail-preview" style="display: none;">
            <img class="thumbnail-image" />
            <button class="thumbnail-remove" type="button">✕</button>
          </div>
        </div>
      </div>
    `

    // Cache element references
    this.textarea = container.querySelector('.composer-textarea')!
    this.fileInput = container.querySelector('.composer-file-input')!
    this.thumbnailInput = container.querySelector('.composer-thumbnail-input')!
    this.submitButton = container.querySelector('.composer-submit')!
    this.charCount = container.querySelector('.composer-char-count')!

    // Create error display element
    this.errorDisplay = document.createElement('div')
    this.errorDisplay.className = 'composer-error'
    this.errorDisplay.style.display = 'none'
    const body = container.querySelector('.composer-body')
    if (body) {
      body.insertBefore(this.errorDisplay, body.querySelector('.composer-file-preview'))
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
    const composerHeader = container.querySelector('.composer-header')
    if (composerHeader) {
      composerHeader.style.position = 'relative'
      composerHeader.appendChild(this.mentionDropdown)
    }

    // Set avatar
    const avatar = container.querySelector('.composer-avatar') as HTMLElement
    if (this.props.currentUser) {
      avatar.style.width = '40px'
      avatar.style.height = '40px'
      avatar.style.borderRadius = '50%'
      avatar.style.display = 'flex'
      avatar.style.alignItems = 'center'
      avatar.style.justifyContent = 'center'
      avatar.style.fontSize = '1.2rem'
      avatar.style.color = 'white'
      avatar.style.background = 'var(--accent)'
      avatar.style.flexShrink = '0'
      
      if (this.props.currentUser.avatar_key) {
        avatar.style.backgroundImage = `url(/api/images/${this.props.currentUser.avatar_key})`
        avatar.style.backgroundSize = 'cover'
        avatar.style.backgroundPosition = 'center'
        avatar.textContent = ''
      } else {
        avatar.textContent = this.props.currentUser.username.charAt(0).toUpperCase()
      }
    }

    return container
  }

  private setupEventListeners(): void {
    // Drag and drop handlers on the outermost container
    this.element.addEventListener('dragover', (e) => this.handleDragOver(e))
    this.element.addEventListener('dragleave', (e) => this.handleDragLeave(e))
    this.element.addEventListener('drop', (e) => this.handleDrop(e))

    // Textarea input handling
    this.textarea.addEventListener('input', () => {
      const length = this.textarea.value.length
      this.charCount.textContent = t('composer.char_count', { current: length, max: 200 })
      if (length > 180) {
        this.charCount.style.color = length >= 200 ? 'var(--danger)' : 'var(--accent)'
      } else {
        this.charCount.style.color = 'var(--text-muted)'
      }
      this.updateSubmitButton()
      this.handleMentionInput()
    })

    // Textarea keydown for inline hashtag detection - DISABLED for unified approach
    this.textarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !this.submitButton.disabled) {
        e.preventDefault()
        this.handleSubmit()
        return
      }
    })

    // File button click
    const fileButton = this.element.querySelector('.composer-file-button')!
    fileButton.addEventListener('click', () => {
      this.fileInput.click()
    })

    // File selection - from both click and drop
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

    // Thumbnail button click
    const thumbnailButton = this.element.querySelector('.thumbnail-button')!
    thumbnailButton.addEventListener('click', () => {
      this.thumbnailInput.click()
    })

    // Thumbnail selection
    this.thumbnailInput.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) {
        this.handleThumbnailSelection(file)
      }
    })

    // Thumbnail removal
    const thumbnailRemove = this.element.querySelector('.thumbnail-remove')!
    thumbnailRemove.addEventListener('click', () => {
      this.clearThumbnailSelection()
    })

    // Submit button
    this.submitButton.addEventListener('click', () => {
      this.handleSubmit()
    })

    // Poll button toggle
    const pollButton = this.element.querySelector('.composer-poll-button')!
    pollButton.addEventListener('click', () => {
      this.togglePollSection()
    })

    // Poll question input
    const pollQuestion = this.element.querySelector('.poll-question-input') as HTMLInputElement
    if (pollQuestion) {
      pollQuestion.addEventListener('input', () => {
        this.pollQuestion = pollQuestion.value
        this.updateSubmitButton()
      })
    }

    // Poll add option button
    const addOptionBtn = this.element.querySelector('.poll-add-option')!
    addOptionBtn.addEventListener('click', () => {
      this.addPollOption()
    })

    // Keyboard shortcuts
    this.textarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !this.submitButton.disabled) {
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
          if (selected) {
            selected.click()
          }
        } else if (e.key === 'Escape') {
          this.hideMentionDropdown()
        }
      }
    })

    // Clipboard paste support
    this.textarea.addEventListener('paste', (e) => {
      this.handlePaste(e)
    })
  }

  private handleMentionInput(): void {
    const text = this.textarea.value
    const pos = this.textarea.selectionStart

    // Find the @ being typed
    const textBeforeCursor = text.slice(0, pos)
    const atMatch = textBeforeCursor.match(/@([a-zA-Z0-9_]*)$/)

    if (atMatch && atMatch[1] !== undefined) {
      this.mentionQuery = atMatch[1]
      this.mentionStartPos = pos - atMatch[0].length

      if (this.mentionTimeout) clearTimeout(this.mentionTimeout)
      this.mentionTimeout = setTimeout(() => {
        if (this.mentionQuery.length > 0) {
          this.fetchMentionSuggestions(this.mentionQuery)
        } else {
          this.fetchMentionSuggestions('')
        }
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
      const users = data.results || []
      this.showMentionDropdown(users)
    } catch {
      this.hideMentionDropdown()
    }
  }

  private showMentionDropdown(users: Array<{ username: string; display_name: string; avatar_key: string | null }>): void {
    if (users.length === 0) {
      this.hideMentionDropdown()
      return
    }

    this.mentionDropdown.innerHTML = ''
    users.forEach((user, index) => {
      const item = document.createElement('div')
      item.className = `mention-item ${index === 0 ? 'mention-item--active' : ''}`
      item.style.cssText = `
        padding: 8px 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        transition: background 0.15s;
      `
      const avatarSpan = document.createElement('span')
      avatarSpan.style.cssText = `
        width: 24px; height: 24px; border-radius: 50%;
        background: var(--accent); display: flex; align-items: center;
        justify-content: center; color: white; font-size: 0.7rem; font-weight: bold; flex-shrink: 0;
      `
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

      textSpan.appendChild(nameSpan)
      textSpan.appendChild(handleSpan)
      item.appendChild(avatarSpan)
      item.appendChild(textSpan)

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
    if (this.mentionTimeout) {
      clearTimeout(this.mentionTimeout)
      this.mentionTimeout = null
    }
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
    this.charCount.textContent = t('composer.char_count', { current: this.textarea.value.length, max: 200 })
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

  private validateFile(file: File): { valid: boolean; error?: string } {
    const maxSize = 25 * 1024 * 1024
    if (file.size > maxSize) {
      return { valid: false, error: t('composer.error_file_too_large') }
    }

    // Check file extension
    const ext = file.name.toLowerCase().split('.').pop()
    const allowedExts = ['gif', 'jpg', 'jpeg', 'png', 'swf', 'js', 'wasm', 'zip', 'rsp', 'jsdos', 'mp3', 'wav', 'ogg', 'm4a', 'webm']
    
    if (!ext || !allowedExts.includes(ext)) {
      return { valid: false, error: t('composer.error_unsupported_type') }
    }

    return { valid: true }
  }

  private handleDragOver(e: DragEvent): void {
    e.preventDefault()
    this.dragCounter++
    this.element.style.border = '1px dashed var(--accent)'
    this.element.style.background = 'var(--bg-secondary)'
  }

  private handleDragLeave(e: DragEvent): void {
    this.dragCounter--
    if (this.dragCounter === 0) {
      this.element.style.border = ''
      this.element.style.background = ''
    }
  }

  private handleDrop(e: DragEvent): void {
    e.preventDefault()
    this.dragCounter = 0
    this.element.style.border = ''
    this.element.style.background = ''

    const files = e.dataTransfer?.files
    if (files && files.length > 0) {
      // Only process the first file
      const file = files[0]
      this.handleFileSelection(file)
    }
  }

  private showError(message: string): void {
    this.errorDisplay.textContent = message
    this.errorDisplay.style.display = 'block'
    this.errorDisplay.style.color = 'var(--danger)'
    this.errorDisplay.style.fontSize = '0.875rem'
    this.errorDisplay.style.fontFamily = 'monospace'
    this.errorDisplay.style.marginTop = '0.5rem'
  }

  private clearError(): void {
    this.errorDisplay.textContent = ''
    this.errorDisplay.style.display = 'none'
  }

  private handleFileSelection(file: File): void {
    this.clearError()

    const validation = this.validateFile(file)
    if (!validation.valid) {
      this.showError(validation.error!)
      this.clearFileSelection()
      return
    }

    // Check if file is an accepted format (MIME type validation)
    const allowedTypes = ['image/gif', 'image/png', 'image/jpeg', 'image/jpg', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/webm', 'application/zip', 'application/x-shockwave-flash', 'application/javascript', 'text/javascript', 'application/wasm', 'text/plain']
    
    // Also check file extension for SWF files (browsers may not report correct MIME type)
    const isSwfByExtension = file.name.toLowerCase().endsWith('.swf')
    const isValidType = allowedTypes.includes(file.type) || isSwfByExtension || file.name.toLowerCase().endsWith('.js') || file.name.toLowerCase().endsWith('.wasm') || file.name.toLowerCase().endsWith('.zip') || file.name.toLowerCase().endsWith('.rsp') || file.name.toLowerCase().endsWith('.jsdos')
    
    if (!isValidType) {
      this.showError(t('composer.error_unsupported_type'))
      this.clearFileSelection()
      return
    }

    this.selectedFile = file
    this.showFilePreview(file)

    // Detect ZIP type for DOS vs HTML5
    const isZip = file.name.toLowerCase().endsWith('.zip')
    const isJsdos = file.name.toLowerCase().endsWith('.jsdos')
    if (isZip) {
      this.zipType = null
      detectZipType(file).then(type => {
        this.zipType = type
        if (type === 'dos') {
          const fileInfo = this.element.querySelector('.file-name') as HTMLElement
          if (fileInfo) fileInfo.textContent = file.name + ' (DOS)'
        }
      })
    } else if (isJsdos) {
      this.zipType = 'dos'
      const fileInfo = this.element.querySelector('.file-name') as HTMLElement
      if (fileInfo) fileInfo.textContent = file.name + ' (DOS)'
    } else {
      this.zipType = null
    }

    // Show thumbnail section for ZIP, JSDOS, or SWF files
    const isSwf = file.name.toLowerCase().endsWith('.swf')
    if (isZip || isJsdos || isSwf) {
      this.showThumbnailSection()
    } else {
      this.hideThumbnailSection()
    }

    this.updateSubmitButton()
  }

  private clearFileSelection(): void {
    this.selectedFile = null
    this.zipType = null
    this.fileInput.value = ''
    this.hideFilePreview()
    this.hideThumbnailSection()
    this.clearThumbnailSelection()
    this.clearError()
    this.updateSubmitButton()
  }

  private handleThumbnailSelection(file: File): void {
    this.clearError()

    // Validate thumbnail size (1MB max)
    if (file.size > 1024 * 1024) {
      this.showError(t('composer.error_thumbnail_size'))
      this.clearThumbnailSelection()
      return
    }

    // Validate thumbnail extension
    const allowedExts = ['jpg', 'jpeg', 'png', 'gif']
    const ext = file.name.toLowerCase().split('.').pop()
    if (!ext || !allowedExts.includes(ext)) {
      this.showError(t('composer.error_thumbnail_type'))
      this.clearThumbnailSelection()
      return
    }

    this.selectedThumbnail = file
    this.showThumbnailPreview(file)
  }

  private clearThumbnailSelection(): void {
    this.selectedThumbnail = null
    this.thumbnailInput.value = ''
    this.hideThumbnailPreview()
  }

  private showThumbnailSection(): void {
    const section = this.element.querySelector('.composer-thumbnail-section') as HTMLElement
    if (section) {
      section.style.display = 'block'
    }
  }

  private hideThumbnailSection(): void {
    const section = this.element.querySelector('.composer-thumbnail-section') as HTMLElement
    if (section) {
      section.style.display = 'none'
    }
    this.clearThumbnailSelection()
  }

  private showThumbnailPreview(file: File): void {
    const preview = this.element.querySelector('.thumbnail-preview') as HTMLElement
    const image = preview.querySelector('.thumbnail-image') as HTMLImageElement
    
    image.src = URL.createObjectURL(file)
    preview.style.display = 'block'
  }

  private hideThumbnailPreview(): void {
    const preview = this.element.querySelector('.thumbnail-preview') as HTMLElement
    const image = preview.querySelector('.thumbnail-image') as HTMLImageElement
    
    if (image.src.startsWith('blob:')) {
      URL.revokeObjectURL(image.src)
    }
    preview.style.display = 'none'
  }

  private togglePollSection(): void {
    this.pollActive = !this.pollActive
    const section = this.element.querySelector('.composer-poll-section') as HTMLElement
    section.style.display = this.pollActive ? 'block' : 'none'
    if (!this.pollActive) {
      this.pollQuestion = ''
      this.pollOptionsArr = ['', '']
      this.renderPollOptions()
      const questionInput = this.element.querySelector('.poll-question-input') as HTMLInputElement
      if (questionInput) questionInput.value = ''
    }
    this.updateSubmitButton()
  }

  private addPollOption(): void {
    if (this.pollOptionsArr.length >= 10) return
    this.pollOptionsArr.push('')
    this.renderPollOptions()
  }

  private removePollOption(index: number): void {
    if (this.pollOptionsArr.length <= 2) return
    this.pollOptionsArr.splice(index, 1)
    this.renderPollOptions()
  }

  private renderPollOptions(): void {
    const list = this.element.querySelector('.poll-options-list') as HTMLElement
    if (!list) return
    list.innerHTML = ''
    this.pollOptionsArr.forEach((val, i) => {
      const item = document.createElement('div')
      item.className = 'poll-option-row'
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'poll-option-input'
      input.placeholder = `Option ${i + 1}`
      input.maxLength = 50
      input.value = val
      input.addEventListener('input', () => {
        this.pollOptionsArr[i] = input.value
        this.updateSubmitButton()
      })
      item.appendChild(input)
      if (this.pollOptionsArr.length > 2) {
        const removeBtn = document.createElement('button')
        removeBtn.type = 'button'
        removeBtn.className = 'poll-option-remove'
        removeBtn.textContent = '✕'
        removeBtn.addEventListener('click', () => this.removePollOption(i))
        item.appendChild(removeBtn)
      }
      list.appendChild(item)
    })
  }

  private getPollData(): { question: string; options: string[]; multipleChoice: boolean } | null {
    if (!this.pollActive) return null
    const question = this.pollQuestion.trim()
    const options = this.pollOptionsArr.map(o => o.trim()).filter(o => o.length > 0)
    if (!question || options.length < 2) return null
    return { question, options, multipleChoice: false }
  }

  private showFilePreview(file: File): void {
    const preview = this.element.querySelector('.composer-file-preview')! as HTMLElement
    const fileName = preview.querySelector('.file-name')!
    
    fileName.textContent = `${file.name} (${this.formatFileSize(file.size)})`
    preview.style.display = 'block'
  }

  private hideFilePreview(): void {
    const preview = this.element.querySelector('.composer-file-preview')! as HTMLElement
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
    this.submitButton.textContent = this.isSubmitting ? t('composer.posting') : t('composer.post_button')
  }

  private async handleSubmit(): Promise<void> {
    if (this.isSubmitting) return

    const text = this.textarea.value.trim()
    if (!text) return

    this.isSubmitting = true
    this.updateSubmitButton()

    try {
      let postId: string | undefined
      let gifKey: string | undefined
      let zipKey: string | undefined
      let swfKey: string | undefined

      // Step 1: Prepare post if file is selected
      if (this.selectedFile) {
        const prepareResult = await this.preparePost(this.selectedFile)
        if (!prepareResult) {
          throw new Error('Failed to prepare post')
        }
        
        postId = prepareResult.postId
        
        if (prepareResult.zipUploadUrl && prepareResult.zipKey) {
          // ZIP file upload
          zipKey = prepareResult.zipKey
          const uploadSuccess = await this.uploadFileDirect(this.selectedFile, prepareResult.zipUploadUrl)
          if (!uploadSuccess) {
            throw new Error('Failed to upload ZIP file')
          }
        } else if (prepareResult.swfUploadUrl && prepareResult.swfKey) {
          // SWF file upload
          swfKey = prepareResult.swfKey
          const uploadSuccess = await this.uploadFileDirect(this.selectedFile, prepareResult.swfUploadUrl)
          if (!uploadSuccess) {
            throw new Error('Failed to upload SWF file')
          }
        } else if (prepareResult.gifUploadUrl && prepareResult.gifKey) {
          // Image/audio file upload
          gifKey = prepareResult.gifKey
          const uploadSuccess = await this.uploadFileDirect(this.selectedFile, prepareResult.gifUploadUrl)
          if (!uploadSuccess) {
            throw new Error('Failed to upload file')
          }
        }
      }

      // Step 2: Create post using multipart form data if thumbnail is present, otherwise use commit
      let commitResult: any
      const poll = this.getPollData()
      if (this.selectedThumbnail && (zipKey || swfKey)) {
        // Use multipart form data for thumbnail upload
        const formData = new FormData()
        formData.append('text', text)
        if (gifKey) formData.append('gifKey', gifKey)
        if (zipKey) formData.append('payloadKey', zipKey)
        if (swfKey) formData.append('swfKey', swfKey)
        formData.append('thumbnail', this.selectedThumbnail)
        if (poll) formData.append('poll', JSON.stringify(poll))

        const response = await fetch('/api/posts', {
          method: 'POST',
          credentials: 'include',
          body: formData
        })

        if (!response.ok) {
          let errMsg = 'Failed to create post'
          try {
            const errBody = await response.json() as any
            if (errBody?.error) errMsg += `: ${errBody.error}`
          } catch {
            const errText = await response.text().catch(() => '')
            if (errText) errMsg += `: ${errText.slice(0, 200)}`
          }
          throw new Error(errMsg)
        }

        commitResult = await response.json()
      } else {
        // Use existing commit flow for posts without thumbnails
        commitResult = await this.commitPost(postId, gifKey, zipKey, swfKey, text, poll)
        
        if (!commitResult) {
          throw new Error('Failed to commit post')
        }
      }

      // Clear form
      this.textarea.value = ''
      this.charCount.textContent = t('composer.char_count', { current: 0, max: 200 })
      this.clearFileSelection()
      if (this.pollActive) this.togglePollSection()

      // Notify parent
      if (this.props.onPostCreated && commitResult.post) {
        this.props.onPostCreated(commitResult.post)
      }

    } catch (error: any) {
      console.error('Failed to create post:', error)
      const errorMessage = error?.message || t('composer.error_create_failed')
      alert(`${errorMessage}${error?.details ? ` (${error.details})` : ''}`)
    } finally {
      this.isSubmitting = false
      this.updateSubmitButton()
    }
  }

  private async preparePost(file: File): Promise<{ postId: string; gifUploadUrl?: string; gifKey?: string; zipUploadUrl?: string; zipKey?: string; swfUploadUrl?: string; swfKey?: string } | null> {
    try {
      const response = await fetch('/api/posts/prepare', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || getMimeType(file.name),
          payloadType: this.zipType === 'dos' ? 'dos' : undefined
        })
      })

      if (!response.ok) {
        let errMsg = 'Failed to prepare post'
        try {
          const errBody = await response.json() as any
          if (errBody?.error) errMsg += `: ${errBody.error}`
        } catch {}
        throw new Error(errMsg)
      }

      const result = await response.json() as any
      
      // Handle ZIP, SWF, and non-ZIP responses
      if (result.zipUploadUrl && result.zipKey) {
        return {
          postId: result.postId,
          zipUploadUrl: result.zipUploadUrl,
          zipKey: result.zipKey
        }
      } else if (result.swfUploadUrl && result.swfKey) {
        return {
          postId: result.postId,
          swfUploadUrl: result.swfUploadUrl,
          swfKey: result.swfKey
        }
      } else {
        return {
          postId: result.postId,
          gifUploadUrl: result.gifUploadUrl,
          gifKey: result.gifKey
        }
      }
    } catch (error) {
      console.error('Prepare post failed:', error)
      throw error
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

  private async commitPost(postId: string | undefined, gifKey: string | undefined, zipKey: string | undefined, swfKey: string | undefined, text: string, poll?: { question: string; options: string[]; multipleChoice: boolean } | null): Promise<{ post: any } | null> {
    try {
      // Extract hashtags from text - support Japanese and other Unicode characters
      const hashtagRegex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu
      const hashtagSet = new Set<string>()
      let match
      while ((match = hashtagRegex.exec(text)) !== null) {
        hashtagSet.add(match[1])
      }
      const hashtags = Array.from(hashtagSet)

      const response = await fetch('/api/posts/commit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          postId: postId || crypto.randomUUID(), // Generate ID for text-only posts
          gifKey: gifKey,
          zipKey: zipKey,
          swfKey: swfKey,
          text,
          hashtags,
          poll: poll || undefined
        })
      })

      if (!response.ok) {
        let errMsg = 'Failed to commit post'
        try {
          const errBody = await response.json() as any
          if (errBody?.error) errMsg += `: ${errBody.error}`
        } catch {
          const errText = await response.text().catch(() => '')
          if (errText) errMsg += `: ${errText.slice(0, 200)}`
        }
        throw new Error(errMsg)
      }

      return await response.json() as { post: any }
    } catch (error) {
      console.error('Commit post failed:', error)
      return null
    }
  }

  private async uploadFile(file: File): Promise<{ key: string } | null> {
    try {
      // Get presigned URL
      const presignResponse = await fetch('/api/upload/presigned', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type,
          size: file.size
        })
      })

      if (!presignResponse.ok) {
        throw new Error('Failed to get upload URL')
      }

      const { uploadUrl, key } = await presignResponse.json() as { uploadUrl: string; key: string }

      // For now, we'll simulate the upload since we don't have proper presigned URLs
      // In production, this would upload to the presigned URL
      console.log('Uploading file:', file.name, 'to key:', key)
      
      // Simulate upload delay
      await new Promise(resolve => setTimeout(resolve, 1000))

      return { key }

    } catch (error) {
      console.error('File upload failed:', error)
      return null
    }
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public focus(): void {
    this.textarea.focus()
  }

  public updateCurrentUser(currentUser: { username: string; display_name?: string; avatar_key?: string } | null): void {
    this.props.currentUser = currentUser
    this.updateAvatar()
  }

  private updateAvatar(): void {
    const avatar = this.element.querySelector('.composer-avatar') as HTMLElement
    if (!avatar) return

    if (this.props.currentUser) {
      avatar.style.width = '40px'
      avatar.style.height = '40px'
      avatar.style.borderRadius = '50%'
      avatar.style.display = 'flex'
      avatar.style.alignItems = 'center'
      avatar.style.justifyContent = 'center'
      avatar.style.fontSize = '1.2rem'
      avatar.style.color = 'white'
      avatar.style.background = 'var(--accent)'
      avatar.style.flexShrink = '0'
      
      if (this.props.currentUser.avatar_key) {
        avatar.style.backgroundImage = `url(/api/images/${this.props.currentUser.avatar_key})`
        avatar.style.backgroundSize = 'cover'
        avatar.style.backgroundPosition = 'center'
        avatar.textContent = ''
      } else {
        avatar.textContent = this.props.currentUser.username.charAt(0).toUpperCase()
      }
    }
  }

  public destroy(): void {
    this.element.remove()
  }
}

// Factory function for easier usage
export function createPostComposer(props: PostComposerProps): PostComposer {
  return new PostComposer(props)
}
