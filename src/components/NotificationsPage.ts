export interface Notification {
  id: string
  type: 'reported' | 'fresh' | 'warned' | 'hidden' | 'ap_follow' | 'ap_like' | 'ap_announce' | 'reply' | 'mention'
  post_id: string | null
  post_text_preview: string | null
  actor?: {
    username: string
    display_name: string
    avatar_key: string | null
  }
  actor_id?: string | null
  actor_data?: string | null  // JSON string for external actor info
  read: boolean
  created_at: string
}

export interface NotificationsPageProps {
  notifications: Notification[]
  unreadCount: number
  onMarkAllRead: () => Promise<void>
  onNavigateToPost: (postId: string) => void
}

export class NotificationsPage {
  private element: HTMLElement
  private props: NotificationsPageProps

  constructor(props: NotificationsPageProps) {
    this.props = props
    this.element = this.createElement()
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'notifications-page'
    container.style.cssText = `
      max-width: 600px;
      margin: 0 auto;
      padding: 24px;
    `

    // Header
    const header = document.createElement('div')
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    `

    const title = document.createElement('h1')
    title.textContent = 'Notifications'
    title.style.cssText = `
      margin: 0;
      font-size: 24px;
      color: var(--text-primary);
    `

    header.appendChild(title)

    // Mark all read button (only show if there are unread)
    if (this.props.unreadCount > 0) {
      const markAllBtn = document.createElement('button')
      markAllBtn.textContent = 'Mark all read'
      markAllBtn.style.cssText = `
        padding: 8px 16px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 4px;
        color: var(--text-primary);
        font-size: 14px;
        cursor: pointer;
        transition: background 0.2s;
      `
      markAllBtn.addEventListener('mouseenter', () => {
        markAllBtn.style.background = 'var(--bg-tertiary, #e5e5e5)'
      })
      markAllBtn.addEventListener('mouseleave', () => {
        markAllBtn.style.background = 'var(--bg-secondary)'
      })
      markAllBtn.addEventListener('click', async () => {
        await this.props.onMarkAllRead()
        this.updateAllAsRead()
      })
      header.appendChild(markAllBtn)
    }

    container.appendChild(header)

    // Notifications list
    if (this.props.notifications.length === 0) {
      const empty = document.createElement('div')
      empty.style.cssText = `
        text-align: center;
        padding: 48px 24px;
        color: var(--text-muted);
      `
      empty.textContent = 'No notifications yet'
      container.appendChild(empty)
    } else {
      const list = document.createElement('div')
      list.className = 'notifications-list'
      list.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 1px;
        border: 1px solid var(--border);
        border-radius: 8px;
        overflow: hidden;
      `

      this.props.notifications.forEach(notification => {
        const row = this.createNotificationRow(notification)
        list.appendChild(row)
      })

      container.appendChild(list)
    }

