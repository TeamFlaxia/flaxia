import { PostActionsProps } from '../types/post.js'
import { t } from '../lib/i18n.js'

export function createPostActions(props: PostActionsProps): HTMLElement {
  const container = document.createElement('div')
  container.className = 'post-actions'

  // Fresh! button
  const freshButton = createActionButton('fresh', props.freshCount.toString(), props.isFreshed)
  freshButton.addEventListener('click', props.onFreshToggle)

  // Reply button
  const replyButton = createActionButton('reply', props.replyCount.toString(), false)
  replyButton.addEventListener('click', props.onReplyToggle)

  // Impressions button (display only, not clickable)
  const impressionsButton = createActionButton('impressions', props.impressions.toString(), false)
  impressionsButton.style.cursor = 'default'

  // Share button
  const shareButton = createActionButton('share', '0', false)
  shareButton.addEventListener('click', () => {
    if (props.onShare) {
      props.onShare()
    }
  })

  container.appendChild(freshButton)
  if (replyButton) {
    container.appendChild(replyButton)
  }
  container.appendChild(impressionsButton)
  container.appendChild(shareButton)

  return container
}

function createActionButton(type: 'fresh' | 'reply' | 'share' | 'impressions', count: string, isActive: boolean): HTMLElement {
  const button = document.createElement('button')
  button.className = `action-button action-button--${type}`
  button.setAttribute('aria-label', t('post_actions.aria_label', { type }))
  
  if (isActive) {
    button.classList.add('action-button--active')
    // Console debug for Fresh status
    if (type === 'fresh') {
      console.log('Fresh button is active - user has freshed this post. Fresh count:', count)
    }
  }
  
  // Create icon (using text for now, will replace with Lucide icons)
  const icon = document.createElement('span')
  icon.className = 'action-icon'
  icon.textContent = getIconForType(type)
  
  button.appendChild(icon)
  
  // Add count for fresh and reply buttons only (not for share)
  if (type !== 'share') {
    const countSpan = document.createElement('span')
    countSpan.className = 'action-count'
    countSpan.textContent = count
    
    // Add debug styling for freshed posts
    if (type === 'fresh' && isActive) {
      console.log('Applying green color to fresh count for freshed post')
    }
    
    button.appendChild(countSpan)
  }
  
  return button
}

function getIconForType(type: 'fresh' | 'reply' | 'share' | 'impressions'): string {
  switch (type) {
    case 'fresh':
      return '🍃' // Leaf emoji for Fresh!
    case 'reply':
      return '💬' // Message emoji for Reply
    case 'share':
      return '🔗' // Link emoji for Share
    case 'impressions':
      return '👀' // Eye emoji for Impressions
    default:
      return ''
  }
}
