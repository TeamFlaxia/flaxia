import { updateMeCache } from '../lib/auth-cache'
import { registerModal } from '../lib/modal-state.js'
import { t } from '../lib/i18n.js'
import { showToast } from '../lib/toast.js'

interface EditProfileModalProps {
  currentUser: { username: string; display_name?: string; bio?: string; avatar_key?: string }
  onSave: () => void
}

export function createEditProfileModal({ currentUser, onSave }: EditProfileModalProps) {
  const unregister = registerModal()
  const container = document.createElement('div')
  container.className = 'modal-overlay'
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
  `

  const modal = document.createElement('div')
  modal.className = 'edit-profile-modal'
  modal.style.cssText = `
    background: var(--bg-primary);
    width: 600px;
    max-width: 90vw;
    max-height: 90vh;
    overflow-y: auto;
    border-radius: 16px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  `

  const header = document.createElement('div')
  header.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--border-color);
  `

  const title = document.createElement('h2')
  title.textContent = t('edit_profile.title')
  title.style.cssText = `
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
  `

  const closeButton = document.createElement('button')
  closeButton.textContent = '✕'
  closeButton.style.cssText = `
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    color: var(--text-muted);
    padding: 0.25rem 0.5rem;
  `

  header.appendChild(title)
  header.appendChild(closeButton)

  const bannerArea = document.createElement('div')
  bannerArea.style.cssText = `
    height: 120px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-color);
  `

  const avatarSection = document.createElement('div')
  avatarSection.style.cssText = `
    padding: 0 1.5rem;
    margin-top: -40px;
    display: flex;
    align-items: flex-end;
  `

  const avatarContainer = document.createElement('div')
  avatarContainer.style.cssText = `
    position: relative;
    width: 80px;
    height: 80px;
  `

  const avatar = document.createElement('div')
  avatar.className = 'edit-profile-avatar'
  avatar.style.cssText = `
    width: 80px;
    height: 80px;
    border-radius: 50%;
    background: var(--accent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 2rem;
    color: white;
    cursor: pointer;
    overflow: hidden;
    border: 4px solid var(--bg-primary);
  `
  // Display existing avatar if available
  if (currentUser.avatar_key) {
    avatar.style.backgroundImage = `url(/api/images/${currentUser.avatar_key})`
    avatar.style.backgroundSize = 'cover'
    avatar.style.backgroundPosition = 'center'
    avatar.textContent = ''
  } else {
    avatar.textContent = currentUser.username.charAt(0).toUpperCase()
  }

  const avatarOverlay = document.createElement('div')
  avatarOverlay.className = 'avatar-overlay'
  avatarOverlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.2s;
    cursor: pointer;
    border-radius: 50%;
  `
  avatarOverlay.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
      <circle cx="12" cy="13" r="4"></circle>
    </svg>
  `

  avatarContainer.appendChild(avatar)
  avatarContainer.appendChild(avatarOverlay)
  avatarSection.appendChild(avatarContainer)

  const form = document.createElement('div')
  form.style.cssText = `
    padding: 1.5rem;
  `

  const displayNameLabel = document.createElement('label')
  displayNameLabel.textContent = t('edit_profile.display_name')
  displayNameLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
  `

  const displayNameInput = document.createElement('input')
  displayNameInput.type = 'text'
  displayNameInput.value = currentUser.display_name || ''
  displayNameInput.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    box-sizing: border-box;
  `

  const displayNameError = document.createElement('div')
  displayNameError.className = 'field-error'
  displayNameError.style.cssText = `
    color: var(--danger);
    font-size: 0.875rem;
    margin-top: -0.75rem;
    margin-bottom: 1rem;
    min-height: 1.25rem;
  `

  const bioLabel = document.createElement('label')
  bioLabel.textContent = t('edit_profile.bio')
  bioLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
  `

  const bioTextarea = document.createElement('textarea')
  bioTextarea.rows = 3
  bioTextarea.value = currentUser.bio || ''
  bioTextarea.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 0.5rem;
    resize: vertical;
    box-sizing: border-box;
  `

  const bioCharCounter = document.createElement('div')
  bioCharCounter.className = 'bio-char-counter'
  bioCharCounter.style.cssText = `
    text-align: right;
    font-size: 0.875rem;
    color: var(--text-muted);
    margin-bottom: 1rem;
  `
  bioCharCounter.textContent = '0/200'

  const bioError = document.createElement('div')
  bioError.className = 'field-error'
  bioError.style.cssText = `
    color: var(--danger);
    font-size: 0.875rem;
    margin-top: -0.75rem;
    margin-bottom: 1rem;
    min-height: 1.25rem;
  `

  const hiddenFileInput = document.createElement('input')
  hiddenFileInput.type = 'file'
  hiddenFileInput.accept = 'image/jpeg,image/png,image/gif,image/webp,.jpg,.jpeg,.png,.gif,.webp'
  hiddenFileInput.style.cssText = 'position: absolute; left: -9999px; opacity: 0; width: 0; height: 0;'

  const saveButton = document.createElement('button')
  saveButton.textContent = t('edit_profile.save')
  saveButton.style.cssText = `
    background: var(--accent);
    color: white;
    border: none;
    padding: 0.75rem 2rem;
    border-radius: 9999px;
    font-weight: 600;
    cursor: pointer;
    font-size: 1rem;
    opacity: 0.4;
    pointer-events: none;
  `

  form.appendChild(displayNameLabel)
  form.appendChild(displayNameInput)
  form.appendChild(displayNameError)
  form.appendChild(bioLabel)
  form.appendChild(bioTextarea)
  form.appendChild(bioCharCounter)
  form.appendChild(bioError)
  form.appendChild(hiddenFileInput)
  form.appendChild(saveButton)

  modal.appendChild(header)
  modal.appendChild(bannerArea)
  modal.appendChild(avatarSection)
  modal.appendChild(form)
  container.appendChild(modal)

  let selectedFile: File | null = null
  let avatarPreviewUrl: string | null = null
  let hasChanges = false
  let hasAvatarChange = false

  const updateCharCounter = () => {
    const length = bioTextarea.value.length
    bioCharCounter.textContent = `${length}/200`
    
    if (length > 180) {
      bioCharCounter.style.color = length >= 200 ? 'var(--danger)' : 'var(--accent)'
    } else {
      bioCharCounter.style.color = 'var(--text-muted)'
    }
  }

  const validateDisplayName = () => {
    const value = displayNameInput.value.trim()
    if (value.length > 50) {
      displayNameError.textContent = 'Display name must be 50 characters or less'
      return false
    }
    displayNameError.textContent = ''
    return true
  }

  const validateBio = () => {
    const value = bioTextarea.value
    if (value.length > 200) {
      bioError.textContent = 'Bio must be 200 characters or less'
      return false
    }
    bioError.textContent = ''
    return true
  }

  const validateForm = () => {
    const isDisplayNameValid = validateDisplayName()
    const isBioValid = validateBio()
    const isValid = isDisplayNameValid && isBioValid
    
    const originalDisplayName = currentUser.display_name || ''
    const originalBio = currentUser.bio || ''
    const hasFieldChanges = 
      displayNameInput.value.trim() !== originalDisplayName ||
      bioTextarea.value !== originalBio ||
      hasAvatarChange
    
    hasChanges = hasFieldChanges
    
    if (hasChanges && isValid) {
      saveButton.style.opacity = '1'
      saveButton.style.pointerEvents = 'auto'
    } else {
      saveButton.style.opacity = '0.4'
      saveButton.style.pointerEvents = 'none'
    }
  }

  displayNameInput.addEventListener('input', () => {
    validateForm()
  })

  bioTextarea.addEventListener('input', () => {
    updateCharCounter()
    validateForm()
  })

  avatarContainer.addEventListener('click', () => {
    hiddenFileInput.click()
  })

  avatarContainer.addEventListener('mouseenter', () => {
    avatarOverlay.style.opacity = '1'
  })

  avatarContainer.addEventListener('mouseleave', () => {
    avatarOverlay.style.opacity = '0'
  })

  hiddenFileInput.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return

    if (!file.type.match(/^image\/(jpeg|jpg|png|gif|webp)$/)) {
      showToast(t('edit_profile.avatar_type_error'), true)
      return
    }

    if (file.size > 1024 * 1024) {
      showToast(t('edit_profile.avatar_size_error'), true)
      return
    }

    avatarError.textContent = ''
    selectedFile = file
    hasAvatarChange = true
    avatarPreviewUrl = URL.createObjectURL(file)
    avatar.style.backgroundImage = `url(${avatarPreviewUrl})`
    avatar.style.backgroundSize = 'cover'
    avatar.style.backgroundPosition = 'center'
    avatar.textContent = ''
    validateForm()
  })

  saveButton.addEventListener('click', async () => {
    if (!hasChanges) return

    saveButton.disabled = true
    saveButton.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 1s linear infinite">
        <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
      </svg>
    `
    saveButton.style.cssText = `
      background: var(--accent);
      color: white;
      border: none;
      padding: 0.75rem 2rem;
      border-radius: 9999px;
      font-weight: 600;
      cursor: not-allowed;
      font-size: 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    `

    try {
      const formData = new FormData()
      formData.append('display_name', displayNameInput.value.trim())
      formData.append('bio', bioTextarea.value)
      
      if (selectedFile) {
        formData.append('avatar', selectedFile)
      }

      const response = await fetch('/api/users/me', {
        method: 'PATCH',
        body: formData
      })

      if (response.ok) {
        // Update cache with new user data
        const updatedUser = await response.json()
        updateMeCache(updatedUser)
        
        // Dispatch event to notify components of profile update
        window.dispatchEvent(new CustomEvent('profileUpdated', { 
          detail: updatedUser 
        }))
        
        if (avatarPreviewUrl) {
          URL.revokeObjectURL(avatarPreviewUrl)
        }
        destroy()
        onSave()
      } else {
        const errorText = await response.text()
        console.error('API error response:', response.status, errorText)
        throw new Error(`Failed to save: ${response.status} ${errorText}`)
      }
    } catch (error) {
      console.error('Failed to save profile:', error)
      saveButton.disabled = false
      saveButton.textContent = t('edit_profile.save')
      saveButton.style.cursor = 'pointer'
      showToast('Failed to save. Please try again.', true)
    }
  })

  closeButton.addEventListener('click', () => {
    if (hasChanges) {
      if (confirm(t('edit_profile.unsaved_changes'))) {
        destroy()
      }
    } else {
      destroy()
    }
  })

  container.addEventListener('click', (e) => {
    if (e.target === container && hasChanges) {
      if (confirm(t('edit_profile.unsaved_changes'))) {
        destroy()
      }
    } else if (e.target === container) {
      destroy()
    }
  })

  function destroy() {
    unregister()
    if (avatarPreviewUrl) {
      URL.revokeObjectURL(avatarPreviewUrl)
    }
    container.remove()
  }

  updateCharCounter()
  validateForm()

  return {
    getElement: () => container,
    destroy
  }
}
