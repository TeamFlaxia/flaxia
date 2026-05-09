import { Post, PostCardMode } from '../types/post.js'
import { createPostCard } from './PostCard.js'

export interface CurrentTopicProps {
  onTopicClick: (post: Post) => void
  sandboxOrigin: string
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null
}

interface CurrentTopicState {
  topic: (Post & { type: 'flash' | 'html' }) | null
  loading: boolean
  error: string | null
  expanded: boolean
  postCard: ReturnType<typeof createPostCard> | null
}

export function createCurrentTopic(props: CurrentTopicProps): {
  getElement: () => HTMLElement
  destroy: () => void
} {
  let state: CurrentTopicState = {
    topic: null,
    loading: true,
    error: null,
    expanded: false,
    postCard: null
  }

  let updateTimer: number | null = null

  // Create main container
  const container = document.createElement('div')
  container.className = 'current-topic-container'
  container.style.cssText = `
    margin-bottom: 16px;
    padding: 12px 16px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    border-radius: 12px;
    color: white;
    position: relative;
    overflow: hidden;
    transition: all 0.3s ease;
  `

  // Create content elements
  const header = document.createElement('div')
  header.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  `

  const title = document.createElement('div')
  title.textContent = '今のお題'
  title.style.cssText = `
    font-size: 14px;
    font-weight: 600;
    opacity: 0.9;
  `

  const badge = document.createElement('div')
  badge.textContent = '🎯'
  badge.style.cssText = `
    font-size: 16px;
  `

  header.appendChild(title)
  header.appendChild(badge)

  const content = document.createElement('div')
  content.style.cssText = `
    min-height: 40px;
    display: flex;
    align-items: center;
    cursor: pointer;
    position: relative;
  `

  const loadingElement = document.createElement('div')
  loadingElement.innerHTML = `
    <div style="display: flex; align-items: center; gap: 8px;">
      <div style="width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3); border-top: 2px solid white; border-radius: 50%; animation: spin 1s linear infinite;"></div>
      <span style="font-size: 14px;">お題を読み込み中...</span>
    </div>
    <style>
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    </style>
  `

  const errorElement = document.createElement('div')
  errorElement.style.cssText = `
    font-size: 14px;
    opacity: 0.8;
    font-style: italic;
  `
  errorElement.textContent = 'お題が見つかりませんでした'

  const topicElement = document.createElement('div')
  topicElement.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
  `

  const topicText = document.createElement('div')
  topicText.style.cssText = `
    font-size: 14px;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  `

  const topicMeta = document.createElement('div')
  topicMeta.style.cssText = `
    font-size: 12px;
    opacity: 0.8;
    display: flex;
    align-items: center;
    gap: 8px;
  `

  topicElement.appendChild(topicText)
  topicElement.appendChild(topicMeta)

  content.appendChild(loadingElement)

  // Assemble container
  container.appendChild(header)
  container.appendChild(content)

  // Fetch current topic
  async function fetchCurrentTopic() {
    try {
      state.loading = true
      state.error = null
      render()

      const response = await fetch('/api/current-topic')
      if (!response.ok) {
        if (response.status === 404) {
          state.error = 'お題が見つかりませんでした'
        } else {
          throw new Error('Failed to fetch current topic')
        }
        return
      }

      const topic = await response.json() as Post & { type: 'flash' | 'html' }
      state.topic = topic
      state.error = null
    } catch (error) {
      console.error('Failed to fetch current topic:', error)
      state.error = '読み込みに失敗しました'
    } finally {
      state.loading = false
      render()
    }
  }

  // Render function
  function render() {
    content.innerHTML = ''

    if (state.loading) {
      content.appendChild(loadingElement)
    } else if (state.error) {
      content.appendChild(errorElement)
    } else if (state.topic) {
      if (state.expanded && state.postCard) {
        // Show expanded PostCard
        content.appendChild(state.postCard.getElement())
      } else {
        // Show chip view
        content.appendChild(topicElement)
        
        // Update topic content
        topicText.textContent = state.topic.text
        
        const typeIcon = state.topic.type === 'flash' ? '⚡' : '🚀'
        const displayName = state.topic.display_name || state.topic.username
        topicMeta.innerHTML = `
          <span>${typeIcon} ${displayName}</span>
          <span>•</span>
          <span>${new Date(state.topic.created_at).toLocaleDateString('ja-JP')}</span>
        `
      }
    }
  }

  // Click handler
  content.addEventListener('click', () => {
    if (state.topic) {
      if (!state.expanded) {
        // Create PostCard if not exists
        if (!state.postCard) {
          state.postCard = createPostCard({
            post: state.topic,
            sandboxOrigin: props.sandboxOrigin,
            currentUser: props.currentUser,
            initialMode: PostCardMode.PREVIEW
          })
        }
        state.expanded = true
      } else {
        state.expanded = false
      }
      render()
    }
  })

  // Hover effects
  container.addEventListener('mouseenter', () => {
    if (state.topic) {
      container.style.transform = 'translateY(-2px)'
      container.style.boxShadow = '0 8px 25px rgba(102, 126, 234, 0.3)'
    }
  })

  container.addEventListener('mouseleave', () => {
    container.style.transform = 'translateY(0)'
    container.style.boxShadow = 'none'
  })

  // Auto-refresh every hour
  function startAutoRefresh() {
    updateTimer = window.setInterval(() => {
      fetchCurrentTopic()
    }, 60 * 60 * 1000) // 1 hour
  }

  // Initial fetch
  fetchCurrentTopic()
  startAutoRefresh()

  return {
    getElement: () => container,
    destroy: () => {
      if (updateTimer) {
        clearInterval(updateTimer)
        updateTimer = null
      }
      if (state.postCard) {
        state.postCard.destroy()
        state.postCard = null
      }
      container.remove()
    }
  }
}
