import { createEditProfileModal } from './EditProfileModal.js'
import { createFollowerListModal } from './FollowerListModal.js'
import { processText, renderMathElements, linkifyHashtags, linkifyUrls } from './PostText.js'
import { clearMeCache } from '../lib/auth-cache.js'
import { showSignInPrompt } from './SignInPrompt.js'
import { createUserPostList, CurrentUser } from './UserPostList.js'
import { safeRemoveFromBody } from '../lib/dom-utils.js'

interface ProfilePageProps {
  username: string
  currentUser: CurrentUser | null
  sandboxOrigin: string
}

export function createProfilePage({ username, currentUser, sandboxOrigin }: ProfilePageProps) {
  // Create main container
  const container = document.createElement('div')
  container.className = 'profile-page'

  // Profile header
  const header = document.createElement('div')
  header.className = 'profile-header'

  // Avatar section
  const avatarSection = document.createElement('div')
  avatarSection.className = 'profile-avatar-section'

  const avatar = document.createElement('div')
  avatar.className = 'profile-avatar'
  avatar.textContent = username.charAt(0).toUpperCase()

  const info = document.createElement('div')
  info.className = 'profile-info'

  const displayName = document.createElement('div')
  displayName.className = 'profile-display-name'
  displayName.textContent = 'Loading...'

  const usernameElement = document.createElement('div')
  usernameElement.className = 'profile-username'
  usernameElement.textContent = `@${username}`

  const bio = document.createElement('div')
  bio.className = 'profile-bio'
  bio.textContent = ''

  const joinedDate = document.createElement('div')
  joinedDate.className = 'profile-joined-date'
  joinedDate.style.cssText = 'color: var(--text-muted); font-family: \'Noto Sans\', monospace, -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif; font-size: 0.875rem; margin-top: 0.5rem;'
  joinedDate.textContent = 'Joined: Loading...'

  info.appendChild(displayName)
  info.appendChild(usernameElement)
  info.appendChild(bio)
  info.appendChild(joinedDate)

  avatarSection.appendChild(avatar)
  avatarSection.appendChild(info)

  header.appendChild(avatarSection)

  // Stats row
  const statsRow = document.createElement('div')
  statsRow.className = 'profile-stats'

  const postsStat = document.createElement('div')
  postsStat.className = 'profile-stat'
  const postsCountSpan = document.createElement('span')
  postsCountSpan.className = 'stat-number'
  postsCountSpan.textContent = '0'
  postsStat.appendChild(postsCountSpan)
  postsStat.appendChild(document.createTextNode(' Posts'))

  const followersStat = document.createElement('div')
  followersStat.className = 'profile-stat'
  followersStat.style.cssText = 'cursor: pointer; transition: background-color 0.2s;'
  const followersCountSpan = document.createElement('span')
  followersCountSpan.className = 'stat-number'
  followersCountSpan.textContent = '0'
  followersStat.appendChild(followersCountSpan)
  followersStat.appendChild(document.createTextNode(' Followers'))

  const followingStat = document.createElement('div')
  followingStat.className = 'profile-stat'
  followingStat.style.cssText = 'cursor: pointer; transition: background-color 0.2s;'
  const followingCountSpan = document.createElement('span')
  followingCountSpan.className = 'stat-number'
  followingCountSpan.textContent = '0'
  followingStat.appendChild(followingCountSpan)
  followingStat.appendChild(document.createTextNode(' Following'))

  statsRow.appendChild(postsStat)
  statsRow.appendChild(followersStat)
  statsRow.appendChild(followingStat)

  // Action buttons
  const actionsRow = document.createElement('div')
  actionsRow.className = 'profile-actions'

  // Edit Profile button (only for own profile)
  const editButton = document.createElement('button')
  editButton.className = 'profile-button profile-button--primary'
  editButton.textContent = 'Edit Profile'
  editButton.style.display = currentUser?.username === username ? 'block' : 'none'

  // Logout button (only for own profile)
  const logoutButton = document.createElement('button')
  logoutButton.className = 'profile-button profile-button--secondary'
  logoutButton.textContent = 'Log out'
  logoutButton.style.display = currentUser?.username === username ? 'block' : 'none'
  logoutButton.style.marginTop = '0.5rem'

  // Follow/Unfollow button (only for others' profiles)
  const followButton = document.createElement('button')
  followButton.className = 'profile-button profile-button--secondary'
  followButton.textContent = 'Follow'
  followButton.style.display = currentUser?.username === username ? 'none' : 'block'

  actionsRow.appendChild(editButton)
  if (currentUser?.username === username) {
    actionsRow.appendChild(logoutButton)
  }
  actionsRow.appendChild(followButton)


  // Assemble page
  container.appendChild(header)
  container.appendChild(statsRow)
  container.appendChild(document.createElement('hr'))
  container.appendChild(actionsRow)

  // Add user post list
  const postList = createUserPostList({
    username: username,
    sandboxOrigin: sandboxOrigin,
    currentUser: currentUser
  })
  container.appendChild(postList.getElement())

  // State
  let userData: any = null
  let isEditing = false
  let isFollowing = false

  // Load user data
  const loadUserData = async () => {
    try {
      const response = await fetch(`/api/users/${username}`)
      if (response.ok) {
        const data = await response.json() as { user: any }
        userData = data.user
        
        // Update UI
        displayName.textContent = userData.display_name
        
        // Process bio with Markdown and links
        if (userData.bio) {
          processText(userData.bio).then(processedHtml => {
            bio.replaceChildren()
            const template = document.createElement('template')
            template.innerHTML = processedHtml
            bio.appendChild(template.content.cloneNode(true))
            
            // Render math elements and linkify
            renderMathElements(bio)
            linkifyHashtags(bio)
            linkifyUrls(bio)
          }).catch(error => {
            console.error('Failed to process bio:', error)
            bio.textContent = userData.bio
          })
        } else {
          bio.textContent = ''
        }
        
        // Format and display joined date
        const joinedDateElement = container.querySelector('.profile-joined-date') as HTMLElement
        if (joinedDateElement && userData.created_at) {
          const joinedDate = new Date(userData.created_at)
          joinedDateElement.textContent = `Joined: ${joinedDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`
        }
        
        if (userData.avatar_key) {
          avatar.style.backgroundImage = `url(/api/images/${userData.avatar_key})`
          avatar.style.backgroundSize = 'cover'
          avatar.style.backgroundPosition = 'center'
          avatar.textContent = ''
        }

        // Update follow counts
        followersCountSpan.textContent = String(userData.followers_count || 0)
        followingCountSpan.textContent = String(userData.following_count || 0)
        
        // Update follow button state
        isFollowing = userData.is_following || false
        updateFollowButton()

      } else {
        console.error('User not found')
      }
    } catch (error) {
      console.error('Failed to load user data:', error)
    }
  }

  // Update follow button text and state
  const updateFollowButton = () => {
    followButton.textContent = isFollowing ? 'Following' : 'Follow'
    followButton.className = isFollowing 
      ? 'profile-button profile-button--primary' 
      : 'profile-button profile-button--secondary'
  }

  
  // Edit profile functionality
  const startEdit = () => {
    if (!userData) return

    const modal = createEditProfileModal({
      currentUser: userData,
      onSave: async () => {
        // Reload user data after save
        await loadUserData()
      }
    })

    document.body.appendChild(modal.getElement())
  }


  // Event listeners
  editButton.addEventListener('click', startEdit)

  // Logout functionality
  logoutButton.addEventListener('click', () => {
    if (!currentUser) return
    
    // Create confirmation modal
    const overlay = document.createElement('div')
    overlay.setAttribute('style', `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
    `)

    const modal = document.createElement('div')
    modal.setAttribute('style', `
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.5rem;
      max-width: 320px;
      width: 90%;
      text-align: center;
    `)

    modal.innerHTML = `
      <h3 style="margin: 0 0 1rem 0; color: var(--text-primary); font-size: 1.125rem;">Log out of @${currentUser.username}?</h3>
      <div style="display: flex; gap: 0.75rem; justify-content: center;">
        <button class="logout-cancel-btn" style="
          padding: 0.5rem 1rem;
          background: var(--bg-secondary);
          color: var(--text-primary);
          border: 1px solid var(--border);
          border-radius: 9999px;
          cursor: pointer;
          font-size: 0.875rem;
          transition: background-color 0.2s;
        ">Cancel</button>
        <button class="logout-confirm-btn" style="
          padding: 0.5rem 1rem;
          background: var(--text-primary);
          color: var(--bg-primary);
          border: none;
          border-radius: 9999px;
          cursor: pointer;
          font-size: 0.875rem;
          font-weight: 600;
          transition: opacity 0.2s;
        ">Log out</button>
      </div>
    `

    const cancelBtn = modal.querySelector('.logout-cancel-btn') as HTMLButtonElement
    const confirmBtn = modal.querySelector('.logout-confirm-btn') as HTMLButtonElement

    cancelBtn.addEventListener('click', () => {
      overlay.remove()
    })

    cancelBtn.addEventListener('mouseenter', () => {
      cancelBtn.style.backgroundColor = 'var(--bg-tertiary)'
    })
    cancelBtn.addEventListener('mouseleave', () => {
      cancelBtn.style.backgroundColor = 'var(--bg-secondary)'
    })

    confirmBtn.addEventListener('click', async () => {
      try {
        const response = await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'include'
        })
        
        if (response.ok) {
          clearMeCache()
          window.location.href = '/'
        } else {
          console.error('Logout failed')
          overlay.remove()
        }
      } catch (error) {
        console.error('Logout error:', error)
        overlay.remove()
      }
    })

    confirmBtn.addEventListener('mouseenter', () => {
      confirmBtn.style.opacity = '0.8'
    })
    confirmBtn.addEventListener('mouseleave', () => {
      confirmBtn.style.opacity = '1'
    })

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove()
      }
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)
  })

  followButton.addEventListener('click', async () => {
    if (!currentUser) {
      // Show sign-in prompt for guests
      showSignInPrompt(
        'follow',
        () => { window.history.pushState({}, '', '/login'); window.dispatchEvent(new PopStateEvent('popstate')) },
        () => { window.history.pushState({}, '', '/register'); window.dispatchEvent(new PopStateEvent('popstate')) }
      )
      return
    }

    if (!userData) return

    // Disable button during operation
    followButton.disabled = true
    followButton.textContent = isFollowing ? 'Unfollowing...' : 'Following...'

    try {
      if (isFollowing) {
        // Unfollow
        const response = await fetch(`/api/users/${username}/follow`, {
          method: 'DELETE',
          credentials: 'include'
        })
        
        if (response.ok) {
          const result = await response.json() as { followers_count: number; following_count: number }
          isFollowing = false
          followersCountSpan.textContent = String(result.followers_count)
          followingCountSpan.textContent = String(result.following_count)
          updateFollowButton()
        } else {
          console.error('Failed to unfollow:', await response.text())
          updateFollowButton()
        }
      } else {
        // Follow
        const response = await fetch(`/api/users/${username}/follow`, {
          method: 'POST',
          credentials: 'include'
        })
        
        if (response.ok) {
          const result = await response.json() as { followers_count: number; following_count: number }
          isFollowing = true
          followersCountSpan.textContent = String(result.followers_count)
          followingCountSpan.textContent = String(result.following_count)
          updateFollowButton()
        } else {
          console.error('Failed to follow:', await response.text())
          updateFollowButton()
        }
      }
    } catch (error) {
      console.error('Follow/unfollow error:', error)
      updateFollowButton()
    } finally {
      followButton.disabled = false
    }
  })

  // Add click handlers for follower/following stats
  followersStat.addEventListener('click', () => {
    const modal = createFollowerListModal({
      username: username,
      initialTab: 'followers',
      currentUser: currentUser,
      onClose: () => {
        safeRemoveFromBody(modal.getElement())
      }
    })
    document.body.appendChild(modal.getElement())
  })

  followersStat.addEventListener('mouseenter', () => {
    followersStat.style.backgroundColor = 'var(--bg-secondary)'
  })
  followersStat.addEventListener('mouseleave', () => {
    followersStat.style.backgroundColor = 'transparent'
  })

  followingStat.addEventListener('click', () => {
    const modal = createFollowerListModal({
      username: username,
      initialTab: 'following',
      currentUser: currentUser,
      onClose: () => {
        safeRemoveFromBody(modal.getElement())
      }
    })
    document.body.appendChild(modal.getElement())
  })

  followingStat.addEventListener('mouseenter', () => {
    followingStat.style.backgroundColor = 'var(--bg-secondary)'
  })
  followingStat.addEventListener('mouseleave', () => {
    followingStat.style.backgroundColor = 'transparent'
  })

  // Load initial data
  loadUserData()

  return {
    getElement: () => container,
    destroy: () => {
      // Cleanup post list
      postList.destroy()
    }
  }
}
