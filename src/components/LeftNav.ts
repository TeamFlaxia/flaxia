import { clearMeCache } from '../lib/auth-cache'
import { isModalOpen } from '../lib/modal-state'
import { t } from '../lib/i18n.js'

export interface LeftNavProps {
  activeItem?: string
  unreadCount?: number
  onNavigate?: (item: string) => void
  onSignIn?: () => void
  onSignUp?: () => void
  currentUser?: {
    id: string
    username: string
    display_name?: string
    avatar_key?: string
  }
}

export class LeftNav {
  private element: HTMLElement
  private props: LeftNavProps
  private activeItem: string
  private userAreaElement: HTMLElement | null = null
  private popupMenuElement: HTMLElement | null = null
  private isPopupMenuOpen = false
  private boundHandleResize: () => void
  private boundHandleModalChange: (e: Event) => void

  constructor(props: LeftNavProps = {}) {
    this.props = props
    this.activeItem = props.activeItem || 'home'
    
    // Initialize bound event handler for proper cleanup
    this.boundHandleResize = this.handleWindowResize.bind(this)
    this.boundHandleModalChange = this.handleModalChange.bind(this)
    
    this.element = this.createElement()
    this.setupEventListeners()
  }

  private createElement(): HTMLElement {
    const nav = document.createElement('nav')
    nav.className = 'left-nav'

    // Logo section
    const logo = document.createElement('div')
    logo.className = 'nav-logo'
    const logoInner = document.createElement('div')
    logoInner.style.cssText = 'display: flex; align-items: center; gap: 0.5rem; margin-bottom: 2rem; cursor: pointer;'

    const logoIcon = document.createElement('span')
    logoIcon.style.fontSize = '1.5rem'
    logoIcon.textContent = '🌿'

    const logoText = document.createElement('span')
    logoText.style.cssText = 'font-size: 1.25rem; font-weight: 600; color: var(--accent);'
    logoText.textContent = t('nav.logo')

    logoInner.appendChild(logoIcon)
    logoInner.appendChild(logoText)
    logo.appendChild(logoInner)
    logo.addEventListener('click', () => {
      this.props.onNavigate?.('home')
    })

    // Navigation items - different for guests vs logged-in users
    const navItems = document.createElement('div')
    navItems.className = 'nav-items'
    
    if (this.props.currentUser) {
      // Full navigation for logged-in users
      const items = [
        { id: 'home', label: t('nav.home'), icon: '🏠' },
        { id: 'explore', label: t('nav.explore'), icon: '🔍' },
        { id: 'arcade', label: t('nav.arcade'), icon: '🕹️' },
        { id: 'notifications', label: t('nav.notifications'), icon: '🔔' },
        { id: 'profile', label: t('nav.profile'), icon: '👤' },
        { id: 'settings', label: t('nav.settings'), icon: '⚙️' }
      ]

      items.forEach(item => {
        const navItem = document.createElement('button')
        navItem.className = `nav-item ${this.activeItem === item.id ? 'nav-item--active' : ''}`
        navItem.setAttribute('data-nav-id', item.id)

        const iconSpan = document.createElement('span')
        iconSpan.style.marginRight = '0.75rem'
        iconSpan.textContent = item.icon

        const labelSpan = document.createElement('span')
        labelSpan.textContent = item.label

        navItem.appendChild(iconSpan)
        navItem.appendChild(labelSpan)

        if (item.id === 'notifications' && this.props.unreadCount && this.props.unreadCount > 0) {
          const badge = document.createElement('span')
          badge.className = 'nav-badge'
          badge.style.cssText = `
            margin-left: auto;
            background: var(--accent);
            font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 0.75rem;
            padding: 2px 8px;
            border-radius: 9999px;
            min-width: 20px;
            text-align: center;
          `
          badge.textContent = this.props.unreadCount >= 99 ? '99+' : String(this.props.unreadCount)
          navItem.appendChild(badge)
        }

        navItems.appendChild(navItem)
      })
    } else {
      // Simplified navigation for guests
      const items = [
        { id: 'home', label: t('nav.home'), icon: '🏠' },
        { id: 'explore', label: t('nav.explore'), icon: '🔍' },
        { id: 'arcade', label: t('nav.arcade'), icon: '🕹️' },
        { id: 'settings', label: t('nav.settings'), icon: '⚙️' }
      ]

      items.forEach(item => {
        const navItem = document.createElement('button')
        navItem.className = `nav-item ${this.activeItem === item.id ? 'nav-item--active' : ''}`
        navItem.setAttribute('data-nav-id', item.id)

        const iconSpan = document.createElement('span')
        iconSpan.style.marginRight = '0.75rem'
        iconSpan.textContent = item.icon

        const labelSpan = document.createElement('span')
        labelSpan.textContent = item.label

        navItem.appendChild(iconSpan)
        navItem.appendChild(labelSpan)
        navItems.appendChild(navItem)
      })
    }

    nav.appendChild(logo)
    nav.appendChild(navItems)

    // Add legal links (privacy policy and terms)
    const legalLinks = document.createElement('div')
    legalLinks.className = 'nav-legal-links'
    legalLinks.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin-top: 1.5rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border);
    `

    const privacyLink = document.createElement('a')
    privacyLink.href = '/privacy'
    privacyLink.textContent = t('legal.footer_privacy')
    privacyLink.style.cssText = `
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.875rem;
      transition: color 0.2s;
    `

    const termsLink = document.createElement('a')
    termsLink.href = '/terms'
    termsLink.textContent = t('legal.footer_terms')
    termsLink.style.cssText = `
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.875rem;
      transition: color 0.2s;
    `

    privacyLink.addEventListener('mouseenter', () => {
      privacyLink.style.color = 'var(--text-primary)'
    })
    privacyLink.addEventListener('mouseleave', () => {
      privacyLink.style.color = 'var(--text-muted)'
    })

    termsLink.addEventListener('mouseenter', () => {
      termsLink.style.color = 'var(--text-primary)'
    })
    termsLink.addEventListener('mouseleave', () => {
      termsLink.style.color = 'var(--text-muted)'
    })

    // Create About flaxia link
    const aboutLink = document.createElement('a')
    aboutLink.href = '/about'
    aboutLink.textContent = t('legal.footer_about')
    aboutLink.style.cssText = `
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.875rem;
      font-family: monospace;
      transition: color 0.2s;
    `
    aboutLink.addEventListener('click', (e) => {
      e.preventDefault()
      window.location.href = '/about'
    })
    aboutLink.addEventListener('mouseenter', () => {
      aboutLink.style.color = 'var(--text-primary)'
    })
    aboutLink.addEventListener('mouseleave', () => {
      aboutLink.style.color = 'var(--text-muted)'
    })

    legalLinks.appendChild(privacyLink)
    legalLinks.appendChild(termsLink)
    legalLinks.appendChild(aboutLink)
    
    // Create White Paper link
    const whitepaperLink = document.createElement('a')
    whitepaperLink.href = '/whitepaper'
  whitepaperLink.textContent = t('legal.footer_whitepaper')
    whitepaperLink.style.cssText = `
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.875rem;
      font-family: monospace;
      transition: color 0.2s;
    `
    whitepaperLink.addEventListener('click', (e) => {
      e.preventDefault()
      window.location.href = '/whitepaper'
    })
    whitepaperLink.addEventListener('mouseenter', () => {
      whitepaperLink.style.color = 'var(--text-primary)'
    })
    whitepaperLink.addEventListener('mouseleave', () => {
      whitepaperLink.style.color = 'var(--text-muted)'
    })
    
    legalLinks.appendChild(whitepaperLink)
    nav.appendChild(legalLinks)

    if (!this.props.currentUser) {
      // Sign in and Sign up buttons for guests
      const authButtons = document.createElement('div')
      authButtons.className = 'nav-auth-buttons'
      authButtons.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        margin-top: 1rem;
      `