    return container
  }

  private createNotificationRow(notification: Notification): HTMLElement {
    const row = document.createElement('div')
    row.className = `notification-row ${notification.read ? 'read' : 'unread'}`
    row.style.cssText = `
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 16px;
      background: ${notification.read ? 'var(--bg-primary)' : 'var(--bg-secondary)'};
      cursor: pointer;
      transition: background 0.2s;
    `

    row.addEventListener('mouseenter', () => {
      row.style.background = 'var(--bg-tertiary, #f0f0f0)'
    })
    row.addEventListener('mouseleave', () => {
      row.style.background = notification.read ? 'var(--bg-primary)' : 'var(--bg-secondary)'
    })
    row.addEventListener('click', () => {
      if (notification.post_id) {
        this.props.onNavigateToPost(notification.post_id)
      }
      // For follow notifications, clicking doesn't navigate to a post
    })

    // Icon
    const icon = document.createElement('div')
    icon.style.cssText = `
      font-size: 20px;
      flex-shrink: 0;
    `
    switch (notification.type) {
      case 'fresh':
      case 'ap_like':
        icon.textContent = '🌿'
        break
      case 'ap_follow':
        icon.textContent = '👥'
        break
      case 'ap_announce':
        icon.textContent = '📣'
        break
      case 'reply':
        icon.textContent = '💬'
        break
      case 'mention':
        icon.textContent = '📢'
        break
      case 'reported':
        icon.textContent = '🚩'
        break
      case 'warned':
        icon.textContent = '⚠️'
        break
      case 'hidden':
        icon.textContent = '🙈'
        break
      default:
        icon.textContent = ''
    }
    row.appendChild(icon)

    // Content
    const content = document.createElement('div')
    content.style.cssText = `
      flex: 1;
      min-width: 0;
    `

    // Main text
    const mainText = document.createElement('div')
    mainText.style.cssText = `
      color: var(--text-primary);
      font-size: 14px;
      margin-bottom: 4px;
    `

    const appendMuted = (text: string) => {
      const span = document.createElement('span')
      span.style.color = 'var(--text-muted)'
      span.textContent = text
      mainText.appendChild(span)
    }

    const appendStrong = (text: string) => {
      const strong = document.createElement('strong')
      strong.textContent = text
      mainText.appendChild(strong)
    }

    switch (notification.type) {
      case 'fresh':
      case 'ap_like':
        if (notification.actor) {
          const action = notification.type === 'fresh' ? 'freshed' : 'liked'
          appendStrong(`@${notification.actor.username}`)
          mainText.appendChild(document.createTextNode(' '))
          appendMuted(`(${notification.actor.display_name})`)
          mainText.appendChild(document.createTextNode(` ${action} your post`))
        }
        break
      case 'reply':
        if (notification.actor) {
          appendStrong(`@${notification.actor.username}`)
          mainText.appendChild(document.createTextNode(' '))
          appendMuted(`(${notification.actor.display_name})`)
          mainText.appendChild(document.createTextNode(' リプライされました'))
        }
        break
      case 'mention':
        if (notification.actor) {
          appendStrong(`@${notification.actor.username}`)
          mainText.appendChild(document.createTextNode(' '))
          appendMuted(`(${notification.actor.display_name})`)
          mainText.appendChild(document.createTextNode(' にメンションされました'))
        }
        break
      case 'ap_follow':
        if (notification.actor) {
          // Local user follow
          appendStrong(`@${notification.actor.username}`)
          mainText.appendChild(document.createTextNode(' '))
          appendMuted(`(${notification.actor.display_name})`)
          mainText.appendChild(document.createTextNode(' フォローされました'))
        } else {
          // External actor follow - use actor_data if available
          let actorInfo = null
          if (notification.actor_data) {
            try {
              actorInfo = JSON.parse(notification.actor_data)
            } catch (e) {
              console.error('Failed to parse actor_data:', e)
            }
          }
          
          if (actorInfo) {
            // Display as "MastodonのXXXさんがフォローしました"
            const displayName = actorInfo.display_name || actorInfo.username || 'ユーザー'
            const domain = actorInfo.domain || 'external'
            appendStrong(`${domain} の ${displayName}さん`)
            mainText.appendChild(document.createTextNode('がフォローしました'))
          } else {
            // Fallback for existing notifications without actor_data
            const actorUrl = notification.actor_id || 'external user'
            const domain = actorUrl.includes('://') ? new URL(actorUrl).hostname : actorUrl
            appendStrong(`${domain} のユーザー`)
            mainText.appendChild(document.createTextNode('がフォローしました'))
          }
        }
        break
      case 'ap_announce':
        if (notification.actor) {
          appendStrong(`@${notification.actor.username}`)
          mainText.appendChild(document.createTextNode(' '))
          appendMuted(`(${notification.actor.display_name})`)
          mainText.appendChild(document.createTextNode(' 投稿をブーストしました'))
        } else {
          const actorUrl = notification.actor_id || 'external user'
          const domain = actorUrl.includes('://') ? new URL(actorUrl).hostname : actorUrl
          appendStrong(`${domain} のユーザー`)
          mainText.appendChild(document.createTextNode('が投稿をブーストしました'))
        }
        break
      default:
        appendStrong('あなたの投稿が複数回報告されました')
        mainText.appendChild(document.createTextNode(' 見直しし、削除を検討してください。'))
    }
    content.appendChild(mainText)

    // Post preview (only for notifications with posts)
    if (notification.post_id && notification.post_text_preview) {
      const preview = document.createElement('div')
      preview.style.cssText = `
        color: var(--text-muted);
        font-size: 13px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-bottom: 4px;
      `
      preview.textContent = notification.post_text_preview
      content.appendChild(preview)
    }

    // Time
    const time = document.createElement('div')
    time.style.cssText = `
      color: var(--text-muted);
      font-size: 12px;
    `
    time.textContent = this.formatTime(notification.created_at)
    content.appendChild(time)

    row.appendChild(content)

    return row
  }

  private formatTime(createdAt: string): string {
    const date = new Date(createdAt)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}min ago`
    if (diffHours < 24) return `${diffHours}hr ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
  }

  private updateAllAsRead(): void {
    const rows = this.element.querySelectorAll('.notification-row')
    rows.forEach(row => {
      row.classList.remove('unread')
      row.classList.add('read')
      ;(row as HTMLElement).style.background = 'var(--bg-primary)'
    })

    // Remove the "Mark all read" button
    const markAllBtn = this.element.querySelector('button')
    if (markAllBtn && markAllBtn.textContent === 'Mark all read') {
      markAllBtn.remove()
    }
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public destroy(): void {
    this.element.remove()
  }
}

export function createNotificationsPage(props: NotificationsPageProps): NotificationsPage {
  return new NotificationsPage(props)
}
