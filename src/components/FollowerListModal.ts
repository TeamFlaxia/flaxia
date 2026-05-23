import { showSignInPrompt } from './SignInPrompt.js'
import { registerModal } from '../lib/modal-state.js'

interface UserListItem {
  id: string
  username: string
  display_name: string
  avatar_key?: string
  followers_count: number
  following_count: number
  is_following?: boolean
}

interface FollowerListModalProps {
  username: string
  initialTab?: 'followers' | 'following'
  currentUser: { username: string } | null
  onClose: () => void
}

export function createFollowerListModal({ username, initialTab = 'followers', currentUser, onClose }: FollowerListModalProps) {
  const unregister = registerModal()
  const container = document.createElement('div')
  container.className = 'follower-list-modal-overlay'
  container.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
  `

  const modal = document.createElement('div')
  modal.className = 'follower-list-modal'
  modal.style.cssText = `
    background: var(--bg-primary);
    border-radius: 0.5rem;
    max-width: 600px;
    width: 100%;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
  `

  // Header
  const header = document.createElement('div')
  header.className = 'follower-list-modal-header'
  header.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--border);
  `

  const title = document.createElement('h2')
  title.style.cssText = `
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary);
  `

  const closeButton = document.createElement('button')
  closeButton.textContent = '×'
  closeButton.style.cssText = `
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    color: var(--text-muted);
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    transition: background-color 0.2s;
  `
  closeButton.addEventListener('mouseenter', () => {
    closeButton.style.backgroundColor = 'var(--bg-secondary)'
  })
  closeButton.addEventListener('mouseleave', () => {
    closeButton.style.backgroundColor = 'transparent'
  })

  header.appendChild(title)
  header.appendChild(closeButton)

  // Tabs
  const tabsContainer = document.createElement('div')
  tabsContainer.className = 'follower-list-tabs'
  tabsContainer.style.cssText = `
    display: flex;
    border-bottom: 1px solid var(--border);
  `

  const followersTab = document.createElement('button')
  followersTab.textContent = 'Followers'
  followersTab.className = 'follower-list-tab'
  followersTab.style.cssText = `
    flex: 1;
    padding: 1rem;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    transition: all 0.2s;
  `

  const followingTab = document.createElement('button')
  followingTab.textContent = 'Following'
  followingTab.className = 'follower-list-tab'
  followingTab.style.cssText = `
    flex: 1;
    padding: 1rem;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    transition: all 0.2s;
  `

  tabsContainer.appendChild(followersTab)
  tabsContainer.appendChild(followingTab)

  // Content
  const content = document.createElement('div')
  content.className = 'follower-list-content'
  content.style.cssText = `
    flex: 1;
    overflow-y: auto;
    padding: 0;
  `

  // Loading state
  const loadingElement = document.createElement('div')
  loadingElement.className = 'follower-list-loading'
  loadingElement.style.cssText = `
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 3rem;
    color: var(--text-muted);
  `
  loadingElement.textContent = 'Loading...'

  // Error state
  const errorElement = document.createElement('div')
  errorElement.className = 'follower-list-error'
  errorElement.style.cssText = `
    display: none;
    justify-content: center;
    align-items: center;
    padding: 3rem;
    color: var(--danger);
    text-align: center;
  `

  // Empty state
  const emptyElement = document.createElement('div')
  emptyElement.className = 'follower-list-empty'
  emptyElement.style.cssText = `
    display: none;
    justify-content: center;
    align-items: center;
    padding: 3rem;
    color: var(--text-muted);
    text-align: center;
  `
  emptyElement.innerHTML = `
    <div style="font-size: 2rem; margin-bottom: 1rem;">👥</div>
    <div style="font-size: 1rem;">No users found</div>
  `

  content.appendChild(loadingElement)
  content.appendChild(errorElement)
  content.appendChild(emptyElement)

  // State
  let currentTab = initialTab
  let users: UserListItem[] = []
  let nextCursor: string | null = null
  let hasMore = false
  let isLoading = false

  // Update tab styles
  const updateTabStyles = () => {
    if (currentTab === 'followers') {
      followersTab.style.color = 'var(--text-primary)'
      followersTab.style.borderBottomColor = 'var(--accent)'
      followingTab.style.color = 'var(--text-muted)'
      followingTab.style.borderBottomColor = 'transparent'
    } else {
      followingTab.style.color = 'var(--text-primary)'
      followingTab.style.borderBottomColor = 'var(--accent)'
      followersTab.style.color = 'var(--text-muted)'
      followersTab.style.borderBottomColor = 'transparent'
    }
  }

  // Load users
  const loadUsers = async (reset = true) => {
    if (isLoading) return
    
    isLoading = true
    loadingElement.style.display = 'flex'
    errorElement.style.display = 'none'
    emptyElement.style.display = 'none'

    try {
      const endpoint = currentTab === 'followers' ? 'followers' : 'following'
      const url = `/api/users/${username}/${endpoint}${reset ? '' : `?cursor=${nextCursor}`}`
      
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error('Failed to load users')
      }

      const data = await response.json() as { users: UserListItem[], next_cursor: string | null, has_more: boolean }
      
      if (reset) {
        users = data.users
      } else {
        users = [...users, ...data.users]
      }
      
      nextCursor = data.next_cursor
      hasMore = data.has_more

      renderUsers()
    } catch (error) {
      console.error('Load users error:', error)
      errorElement.style.display = 'flex'
      errorElement.textContent = 'Failed to load users. Please try again.'
    } finally {
      isLoading = false
      loadingElement.style.display = 'none'
    }
  }

  // Render users
  const renderUsers = () => {
    // Clear existing user elements
    const existingUserElements = content.querySelectorAll('.follower-list-user')
    existingUserElements.forEach(el => el.remove())

    // Clear existing load more buttons
    const existingLoadMore = content.querySelectorAll('.follower-list-load-more')
    existingLoadMore.forEach(el => el.remove())

    if (users.length === 0) {
      emptyElement.style.display = 'flex'
      return
    }

    emptyElement.style.display = 'none'

    users.forEach(user => {
      const userElement = createUserElement(user)
      content.appendChild(userElement)
    })

    // Add load more button if there are more users
    if (hasMore) {
      const loadMoreButton = document.createElement('button')
      loadMoreButton.className = 'follower-list-load-more'
      loadMoreButton.textContent = 'Load more'
      loadMoreButton.style.cssText = `
        width: 100%;
        padding: 1rem;
        background: none;
        border: none;
        border-top: 1px solid var(--border);
        cursor: pointer;
        color: var(--text-muted);
        font-size: 0.875rem;
        transition: background-color 0.2s;
      `
      loadMoreButton.addEventListener('click', () => {
        loadUsers(false)
      })
      loadMoreButton.addEventListener('mouseenter', () => {
        loadMoreButton.style.backgroundColor = 'var(--bg-secondary)'
      })
      loadMoreButton.addEventListener('mouseleave', () => {
        loadMoreButton.style.backgroundColor = 'transparent'
      })
      content.appendChild(loadMoreButton)
    }
  }

  // Create user element
  const createUserElement = (user: UserListItem) => {
    const userElement = document.createElement('div')
    userElement.className = 'follower-list-user'
    userElement.style.cssText = `
      display: flex;
      align-items: center;
      padding: 1rem 1.5rem;
      border-bottom: 1px solid var(--border);
      transition: background-color 0.2s;
    `

    // Avatar
    const avatar = document.createElement('div')
    avatar.className = 'follower-list-avatar'
    avatar.style.cssText = `
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: var(--bg-secondary);
      display: flex;
      align-items: center;
      justify-content: center;
      margin-right: 1rem;
      font-weight: 600;
      color: var(--text-muted);
      background-size: cover;
      background-position: center;
      flex-shrink: 0;
    `

    if (user.avatar_key) {
      avatar.style.backgroundImage = `url(/api/images/${user.avatar_key})`
      avatar.textContent = ''
    } else {
      avatar.textContent = user.username.charAt(0).toUpperCase()
    }

    // User info
    const userInfo = document.createElement('div')
    userInfo.className = 'follower-list-user-info'
    userInfo.style.cssText = `
      flex: 1;
      min-width: 0;
    `

    const displayName = document.createElement('div')
    displayName.className = 'follower-list-display-name'
    displayName.style.cssText = `
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    `
    displayName.textContent = user.display_name

    const usernameElement = document.createElement('div')
    usernameElement.className = 'follower-list-username'
    usernameElement.style.cssText = `
      color: var(--text-muted);
      font-size: 0.875rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    `
    usernameElement.textContent = `@${user.username}`

    userInfo.appendChild(displayName)
    userInfo.appendChild(usernameElement)

    // Follow button (only show if not current user and user is logged in)
    let followButton: HTMLButtonElement | null = null
    if (currentUser && user.username !== currentUser.username) {
      followButton = document.createElement('button')
      followButton.className = 'follower-list-follow-button'
      followButton.style.cssText = `
        padding: 0.5rem 1rem;
        border-radius: 9999px;
        border: 1px solid var(--border);
        cursor: pointer;
        font-size: 0.875rem;
        font-weight: 500;
        transition: all 0.2s;
        margin-left: 1rem;
        flex-shrink: 0;
      `
      
      updateFollowButton(followButton, user.is_following || false)
      
      followButton.addEventListener('click', async () => {
        if (!currentUser || !followButton) {
          showSignInPrompt(
            'follow',
            () => { window.history.pushState({}, '', '/login'); window.dispatchEvent(new PopStateEvent('popstate')) },
            () => { window.history.pushState({}, '', '/register'); window.dispatchEvent(new PopStateEvent('popstate')) }
          )
          return
        }

        const originalText = followButton.textContent
        followButton.disabled = true
        followButton.textContent = user.is_following ? 'Unfollowing...' : 'Following...'

        try {
          const method = user.is_following ? 'DELETE' : 'POST'
          const response = await fetch(`/api/users/${user.username}/follow`, {
            method,
            credentials: 'include'
          })

          if (response.ok) {
            const result = await response.json() as { followers_count: number; following_count: number }
            user.is_following = !user.is_following
            updateFollowButton(followButton, user.is_following)
            
            // Update counts in the UI
            if (user.is_following) {
              user.following_count = result.following_count
            } else {
              user.following_count = result.following_count
            }
          } else {
            console.error('Follow/unfollow failed:', await response.text())
            followButton.textContent = originalText
            followButton.disabled = false
          }
        } catch (error) {
          console.error('Follow/unfollow error:', error)
          followButton.textContent = originalText
          followButton.disabled = false
        } finally {
          if (followButton && !followButton.disabled) {
            followButton.disabled = false
          }
        }
      })
    }

    // Make user clickable to navigate to profile
    const userLink = document.createElement('div')
    userLink.style.cssText = `
      cursor: pointer;
      flex: 1;
      display: flex;
      align-items: center;
    `
    
    userLink.addEventListener('click', () => {
      window.location.href = `/profile/${user.username}`
    })

    userLink.addEventListener('mouseenter', () => {
      userElement.style.backgroundColor = 'var(--bg-secondary)'
    })
    userLink.addEventListener('mouseleave', () => {
      userElement.style.backgroundColor = 'transparent'
    })

    userLink.appendChild(avatar)
    userLink.appendChild(userInfo)

    userElement.appendChild(userLink)
    if (followButton) {
      userElement.appendChild(followButton)
    }

    return userElement
  }

  // Update follow button
  const updateFollowButton = (button: HTMLButtonElement, isFollowing: boolean) => {
    if (isFollowing) {
      button.textContent = 'Following'
      button.style.backgroundColor = 'var(--accent)'
      button.style.color = 'white'
      button.style.borderColor = 'var(--accent)'
    } else {
      button.textContent = 'Follow'
      button.style.backgroundColor = 'transparent'
      button.style.color = 'var(--text-primary)'
      button.style.borderColor = 'var(--border)'
    }
  }

  // Tab switching
  const switchTab = (tab: 'followers' | 'following') => {
    if (currentTab === tab) return
    
    currentTab = tab
    updateTabStyles()
    title.textContent = `${username.charAt(0).toUpperCase() + username.slice(1)} - ${tab.charAt(0).toUpperCase() + tab.slice(1)}`
    loadUsers(true)
  }

  followersTab.addEventListener('click', () => switchTab('followers'))
  followingTab.addEventListener('click', () => switchTab('following'))

  // Close modal
  const closeModal = () => {
    unregister()
    container.remove()
    onClose()
  }

  closeButton.addEventListener('click', closeModal)
  container.addEventListener('click', (e) => {
    if (e.target === container) {
      closeModal()
    }
  })

  // Escape key to close
  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeModal()
      document.removeEventListener('keydown', handleEscape)
    }
  }
  document.addEventListener('keydown', handleEscape)

  // Initialize
  updateTabStyles()
  title.textContent = `${username.charAt(0).toUpperCase() + username.slice(1)} - ${initialTab.charAt(0).toUpperCase() + initialTab.slice(1)}`
  loadUsers(true)

  modal.appendChild(header)
  modal.appendChild(tabsContainer)
  modal.appendChild(content)
  container.appendChild(modal)

  return {
    getElement: () => container,
    destroy: () => {
      unregister()
      document.removeEventListener('keydown', handleEscape)
      container.remove()
    }
  }
}