      // Sign up button (changed from sign in)
      const signUpButton = document.createElement('button')
      signUpButton.className = 'nav-signin-button'
      signUpButton.textContent = 'Sign up'
      signUpButton.style.cssText = `
        padding: 0.75rem 1.5rem;
        background: var(--text-primary);
        color: var(--bg-primary);
        border: none;
        border-radius: 9999px;
        cursor: pointer;
        font-size: 0.875rem;
        font-weight: 600;
        transition: opacity 0.2s;
      `
      signUpButton.addEventListener('mouseenter', () => {
        signUpButton.style.opacity = '0.8'
      })
      signUpButton.addEventListener('mouseleave', () => {
        signUpButton.style.opacity = '1'
      })
      signUpButton.addEventListener('click', () => {
        this.props.onSignUp?.()
      })

      
      authButtons.appendChild(signUpButton)
      nav.appendChild(authButtons)
    }

    return nav
  }

  private setupEventListeners(): void {
    // Navigation items
    this.element.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement
        const navId = target.getAttribute('data-nav-id')
        if (navId) {
          this.setActiveItem(navId)
          this.props.onNavigate?.(navId)
        }
      })
    })

    // Handle window resize for mobile detection
    window.addEventListener('resize', this.boundHandleResize)

    // Hide nav when modal is open
    window.addEventListener('modalchange', this.boundHandleModalChange)
    this.updateModalVisibility()
  }

  private handleWindowResize(): void {
  }

  private handleModalChange(): void {
    this.updateModalVisibility()
  }

  private updateModalVisibility(): void {
    this.element.style.display = isModalOpen() ? 'none' : ''
  }

  public setActiveItem(item: string): void {
    this.activeItem = item
    
    // Update active state
    this.element.querySelectorAll('.nav-item').forEach(navItem => {
      const navId = navItem.getAttribute('data-nav-id')
      if (navId === item) {
        navItem.classList.add('nav-item--active')
      } else {
        navItem.classList.remove('nav-item--active')
      }
    })
  }

  public getElement(): HTMLElement {
    return this.element
  }

  public setUnreadCount(count: number): void {
    this.props.unreadCount = count
    const navItem = this.element.querySelector('[data-nav-id="notifications"]')
    if (!navItem) return

    const existingBadge = navItem.querySelector('.nav-badge')
    if (count > 0) {
      if (existingBadge) {
        existingBadge.textContent = count >= 99 ? '99+' : String(count)
      } else {
        const badge = document.createElement('span')
        badge.className = 'nav-badge'
        badge.style.cssText = `
          margin-left: auto;
          background: var(--accent);
          font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 0.75rem;
          padding: 2px 8px;
          border-radius: 9999px;
          min-width: 20px;
          text-align: center;
        `
        badge.textContent = count >= 99 ? '99+' : String(count)
        navItem.appendChild(badge)
      }
    } else if (existingBadge) {
      existingBadge.remove()
    }
  }

  public destroy(): void {
    // Clean up window event listeners
    window.removeEventListener('resize', this.boundHandleResize)
    window.removeEventListener('modalchange', this.boundHandleModalChange)
    
    // Clean up event listeners and remove element
    this.element.remove()
  }
}

