import { clearMeCache } from '../lib/auth-cache'

interface SettingsPageProps {
  currentUser?: {
    id: string
    username: string
    display_name?: string
    avatar_key?: string
    language?: string
    email?: string
    ng_words?: string[]
  }
}

export function createSettingsPage({ currentUser }: SettingsPageProps) {
  const container = document.createElement('div')
  container.className = 'settings-page'
  container.style.cssText = `
    max-width: 600px;
    margin: 0 auto;
    padding: 2rem 1rem;
  `

  const header = document.createElement('h1')
  header.textContent = 'Settings'
  header.style.cssText = `
    font-size: 1.5rem;
    font-weight: 600;
    margin-bottom: 2rem;
    color: var(--text-primary);
  `

  container.appendChild(header)

  // Account Section
  if (currentUser) {
    const accountSection = document.createElement('div')
    accountSection.className = 'settings-section'
    accountSection.style.cssText = `
      margin-bottom: 2rem;
      padding: 1.5rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-primary);
    `

    const accountTitle = document.createElement('h2')
    accountTitle.textContent = 'Account'
    accountTitle.style.cssText = `
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.5rem;
    `

    const userChip = document.createElement('div')
    userChip.style.cssText = `
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.5rem;
    `

    const avatarUrl = currentUser.avatar_key ? `/api/images/${currentUser.avatar_key}` : '/api/images/default-avatar'
    const displayName = currentUser.display_name || currentUser.username

    userChip.innerHTML = `
      <img src="${avatarUrl}" alt="${displayName}" style="
        width: 60px;
        height: 60px;
        border-radius: 50%;
        object-fit: cover;
        border: 1px solid var(--border);
      " onerror="this.src='/api/images/default-avatar'">
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: 1.125rem; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${displayName}</div>
        <div style="color: var(--text-muted); font-family: monospace; font-size: 0.875rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">@${currentUser.username}</div>
      </div>
    `

    const logoutButton = document.createElement('button')
    logoutButton.textContent = 'Log out'
    logoutButton.style.cssText = `
      background: var(--bg-secondary);
      color: var(--text-primary);
      border: 1px solid var(--border);
      padding: 0.75rem 1.5rem;
      border-radius: 9999px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 600;
      transition: all 0.2s;
    `

    logoutButton.addEventListener('mouseenter', () => {
      logoutButton.style.backgroundColor = 'var(--bg-tertiary)'
    })
    logoutButton.addEventListener('mouseleave', () => {
      logoutButton.style.backgroundColor = 'var(--bg-secondary)'
    })

    logoutButton.addEventListener('click', async () => {
      if (confirm(`Log out of @${currentUser.username}?`)) {
        try {
          const response = await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'include'
          })
          
          if (response.ok) {
            clearMeCache()
            window.location.href = '/'
          } else {
            alert('Logout failed')
          }
        } catch (error) {
          console.error('Logout error:', error)
          alert('Logout error')
        }
      }
    })

    accountSection.appendChild(accountTitle)
    accountSection.appendChild(userChip)
    accountSection.appendChild(logoutButton)
    container.appendChild(accountSection)
  }


  // Language Section
  const languageSection = document.createElement('div')
  languageSection.className = 'settings-section'
  languageSection.style.cssText = `
    margin-bottom: 2rem;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
  `

  const languageTitle = document.createElement('h2')
  languageTitle.textContent = 'Language'
  languageTitle.style.cssText = `
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  `

  const languageSelect = document.createElement('select')
  languageSelect.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    cursor: pointer;
  `

  const englishOption = document.createElement('option')
  englishOption.value = 'en'
  englishOption.textContent = 'English'

  const japaneseOption = document.createElement('option')
  japaneseOption.value = 'ja'
  japaneseOption.textContent = '日本語'

  languageSelect.appendChild(englishOption)
  languageSelect.appendChild(japaneseOption)

  // Set current language
  if (currentUser?.language) {
    languageSelect.value = currentUser.language
  }

  const languageSaveButton = document.createElement('button')
  languageSaveButton.textContent = 'Save'
  languageSaveButton.style.cssText = `
    background: var(--accent);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 600;
    transition: opacity 0.2s;
  `

  const languageMessage = document.createElement('div')
  languageMessage.style.cssText = `
    margin-top: 0.5rem;
    font-size: 0.875rem;
    min-height: 1.25rem;
  `

  languageSection.appendChild(languageTitle)
  languageSection.appendChild(languageSelect)
  languageSection.appendChild(languageSaveButton)
  languageSection.appendChild(languageMessage)

  // Muted Words Section
  const mutedWordsSection = document.createElement('div')
  mutedWordsSection.className = 'settings-section'
  mutedWordsSection.style.cssText = `
    margin-bottom: 2rem;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
  `

  const mutedWordsTitle = document.createElement('h2')
  mutedWordsTitle.textContent = 'Muted Words'
  mutedWordsTitle.style.cssText = `
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  `

  // State for NG words
  let ngWords: string[] = currentUser?.ng_words || []
  
  // Chips container
  const chipsContainer = document.createElement('div')
  chipsContainer.style.cssText = `
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 1rem;
    min-height: 2rem;
  `

  // Input and add button container
  const inputContainer = document.createElement('div')
  inputContainer.style.cssText = `
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  `

  const ngWordInput = document.createElement('input')
  ngWordInput.type = 'text'
  ngWordInput.placeholder = 'Enter word to mute'
  ngWordInput.style.cssText = `
    flex: 1;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    border-radius: 0;
  `

  const addButton = document.createElement('button')
  addButton.textContent = 'Add'
  addButton.style.cssText = `
    background: var(--accent);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 600;
    transition: opacity 0.2s;
  `

  const mutedWordsMessage = document.createElement('div')
  mutedWordsMessage.style.cssText = `
    margin-top: 0.5rem;
    font-size: 0.875rem;
    min-height: 1.25rem;
  `

  const mutedWordsSaveButton = document.createElement('button')
  mutedWordsSaveButton.textContent = 'Save'
  mutedWordsSaveButton.style.cssText = `
    background: var(--accent);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 600;
    transition: opacity 0.2s;
  `

  // Helper function to render chips
  const renderChips = () => {
    chipsContainer.innerHTML = ''
    ngWords.forEach((word, index) => {
      const chip = document.createElement('span')
      chip.style.cssText = `
        display: inline-block;
        padding: 4px 12px;
        background: var(--bg-secondary);
        color: var(--accent);
        border-radius: 16px;
        font-size: 0.875rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        margin: 2px;
      `
      chip.textContent = `#${word}`
      
      chip.addEventListener('mouseenter', () => {
        chip.style.background = 'var(--accent)'
        chip.style.color = '#000'
      })
      
      chip.addEventListener('mouseleave', () => {
        chip.style.background = 'var(--bg-secondary)'
        chip.style.color = 'var(--accent)'
      })

      chip.addEventListener('click', () => {
        ngWords.splice(index, 1)
        renderChips()
      })

      // Add ✕ indicator
      const removeIndicator = document.createElement('span')
      removeIndicator.textContent = ' ✕'
      removeIndicator.style.cssText = `
        margin-left: 4px;
        opacity: 0.7;
      `
      chip.appendChild(removeIndicator)

      chipsContainer.appendChild(chip)
    })

    // Update input state
    if (ngWords.length >= 100) {
      ngWordInput.disabled = true
      addButton.disabled = true
      mutedWordsMessage.textContent = 'Maximum 100 words reached'
      mutedWordsMessage.style.color = 'var(--text-muted)'
    } else {
      ngWordInput.disabled = false
      addButton.disabled = false
      mutedWordsMessage.textContent = ''
    }
  }

  // Add word function
  const addWord = () => {
    const word = ngWordInput.value.trim().toLowerCase()
    if (!word) return
    
    if (word.length > 50) {
      mutedWordsMessage.textContent = 'Word must be ≤50 characters'
      mutedWordsMessage.style.color = 'var(--danger)'
      return
    }

    if (ngWords.includes(word)) {
      mutedWordsMessage.textContent = 'Word already added'
      mutedWordsMessage.style.color = 'var(--text-muted)'
      return
    }

    ngWords.push(word)
    ngWordInput.value = ''
    renderChips()
  }

  // Event listeners
  addButton.addEventListener('click', addWord)
  ngWordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addWord()
    }
  })

  mutedWordsSaveButton.addEventListener('click', async () => {
    mutedWordsMessage.textContent = ''
    mutedWordsSaveButton.disabled = true
    mutedWordsSaveButton.style.opacity = '0.6'

    try {
      const response = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ng_words: ngWords })
      })

      if (response.ok) {
        mutedWordsMessage.textContent = '✓ Saved'
        mutedWordsMessage.style.color = 'var(--success, #10b981)'
      } else {
        const errorData = await response.json() as { error?: string }
        mutedWordsMessage.textContent = errorData.error || 'Failed to save'
        mutedWordsMessage.style.color = 'var(--danger)'
      }
    } catch (error: any) {
      mutedWordsMessage.textContent = 'Network error'
      mutedWordsMessage.style.color = 'var(--danger)'
    } finally {
      mutedWordsSaveButton.disabled = false
      mutedWordsSaveButton.style.opacity = '1'
    }
  })

  // Add hover effects
  mutedWordsSaveButton.addEventListener('mouseenter', () => {
    if (!mutedWordsSaveButton.disabled) {
      mutedWordsSaveButton.style.opacity = '0.8'
    }
  })
  mutedWordsSaveButton.addEventListener('mouseleave', () => {
    if (!mutedWordsSaveButton.disabled) {
      mutedWordsSaveButton.style.opacity = '1'
    }
  })

  addButton.addEventListener('mouseenter', () => {
    if (!addButton.disabled) {
      addButton.style.opacity = '0.8'
    }
  })
  addButton.addEventListener('mouseleave', () => {
    if (!addButton.disabled) {
      addButton.style.opacity = '1'
    }
  })

  // Initial render
  renderChips()

  // Assemble section
  inputContainer.appendChild(ngWordInput)
  inputContainer.appendChild(addButton)

  mutedWordsSection.appendChild(mutedWordsTitle)
  mutedWordsSection.appendChild(chipsContainer)
  mutedWordsSection.appendChild(inputContainer)
  mutedWordsSection.appendChild(mutedWordsSaveButton)
  mutedWordsSection.appendChild(mutedWordsMessage)

  // Email Section
  const emailSection = document.createElement('div')
  emailSection.className = 'settings-section'
  emailSection.style.cssText = `
    margin-bottom: 2rem;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
  `

  const emailTitle = document.createElement('h2')
  emailTitle.textContent = 'Change Email'
  emailTitle.style.cssText = `
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  `

  const currentPasswordLabel = document.createElement('label')
  currentPasswordLabel.textContent = 'Current password'
  currentPasswordLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `

  const currentPasswordInput = document.createElement('input')
  currentPasswordInput.type = 'password'
  currentPasswordInput.placeholder = 'Enter current password'
  currentPasswordInput.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    border-radius: 0;
  `

  const newEmailLabel = document.createElement('label')
  newEmailLabel.textContent = 'New email'
  newEmailLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `

  const newEmailInput = document.createElement('input')
  newEmailInput.type = 'email'
  newEmailInput.placeholder = 'Enter new email'
  newEmailInput.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    border-radius: 0;
  `

  const emailSaveButton = document.createElement('button')
  emailSaveButton.textContent = 'Save'
  emailSaveButton.style.cssText = `
    background: var(--accent);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 600;
    transition: opacity 0.2s;
  `

  const emailMessage = document.createElement('div')
  emailMessage.style.cssText = `
    margin-top: 0.5rem;
    font-size: 0.875rem;
    min-height: 1.25rem;
  `

  emailSection.appendChild(emailTitle)
  emailSection.appendChild(currentPasswordLabel)
  emailSection.appendChild(currentPasswordInput)
  emailSection.appendChild(newEmailLabel)
  emailSection.appendChild(newEmailInput)
  emailSection.appendChild(emailSaveButton)
  emailSection.appendChild(emailMessage)

  // Password Section
  const passwordSection = document.createElement('div')
  passwordSection.className = 'settings-section'
  passwordSection.style.cssText = `
    margin-bottom: 2rem;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
  `

  const passwordTitle = document.createElement('h2')
  passwordTitle.textContent = 'Change Password'
  passwordTitle.style.cssText = `
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  `

  const currentPasswordLabel2 = document.createElement('label')
  currentPasswordLabel2.textContent = 'Current password'
  currentPasswordLabel2.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `

  const currentPasswordInput2 = document.createElement('input')
  currentPasswordInput2.type = 'password'
  currentPasswordInput2.placeholder = 'Enter current password'
  currentPasswordInput2.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    border-radius: 0;
  `

  const newPasswordLabel = document.createElement('label')
  newPasswordLabel.textContent = 'New password'
  newPasswordLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `

  const newPasswordInput = document.createElement('input')
  newPasswordInput.type = 'password'
  newPasswordInput.placeholder = 'Enter new password'
  newPasswordInput.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    border-radius: 0;
  `

  const confirmPasswordLabel = document.createElement('label')
  confirmPasswordLabel.textContent = 'Confirm password'
  confirmPasswordLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `

  const confirmPasswordInput = document.createElement('input')
  confirmPasswordInput.type = 'password'
  confirmPasswordInput.placeholder = 'Confirm new password'
  confirmPasswordInput.style.cssText = `
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
    margin-bottom: 1rem;
    border-radius: 0;
  `

  const passwordSaveButton = document.createElement('button')
  passwordSaveButton.textContent = 'Save'
  passwordSaveButton.style.cssText = `
    background: var(--accent);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 600;
    transition: opacity 0.2s;
  `

  const passwordMessage = document.createElement('div')
  passwordMessage.style.cssText = `
    margin-top: 0.5rem;
    font-size: 0.875rem;
    min-height: 1.25rem;
  `

  passwordSection.appendChild(passwordTitle)
  passwordSection.appendChild(currentPasswordLabel2)
  passwordSection.appendChild(currentPasswordInput2)
  passwordSection.appendChild(newPasswordLabel)
  passwordSection.appendChild(newPasswordInput)
  passwordSection.appendChild(confirmPasswordLabel)
  passwordSection.appendChild(confirmPasswordInput)
  passwordSection.appendChild(passwordSaveButton)
  passwordSection.appendChild(passwordMessage)

  // Event handlers
  languageSaveButton.addEventListener('click', async () => {
    const language = languageSelect.value
    languageMessage.textContent = ''
    languageSaveButton.disabled = true
    languageSaveButton.style.opacity = '0.6'

    try {
      const response = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ language })
      })

      if (response.ok) {
        languageMessage.textContent = '✓ Saved'
        languageMessage.style.color = 'var(--success, #10b981)'
      } else {
        const errorData = await response.json() as { error?: string }
        languageMessage.textContent = errorData.error || 'Failed to save'
        languageMessage.style.color = 'var(--danger)'
      }
    } catch (error: any) {
      languageMessage.textContent = 'Network error'
      languageMessage.style.color = 'var(--danger)'
    } finally {
      languageSaveButton.disabled = false
      languageSaveButton.style.opacity = '1'
    }
  })

  emailSaveButton.addEventListener('click', async () => {
    const currentPassword = currentPasswordInput.value.trim()
    const newEmail = newEmailInput.value.trim()

    if (!currentPassword || !newEmail) {
      emailMessage.textContent = 'Please fill in all fields'
      emailMessage.style.color = 'var(--danger)'
      return
    }

    emailMessage.textContent = ''
    emailSaveButton.disabled = true
    emailSaveButton.style.opacity = '0.6'

    try {
      const response = await fetch('/api/users/me/email', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ current_password: currentPassword, new_email: newEmail })
      })

      if (response.ok) {
        emailMessage.textContent = '✓ Saved'
        emailMessage.style.color = 'var(--success, #10b981)'
        currentPasswordInput.value = ''
        newEmailInput.value = ''
      } else {
        const errorData = await response.json() as { error?: string }
        emailMessage.textContent = errorData.error || 'Failed to save'
        emailMessage.style.color = 'var(--danger)'
      }
    } catch (error: any) {
      emailMessage.textContent = 'Network error'
      emailMessage.style.color = 'var(--danger)'
    } finally {
      emailSaveButton.disabled = false
      emailSaveButton.style.opacity = '1'
    }
  })

  passwordSaveButton.addEventListener('click', async () => {
    const currentPassword = currentPasswordInput2.value.trim()
    const newPassword = newPasswordInput.value.trim()
    const confirmPassword = confirmPasswordInput.value.trim()

    if (!currentPassword || !newPassword || !confirmPassword) {
      passwordMessage.textContent = 'Please fill in all fields'
      passwordMessage.style.color = 'var(--danger)'
      return
    }

    if (newPassword !== confirmPassword) {
      passwordMessage.textContent = 'Passwords do not match'
      passwordMessage.style.color = 'var(--danger)'
      return
    }

    if (newPassword.length < 8 || newPassword.length > 128) {
      passwordMessage.textContent = 'Password must be 8-128 characters'
      passwordMessage.style.color = 'var(--danger)'
      return
    }

    passwordMessage.textContent = ''
    passwordSaveButton.disabled = true
    passwordSaveButton.style.opacity = '0.6'

    try {
      const response = await fetch('/api/users/me/password', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
      })

      if (response.ok) {
        passwordMessage.textContent = '✓ Saved'
        passwordMessage.style.color = 'var(--success, #10b981)'
        currentPasswordInput2.value = ''
        newPasswordInput.value = ''
        confirmPasswordInput.value = ''
      } else {
        const errorData = await response.json() as { error?: string }
        passwordMessage.textContent = errorData.error || 'Failed to save'
        passwordMessage.style.color = 'var(--danger)'
      }
    } catch (error: any) {
      passwordMessage.textContent = 'Network error'
      passwordMessage.style.color = 'var(--danger)'
    } finally {
      passwordSaveButton.disabled = false
      passwordSaveButton.style.opacity = '1'
    }
  })

  // Add hover effects
  const buttons = [languageSaveButton, emailSaveButton, passwordSaveButton]
  buttons.forEach((button: HTMLButtonElement) => {
    button.addEventListener('mouseenter', () => {
      if (!button.disabled) {
        button.style.opacity = '0.8'
      }
    })
    button.addEventListener('mouseleave', () => {
      if (!button.disabled) {
        button.style.opacity = '1'
      }
    })
  })

  container.appendChild(header)
  container.appendChild(languageSection)
  container.appendChild(mutedWordsSection)
  container.appendChild(emailSection)
  container.appendChild(passwordSection)

  return {
    getElement: () => container,
    destroy: () => {
      container.remove()
    }
  }
}
