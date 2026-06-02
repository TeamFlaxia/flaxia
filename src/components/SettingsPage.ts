import { clearMeCache } from '../lib/auth-cache'
import { t, setLocale, getLocale, initI18n } from '../lib/i18n.js'
import { createConfirmDialog } from '../lib/confirm-dialog.js'
import { getReplyStyle, setReplyStyle, ReplyStyle } from '../lib/settings.js'

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
    padding: 0 1rem 2rem;
  `

  const topBar = document.createElement('div')
  topBar.style.cssText = `
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--bg-primary);
    z-index: 10;
    margin-bottom: 2rem;
  `

  const backBtn = document.createElement('button')
  backBtn.textContent = '←'
  backBtn.style.cssText = `
    background: none;
    border: none;
    font-size: 1.25rem;
    cursor: pointer;
    color: var(--text-primary);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    transition: background 0.2s;
  `
  backBtn.addEventListener('mouseenter', () => { backBtn.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))' })
  backBtn.addEventListener('mouseleave', () => { backBtn.style.background = 'none' })
  backBtn.addEventListener('click', () => window.history.back())

  const title = document.createElement('h1')
  title.textContent = t('settings.title')
  title.style.cssText = `
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  `

  topBar.appendChild(backBtn)
  topBar.appendChild(title)
  container.appendChild(topBar)

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

    const avatarEl = document.createElement('img')
    avatarEl.src = avatarUrl
    avatarEl.alt = ''
    avatarEl.style.cssText = 'width: 60px; height: 60px; border-radius: 50%; object-fit: cover; border: 1px solid var(--border);'
    avatarEl.onerror = () => { avatarEl.src = '/api/images/default-avatar' }
    userChip.appendChild(avatarEl)

    const infoDiv = document.createElement('div')
    infoDiv.style.cssText = 'flex: 1; min-width: 0;'
    userChip.appendChild(infoDiv)

    const displayNameEl = document.createElement('div')
    displayNameEl.style.cssText = 'font-size: 1.125rem; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;'
    displayNameEl.textContent = displayName
    infoDiv.appendChild(displayNameEl)

    const usernameEl = document.createElement('div')
    usernameEl.style.cssText = 'color: var(--text-muted); font-family: monospace; font-size: 0.875rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;'
    usernameEl.textContent = `@${currentUser.username}`
    infoDiv.appendChild(usernameEl)

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

  // Display Section
  const displaySection = document.createElement('div')
  displaySection.className = 'settings-section'
  displaySection.style.cssText = `
    margin-bottom: 2rem;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
  `

  const displayTitle = document.createElement('h2')
  displayTitle.textContent = t('settings.display')
  displayTitle.style.cssText = `
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  `

  const currentStyle = getReplyStyle()

  const radioGroup = document.createElement('div')
  radioGroup.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1rem;
  `

  const styles: { value: ReplyStyle; labelKey: string; descKey: string }[] = [
    { value: 'twitter', labelKey: 'settings.reply_style_twitter', descKey: 'settings.reply_style_twitter_desc' },
    { value: '2ch', labelKey: 'settings.reply_style_2ch', descKey: 'settings.reply_style_2ch_desc' },
  ]

  styles.forEach(s => {
    const label = document.createElement('label')
    label.style.cssText = `
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      transition: border-color 0.2s;
      ${currentStyle === s.value ? 'border-color: var(--accent); background: var(--bg-secondary);' : ''}
    `

    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'reply-style'
    radio.value = s.value
    radio.checked = currentStyle === s.value
    radio.style.cssText = 'accent-color: var(--accent);'

    const textDiv = document.createElement('div')
    textDiv.style.cssText = 'display: flex; flex-direction: column;'

    const nameSpan = document.createElement('span')
    nameSpan.style.cssText = 'font-weight: 600; color: var(--text-primary); font-size: 0.9375rem;'
    nameSpan.textContent = t(s.labelKey)

    const descSpan = document.createElement('span')
    descSpan.style.cssText = 'color: var(--text-muted); font-size: 0.8125rem;'
    descSpan.textContent = t(s.descKey)

    textDiv.appendChild(nameSpan)
    textDiv.appendChild(descSpan)
    label.appendChild(radio)
    label.appendChild(textDiv)
    radioGroup.appendChild(label)

    radio.addEventListener('change', () => {
      setReplyStyle(s.value)
      radioGroup.querySelectorAll('label').forEach(l => {
        l.style.borderColor = 'var(--border)'
        l.style.background = 'none'
      })
      label.style.borderColor = 'var(--accent)'
      label.style.background = 'var(--bg-secondary)'
      displayMessage.textContent = t('settings.display_saved')
      displayMessage.style.color = 'var(--success, #10b981)'
    })
  })

  const displayMessage = document.createElement('div')
  displayMessage.style.cssText = `
    margin-top: 0.5rem;
    font-size: 0.875rem;
    min-height: 1.25rem;
  `

  displaySection.appendChild(displayTitle)
  displaySection.appendChild(radioGroup)
  displaySection.appendChild(displayMessage)

  container.appendChild(displaySection)

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

  fetch('/locales/index.json').then(r => r.json()).then(locales => {
    languageSelect.innerHTML = ''
    ;(locales as { code: string; nativeName: string }[]).forEach(l => {
      const opt = document.createElement('option')
      opt.value = l.code
      opt.textContent = l.nativeName
      languageSelect.appendChild(opt)
    })
    if (currentUser?.language) {
      languageSelect.value = currentUser.language
    } else {
      languageSelect.value = getLocale()
    }
  }).catch(() => {
    ;['en', 'ja'].forEach(code => {
      const opt = document.createElement('option')
      opt.value = code
      opt.textContent = code
      languageSelect.appendChild(opt)
    })
  })

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
