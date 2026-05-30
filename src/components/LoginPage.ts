import { t } from '../lib/i18n.js'

interface LoginProps {
  onSuccess: () => void
}

export function createLoginPage({ onSuccess }: LoginProps) {
  // Create main container
  const container = document.createElement('div')
  container.className = 'auth-page'

  // Create card
  const card = document.createElement('div')
  card.className = 'auth-card'

  // Back button
  const backButton = document.createElement('button')
  backButton.className = 'auth-back'
  backButton.innerHTML = '← ' + t('auth.back')
  backButton.addEventListener('click', () => {
    window.history.pushState({}, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

  // Logo
  const logo = document.createElement('div')
  logo.className = 'auth-logo'
  logo.textContent = t('login.title')

  // Heading
  const heading = document.createElement('h1')
  heading.className = 'auth-heading'
  heading.textContent = t('login.heading')

  // Form
  const form = document.createElement('form')
  form.className = 'auth-form'

  // Email input
  const emailGroup = document.createElement('div')
  emailGroup.className = 'form-group'
  
  const emailInput = document.createElement('input')
  emailInput.type = 'email'
  emailInput.placeholder = t('login.email_placeholder')
  emailInput.className = 'auth-input'
  emailInput.required = true

  // Password input
  const passwordGroup = document.createElement('div')
  passwordGroup.className = 'form-group'
  
  const passwordInput = document.createElement('input')
  passwordInput.type = 'password'
  passwordInput.placeholder = t('login.password_placeholder')
  passwordInput.className = 'auth-input'
  passwordInput.required = true

  // Error message
  const errorDiv = document.createElement('div')
  errorDiv.className = 'auth-error'
  errorDiv.style.display = 'none'

  // Submit button
  const submitButton = document.createElement('button')
  submitButton.type = 'submit'
  submitButton.className = 'auth-button'
  submitButton.textContent = t('login.submit')
  submitButton.disabled = true

  // Register link
  const registerLink = document.createElement('div')
  registerLink.className = 'auth-link'
  registerLink.innerHTML = t('login.register_link')

  // Legal notice
  const legalNotice = document.createElement('div')
  legalNotice.className = 'legal-notice'
  legalNotice.innerHTML = t('login.agree_terms')

  // Validation
  const validateForm = () => {
    const emailValid = emailInput.value.trim() !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput.value)
    const passwordValid = passwordInput.value.trim() !== ''
    submitButton.disabled = !(emailValid && passwordValid)
  }

  emailInput.addEventListener('input', validateForm)
  passwordInput.addEventListener('input', validateForm)

  // Form submission
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    
    const email = emailInput.value.trim()
    const password = passwordInput.value.trim()

    if (!email || !password) {
      errorDiv.textContent = t('login.error_fill_all')
      errorDiv.style.display = 'block'
      return
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errorDiv.textContent = t('login.error_email_invalid')
      errorDiv.style.display = 'block'
      return
    }

    submitButton.disabled = true
    submitButton.textContent = t('login.submitting')

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, password })
      })

      const data = await response.json() as { error?: string }

      if (response.ok) {
        onSuccess()
      } else {
        errorDiv.textContent = data.error || t('login.error_invalid')
        errorDiv.style.display = 'block'
      }
    } catch (error) {
      console.error('Login error:', error)
      errorDiv.textContent = t('login.error_network')
      errorDiv.style.display = 'block'
    } finally {
      submitButton.disabled = false
      submitButton.textContent = t('login.submit')
    }
  })

  // Assemble form
  emailGroup.appendChild(emailInput)
  passwordGroup.appendChild(passwordInput)
  form.appendChild(emailGroup)
  form.appendChild(passwordGroup)
  form.appendChild(errorDiv)
  form.appendChild(submitButton)

  // Assemble card
  card.appendChild(backButton)
  card.appendChild(logo)
  card.appendChild(heading)
  card.appendChild(form)
  card.appendChild(legalNotice)
  card.appendChild(registerLink)

  // Assemble container
  container.appendChild(card)

  // Handle register link click
  const registerAnchor = registerLink.querySelector('a')
  if (registerAnchor) {
    registerAnchor.addEventListener('click', (e) => {
      e.preventDefault()
      window.history.pushState({}, '', '/register')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
  }

  return {
    getElement: () => container,
    destroy: () => {
      // Cleanup if needed
    }
  }
}
