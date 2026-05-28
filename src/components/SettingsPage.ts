import { clearMeCache } from '../lib/auth-cache'
import { t, setLocale, getLocale, initI18n } from '../lib/i18n.js'
import { createConfirmDialog } from '../lib/confirm-dialog.js'

interface SettingsPageProps {
  currentUser?: {
    id: string
    username: string
    display_name?: string
    avatar_key?: string
    language?: string
    email?: string
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
  header.textContent = t('settings.title')
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
    accountTitle.textContent = t('settings.account')
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
    logoutButton.textContent = t('auth.sign_out')
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
      const confirmed = await createConfirmDialog(t('auth.logout_confirm', { username: currentUser.username }))
      if (!confirmed) return
      try {
        const response = await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'include'
        })
        
        if (response.ok) {
          clearMeCache()
          window.location.href = '/'
        } else {
          alert(t('auth.logout_failed'))
        }
      } catch (error) {
        console.error('Logout error:', error)
        alert(t('auth.logout_error'))
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
  languageTitle.textContent = t('settings.language')
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
  languageSaveButton.textContent = t('common.save')
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
  emailTitle.textContent = t('settings.change_email')
  emailTitle.style.cssText = `
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  `

  const currentPasswordLabel = document.createElement('label')
  currentPasswordLabel.textContent = t('settings.email_current_password')
  currentPasswordLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `

  const currentPasswordInput = document.createElement('input')
  currentPasswordInput.type = 'password'
  currentPasswordInput.placeholder = t('settings.email_current_password_placeholder')
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
  newEmailLabel.textContent = t('settings.email_new_email')
  newEmailLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `

  const newEmailInput = document.createElement('input')
  newEmailInput.type = 'email'
  newEmailInput.placeholder = t('settings.email_new_email_placeholder')
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
  emailSaveButton.textContent = t('common.save')
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
  passwordTitle.textContent = t('settings.change_password')
  passwordTitle.style.cssText = `
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  `

  const currentPasswordLabel2 = document.createElement('label')
  currentPasswordLabel2.textContent = t('settings.password_current')
  currentPasswordLabel2.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `

  const currentPasswordInput2 = document.createElement('input')
  currentPasswordInput2.type = 'password'
  currentPasswordInput2.placeholder = t('settings.password_current_placeholder')
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
  newPasswordLabel.textContent = t('settings.password_new')
  newPasswordLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `

  const newPasswordInput = document.createElement('input')
  newPasswordInput.type = 'password'
  newPasswordInput.placeholder = t('settings.password_new_placeholder')
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
  confirmPasswordLabel.textContent = t('settings.password_confirm')
  confirmPasswordLabel.style.cssText = `
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text-primary);
  `

  const confirmPasswordInput = document.createElement('input')
  confirmPasswordInput.type = 'password'
  confirmPasswordInput.placeholder = t('settings.password_confirm_placeholder')
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
  passwordSaveButton.textContent = t('common.save')
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
        languageMessage.textContent = t('settings.language_saved')
        languageMessage.style.color = 'var(--success, #10b981)'
        await setLocale(language)
        location.reload()
      } else {
        const errorData = await response.json() as { error?: string }
        languageMessage.textContent = errorData.error || t('settings.language_save_failed')
        languageMessage.style.color = 'var(--danger)'
      }
    } catch (error: any) {
      languageMessage.textContent = t('settings.language_network_error')
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
      emailMessage.textContent = t('settings.email_fill_all')
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
        emailMessage.textContent = t('settings.email_saved')
        emailMessage.style.color = 'var(--success, #10b981)'
        currentPasswordInput.value = ''
        newEmailInput.value = ''
      } else {
        const errorData = await response.json() as { error?: string }
        emailMessage.textContent = errorData.error || t('settings.email_save_failed')
        emailMessage.style.color = 'var(--danger)'
      }
    } catch (error: any) {
      emailMessage.textContent = t('settings.email_network_error')
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
      passwordMessage.textContent = t('settings.password_fill_all')
      passwordMessage.style.color = 'var(--danger)'
      return
    }

    if (newPassword !== confirmPassword) {
      passwordMessage.textContent = t('settings.password_mismatch')
      passwordMessage.style.color = 'var(--danger)'
      return
    }

    if (newPassword.length < 8 || newPassword.length > 128) {
      passwordMessage.textContent = t('settings.password_length')
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
        passwordMessage.textContent = t('settings.password_saved')
        passwordMessage.style.color = 'var(--success, #10b981)'
        currentPasswordInput2.value = ''
        newPasswordInput.value = ''
        confirmPasswordInput.value = ''
      } else {
        const errorData = await response.json() as { error?: string }
        passwordMessage.textContent = errorData.error || t('settings.password_save_failed')
        passwordMessage.style.color = 'var(--danger)'
      }
    } catch (error: any) {
      passwordMessage.textContent = t('settings.password_network_error')
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
  container.appendChild(emailSection)
  container.appendChild(passwordSection)

  return {
    getElement: () => container,
    destroy: () => {
      container.remove()
    }
  }
}