// Factory function for easier usage
export function createLeftNav(props: LeftNavProps = {}): LeftNav {
  return new LeftNav(props)
}

// Update function to handle user changes
export function updateLeftNavUser(leftNav: LeftNav, currentUser: {
  id: string
  username: string
  display_name?: string
  avatar_key?: string
} | null): void {
  // Update the props
  ;(leftNav as any).props.currentUser = currentUser
  
  // Remove existing user area if present
  const existingUserArea = leftNav.getElement().querySelector('.nav-user-area')
  if (existingUserArea) {
    existingUserArea.remove()
  }
  
  // Remove existing auth buttons if present (guest state)
  const existingAuthButtons = leftNav.getElement().querySelector('.nav-auth-buttons')
  if (existingAuthButtons) {
    existingAuthButtons.remove()
  }
  
  // Rebuild navigation items
  const navItems = leftNav.getElement().querySelector('.nav-items')
  if (navItems) {
    navItems.innerHTML = ''
    
    if (currentUser) {
      // Full navigation for logged-in users
      const items = [
        { id: 'home', label: t('nav.home'), icon: '🏠' },
        { id: 'explore', label: t('nav.explore'), icon: '🔍' },
        { id: 'arcade', label: t('nav.arcade'), icon: '🕹️' },
        { id: 'notifications', label: t('nav.notifications'), icon: '🔔' },
        { id: 'profile', label: t('nav.profile'), icon: '👤' },
        { id: 'settings', label: t('nav.settings'), icon: '⚙️' }
      ]

      items.forEach(item => {
        const navItem = document.createElement('button')
        navItem.className = `nav-item ${(leftNav as any).activeItem === item.id ? 'nav-item--active' : ''}`
        navItem.setAttribute('data-nav-id', item.id)
        navItem.innerHTML = `<span style="margin-right: 0.75rem;">${item.icon}</span><span>${item.label}</span>`

        // Add unread badge for notifications
        if (item.id === 'notifications' && (leftNav as any).props.unreadCount > 0) {
          const badge = document.createElement('span')
          badge.className = 'nav-badge'
          badge.style.cssText = `
            margin-left: auto;
            background: var(--accent);
            font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 0.75rem;
            padding: 2px 8px;
            border-radius: 9999px;
            min-width: 20px;
            text-align: center;
          `
          badge.textContent = (leftNav as any).props.unreadCount >= 99 ? '99+' : String((leftNav as any).props.unreadCount)
          navItem.appendChild(badge)
        }

        navItem.addEventListener('click', () => {
          (leftNav as any).setActiveItem(item.id)
          ;(leftNav as any).props.onNavigate?.(item.id)
        })
        navItems.appendChild(navItem)
      })
    } else {
      // Simplified navigation for guests
      const items = [
        { id: 'home', label: t('nav.home'), icon: '🏠' },
        { id: 'explore', label: t('nav.explore'), icon: '🔍' },
        { id: 'arcade', label: t('nav.arcade'), icon: '🕹️' },
        { id: 'settings', label: t('nav.settings'), icon: '⚙️' }
      ]

      items.forEach(item => {
        const navItem = document.createElement('button')
        navItem.className = `nav-item ${(leftNav as any).activeItem === item.id ? 'nav-item--active' : ''}`
        navItem.setAttribute('data-nav-id', item.id)
        navItem.innerHTML = `<span style="margin-right: 0.75rem;">${item.icon}</span><span>${item.label}</span>`
        navItem.addEventListener('click', () => {
          (leftNav as any).setActiveItem(item.id)
          ;(leftNav as any).props.onNavigate?.(item.id)
        })
        navItems.appendChild(navItem)
      })
    }
  }
  
  // Add legal links (privacy policy and terms)
  const legalLinks = document.createElement('div')
  legalLinks.className = 'nav-legal-links'
  legalLinks.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  `

  const privacyLink = document.createElement('a')
  privacyLink.href = '/privacy'
  privacyLink.textContent = t('legal.footer_privacy')
  privacyLink.style.cssText = `
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.875rem;
    transition: color 0.2s;
  `

  const termsLink = document.createElement('a')
  termsLink.href = '/terms'
  termsLink.textContent = t('legal.footer_terms')
  termsLink.style.cssText = `
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.875rem;
    transition: color 0.2s;
  `

  privacyLink.addEventListener('mouseenter', () => {
    privacyLink.style.color = 'var(--text-primary)'
  })
  privacyLink.addEventListener('mouseleave', () => {
    privacyLink.style.color = 'var(--text-muted)'
  })

  termsLink.addEventListener('mouseenter', () => {
    termsLink.style.color = 'var(--text-primary)'
  })
  termsLink.addEventListener('mouseleave', () => {
    termsLink.style.color = 'var(--text-muted)'
  })

  // Create About flaxia link
  const aboutLink = document.createElement('a')
  aboutLink.href = '/about'
  aboutLink.textContent = t('legal.footer_about')
  aboutLink.style.cssText = `
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.875rem;
    font-family: monospace;
    transition: color 0.2s;
  `
  aboutLink.addEventListener('click', (e) => {
    e.preventDefault()
    window.location.href = '/about'
  })
  aboutLink.addEventListener('mouseenter', () => {
    aboutLink.style.color = 'var(--text-primary)'
  })
  aboutLink.addEventListener('mouseleave', () => {
    aboutLink.style.color = 'var(--text-muted)'
  })

  legalLinks.appendChild(privacyLink)
  legalLinks.appendChild(termsLink)
  legalLinks.appendChild(aboutLink)
  
  // Create White Paper link
  const whitepaperLink = document.createElement('a')
  whitepaperLink.href = '/whitepaper'
  whitepaperLink.textContent = t('legal.footer_whitepaper')
  whitepaperLink.style.cssText = `
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.875rem;
    font-family: monospace;
    transition: color 0.2s;
  `
  whitepaperLink.addEventListener('click', (e) => {
    e.preventDefault()
    window.location.href = '/whitepaper'
  })
  whitepaperLink.addEventListener('mouseenter', () => {
    whitepaperLink.style.color = 'var(--text-primary)'
  })
  whitepaperLink.addEventListener('mouseleave', () => {
    whitepaperLink.style.color = 'var(--text-muted)'
  })
  
  legalLinks.appendChild(whitepaperLink)
  leftNav.getElement().appendChild(legalLinks)
  
  if (!currentUser) {
    // Add auth buttons for guests
    const authButtons = document.createElement('div')
    authButtons.className = 'nav-auth-buttons'
    authButtons.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-top: 1rem;
    `

    const signUpButton = document.createElement('button')
    signUpButton.className = 'nav-signin-button'
    signUpButton.textContent = 'Sign up'
    signUpButton.style.cssText = `
      padding: 0.75rem 1.5rem;
      background: var(--text-primary);
      color: var(--bg-primary);
      border: none;
      border-radius: 9999px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 600;
      transition: opacity 0.2s;
    `
    signUpButton.addEventListener('mouseenter', () => {
      signUpButton.style.opacity = '0.8'
    })
    signUpButton.addEventListener('mouseleave', () => {
      signUpButton.style.opacity = '1'
    })
    signUpButton.addEventListener('click', () => {
      ;(leftNav as any).props.onSignUp?.()
    })

    authButtons.appendChild(signUpButton)
    leftNav.getElement().appendChild(authButtons)
  }
}
