import { createTimeline } from './components/Timeline.js'
import { createLeftNav, updateLeftNavUser } from './components/LeftNav.js'
import { createRightPanel } from './components/RightPanel.js'
import { createThreadPage } from './components/ThreadPage.js'
import { getMe, clearMeCache, updateMeCache } from './lib/auth-cache.js'
import { createLoginPage } from './components/LoginPage.js'
import { createRegisterPage } from './components/RegisterPage.js'
import { createProfilePage } from './components/ProfilePage.js'
import { createExplorePage } from './components/ExplorePage.js'
import { createArcadePage } from './components/ArcadePage.js'
import { createLegalPage } from './components/LegalPage.js'
import { createNotificationsPage } from './components/NotificationsPage.js'
import { createAdminLayout } from './components/AdminLayout.js'
import { createAdminAlertsTab } from './components/AdminAlertsTab.js'
import { createAdminHiddenTab } from './components/AdminHiddenTab.js'
import { createAdminUsersTab } from './components/AdminUsersTab.js'
import { createAdminAdsTab } from './components/AdminAdsTab.js'
import { createSettingsPage } from './components/SettingsPage.js'
import { initPerformanceMonitoring } from './lib/performance.js'
import { safeRemoveFromBody } from './lib/dom-utils.js'

console.log('Flaxia initialized')

// Initialize performance monitoring
initPerformanceMonitoring()

// Basic app initialization
document.addEventListener('DOMContentLoaded', async () => {
  const app = document.getElementById('app')
  if (app) {
    console.log('App mounted')
    
    // Routing state
    let currentView: 'timeline' | 'thread' | 'login' | 'register' | 'profile' | 'explore' | 'notifications' | 'terms' | 'privacy' | 'about' | 'whitepaper' | 'admin' | 'settings' | 'arcade' = 'timeline'
    let currentPostId: string | null = null
    let currentUsername: string | null = null
    let currentTag: string | null = null
    let currentAdminTab: 'alerts' | 'hidden' | 'users' | 'ads' = 'alerts'
    let timeline: any = null
    let threadPage: any = null
    let loginPage: any = null
    let registerPage: any = null
    let profilePage: any = null
    let explorePage: any = null
    let legalPage: any = null
    let notificationsPage: any = null
    let settingsPage: any = null
    let arcadePage: any = null
    let adminLayout: any = null
    let adminAlertsTab: any = null
    let adminHiddenTab: any = null
    let adminUsersTab: any = null
    let adminAdsTab: any = null
    let leftNavInstances: Set<any> = new Set()
    let currentUser: { username: string; id: string; display_name?: string; avatar_key?: string } | null = null
    let unreadNotificationCount = 0
    let adminUsernames: string[] = []
    
    // Check current user session
    const checkAuth = async () => {
      try {
        const data = await getMe()
        if (data) {
          currentUser = { 
            id: data.user.id,
            username: data.user.username,
            display_name: data.user.display_name,
            avatar_key: data.user.avatar_key
          }
          
          // Update all existing LeftNav instances with new user data
          leftNavInstances.forEach(leftNav => {
            updateLeftNavUser(leftNav, currentUser)
          })
          
          return true
        }
      } catch (error) {
        console.log('Not authenticated:', error)
      }
      
      // Clear user state when not authenticated
      const wasLoggedIn = currentUser !== null
      currentUser = null
      
      // Update all existing LeftNav instances to remove user area
      leftNavInstances.forEach(leftNav => {
        updateLeftNavUser(leftNav, null)
      })
      
      // If user was logged in and now is not, they were logged out
      if (wasLoggedIn) {
        console.log('User session expired - redirecting to login')
        window.history.pushState({}, '', '/login')
        navigateTo('login')
        return false
      }
      
      return false
    }

    // Fetch notifications
    interface NotificationData {
      notifications: Array<{
        id: string
        type: 'reported' | 'fresh' | 'warned' | 'hidden'
        post_id: string
        post_text_preview: string
        actor?: {
          username: string
          display_name: string
          avatar_key: string | null
        }
        read: boolean
        created_at: string
      }>
      unread_count: number
    }

    const fetchNotifications = async (): Promise<NotificationData> => {
      try {
        const response = await fetch('/api/notifications', { credentials: 'include' })
        if (response.ok) {
          const data = await response.json() as NotificationData
          unreadNotificationCount = data.unread_count || 0
          return data
        }
      } catch (error) {
        console.log('Failed to fetch notifications:', error)
      }
      return { notifications: [], unread_count: 0 }
    }

    // Mobile left nav overlay management
    let leftNavOverlay: HTMLElement | null = null
    let leftNavOpenButton: HTMLButtonElement | null = null

    const createLeftNavOverlay = (): HTMLElement => {
      const overlay = document.createElement('div')
      overlay.className = 'left-nav-overlay'
      overlay.addEventListener('click', () => {
        closeLeftNav()
      })
      document.body.appendChild(overlay)
      return overlay
    }

    const createLeftNavOpenButton = (leftNavElement: HTMLElement): HTMLButtonElement => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'left-nav-open-button'
      button.setAttribute('aria-label', 'Open navigation')
      button.textContent = '→'
      button.addEventListener('click', () => {
        openLeftNav(leftNavElement)
      })
      document.body.appendChild(button)
      return button
    }

    const openLeftNav = (leftNavElement: HTMLElement): void => {
      if (window.innerWidth > 768) return

      leftNavElement.classList.add('left-nav--open')

      if (!leftNavOverlay) {
        leftNavOverlay = createLeftNavOverlay()
      }
      leftNavOverlay.classList.add('left-nav-overlay--visible')

      // Prevent body scroll
      document.body.style.overflow = 'hidden'
    }

    const closeLeftNav = (): void => {
      const leftNavElement = document.querySelector('.left-nav') as HTMLElement
      if (leftNavElement) {
        leftNavElement.classList.remove('left-nav--open')
      }

      if (leftNavOverlay) {
        leftNavOverlay.classList.remove('left-nav-overlay--visible')
      }

      // Restore body scroll
      document.body.style.overflow = ''
    }

    const setupMobileLeftNav = (leftNavElement: HTMLElement): void => {
      // Clean up existing button if it exists
      if (leftNavOpenButton) {
        leftNavOpenButton.remove()
        leftNavOpenButton = null
      }

      // Create the left-edge mobile nav button
      if (window.innerWidth <= 768) {
        leftNavOpenButton = createLeftNavOpenButton(leftNavElement)
        leftNavOpenButton.style.display = 'block'
      }

      // Listen for openLeftNav events from timeline
      document.addEventListener('openLeftNav', () => {
        openLeftNav(leftNavElement)
      })

      // Handle escape key to close
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closeLeftNav()
        }
      })

      // Handle window resize
      window.addEventListener('resize', () => {
        if (window.innerWidth > 768) {
          // Close mobile nav when resizing to desktop
          closeLeftNav()
          if (leftNavOpenButton) {
            leftNavOpenButton.remove()
            leftNavOpenButton = null
          }
        } else {
          if (!leftNavOpenButton) {
            leftNavOpenButton = createLeftNavOpenButton(leftNavElement)
          }
          leftNavOpenButton.style.display = 'block'
        }
      })
    }

    // Auth guard - redirect to login if not authenticated (only for protected routes)
    const requireAuth = async () => {
      const isAuthenticated = await checkAuth()
      
      // Check if current route is public (accessible to guests)
      const path = window.location.pathname
      const cleanPath = path.replace(/\/$/, '')
      const urlParams = new URLSearchParams(window.location.search)
      
      // Public routes that don't require authentication:
      // - / (home/timeline)
      // - /home (landing page)
      // - /explore (with or without tag parameter)
      // - /arcade (game arcade)
      // - /users/:username (profile pages)
      // - /thread/:id (thread pages)
      // - /terms, /privacy, /about, /whitepaper (legal pages)
      // - /login, /register (auth pages)
      const isPublicRoute = 
        cleanPath === '' || 
        cleanPath === '/' ||
        cleanPath === '/home' ||
        cleanPath === '/explore' ||
        cleanPath === '/arcade' ||
        cleanPath === '/login' ||
        cleanPath === '/register' ||
        cleanPath === '/terms' ||
        cleanPath === '/privacy' ||
        cleanPath === '/about' ||
        cleanPath === '/whitepaper' ||
        cleanPath.startsWith('/users/') ||
        cleanPath.startsWith('/thread/')
      
      // Allow public routes for everyone
      if (isPublicRoute) {
        return true
      }
      
      // For /notifications, redirect to arcade if not authenticated
      if (cleanPath === '/notifications') {
        if (!isAuthenticated) {
          window.history.pushState({}, '', '/arcade')
          navigateTo('arcade')
          return false
        }
        return true
      }
      
      // For all other protected routes, redirect to login if not authenticated
      if (!isAuthenticated) {
        window.history.pushState({}, '', '/login')
        navigateTo('login')
        return false
      }
      
      return true
    }

    // Parse current URL
    const parseCurrentRoute = () => {
      const path = window.location.pathname
      console.log('Current path:', path, 'Full URL:', window.location.href)
      
      // Remove trailing slash and ensure consistent format
      const cleanPath = path.replace(/\/$/, '')
      console.log('Clean path:', cleanPath)
      
      // Auth routes
      if (cleanPath === '/login') {
        console.log('Login route detected')
        return { view: 'login' as const, postId: null, username: null, tag: null }
      }
      
      if (cleanPath === '/register') {
        console.log('Register route detected')
        return { view: 'register' as const, postId: null, username: null, tag: null }
      }

      // Legal pages (public)
      if (cleanPath === '/terms') {
        console.log('Terms route detected')
        return { view: 'terms' as const, postId: null, username: null, tag: null }
      }

      if (cleanPath === '/privacy') {
        console.log('Privacy route detected')
        return { view: 'privacy' as const, postId: null, username: null, tag: null }
      }

      if (cleanPath === '/about') {
        console.log('About route detected')
        return { view: 'about' as const, postId: null, username: null, tag: null }
      }

      if (cleanPath === '/whitepaper') {
        console.log('Whitepaper route detected')
        return { view: 'whitepaper' as const, postId: null, username: null, tag: null }
      }
      
      // Explore route - public, no auth required
      const exploreMatch = cleanPath.match(/^\/explore$/)
      if (exploreMatch) {
        const urlParams = new URLSearchParams(window.location.search)
        const tag = urlParams.get('tag')
        console.log('Explore route detected, tag:', tag)
        return { view: 'explore' as const, postId: null, username: null, tag }
      }

      // Arcade game route - public, no auth required
      const arcadeGameMatch = cleanPath.match(/^\/arcade\/([^\/]+)$/)
      if (arcadeGameMatch) {
        console.log('Arcade game route detected, gameId:', arcadeGameMatch[1])
        return { view: 'arcade' as const, postId: arcadeGameMatch[1], username: null, tag: null }
      }
      
      // Arcade route - public, no auth required
      if (cleanPath === '/arcade') {
        console.log('Arcade route detected')
        return { view: 'arcade' as const, postId: null, username: null, tag: null }
      }
      
      // Thread route (check before profile) - public, no auth required
      const threadMatch = cleanPath.match(/^\/thread\/([^\/]+)$/)
      if (threadMatch) {
        console.log('Thread route detected, postId:', threadMatch[1])
        return { view: 'thread' as const, postId: threadMatch[1], username: null, tag: null }
      }
      
      // Profile routes - matches both /users/:username and /profile/:username
      const usersProfileMatch = cleanPath.match(/^\/users\/([^\/]+)$/)
      const profileMatch = cleanPath.match(/^\/profile\/([^\/]+)$/)
      console.log('Profile match test:', { usersProfileMatch, profileMatch }, 'cleanPath:', cleanPath)
      
      if (usersProfileMatch && usersProfileMatch[1]) {
        console.log('Users profile route detected, username:', usersProfileMatch[1])
        return { view: 'profile' as const, postId: null, username: usersProfileMatch[1], tag: null }
      }
      
      if (profileMatch && profileMatch[1]) {
        console.log('Profile route detected, username:', profileMatch[1])
        return { view: 'profile' as const, postId: null, username: profileMatch[1], tag: null }
      }
      
      // Notifications route - requires auth
      if (cleanPath === '/notifications') {
        console.log('Notifications route detected')
        return { view: 'notifications' as const, postId: null, username: null, tag: null }
      }

      // Settings route - requires auth
      if (cleanPath === '/settings') {
        console.log('Settings route detected')
        return { view: 'settings' as const, postId: null, username: null, tag: null }
      }

      // Sandbox route - public, no auth required
      const sandboxMatch = cleanPath.match(/^\/sandbox\/post\/([^\/]+)$/)
      if (sandboxMatch) {
        console.log('Sandbox route detected, postId:', sandboxMatch[1])
        // For sandbox, don't initialize the app - let the sandbox page handle itself
        console.log('Sandbox page detected, skipping app initialization')
        return null
      }

      // Admin route - requires auth
      const adminMatch = cleanPath.match(/^\/admin(\/alerts|\/hidden|\/users)?$/)
      if (adminMatch) {
        console.log('Admin route detected')
        const tab = adminMatch[1] ? adminMatch[1].replace('/', '') as 'alerts' | 'hidden' | 'users' : 'alerts'
        return { view: 'admin' as const, postId: null, username: null, tag: null, adminTab: tab }
      }

      // Home route - public, no auth required  
      if (cleanPath === '/home') {
        console.log('Home route detected')
        return { view: 'timeline' as const, postId: null, username: null, tag: null }
      }

      // Default timeline (only for root path) - public, no auth required
      if (cleanPath === '' || cleanPath === '/') {
        console.log('Timeline route detected')
        return { view: 'timeline' as const, postId: null, username: null, tag: null }
      }
      
      // If no route matched, default to timeline
      console.log('Unknown route, defaulting to timeline')
      return { view: 'timeline' as const, postId: null, username: null, tag: null }
    }
    
    // Navigate to view
    const navigateTo = async (view: 'timeline' | 'thread' | 'login' | 'register' | 'profile' | 'explore' | 'notifications' | 'terms' | 'privacy' | 'about' | 'whitepaper' | 'admin' | 'settings' | 'arcade', postId?: string, username?: string, tag?: string, adminTab?: 'alerts' | 'hidden' | 'users') => {
      console.log('Navigate to:', view, postId, username, tag, 'Current view:', currentView, 'adminTab:', adminTab)
      
      // Always check auth state on navigation to ensure session is up-to-date
      // This will trigger session extension via /api/me call
      await checkAuth()
      
      // For auth routes, proceed directly
      if (view === 'login' || view === 'register') {
        // Cleanup current view
        if (timeline) {
          console.log('Cleaning up timeline')
          timeline.destroy()
          timeline = null
        }
        if (threadPage) {
          console.log('Cleaning up thread page')
          threadPage.destroy()
          threadPage = null
        }
        if (loginPage) {
          loginPage.destroy()
          loginPage = null
        }
        if (registerPage) {
          registerPage.destroy()
          registerPage = null
        }
        if (profilePage) {
          profilePage.destroy()
          profilePage = null
        }
        if (notificationsPage) {
          notificationsPage.destroy()
          notificationsPage = null
        }
        if (settingsPage) {
          settingsPage.destroy()
          settingsPage = null
        }
        if (arcadePage) {
          arcadePage.destroy()
          arcadePage = null
        }
      } else {
        // Auth guard for protected routes
        const isAuthenticated = await requireAuth()
        if (!isAuthenticated) {
          return // Auth guard will redirect to login
        }
        
        // Cleanup current view
        if (timeline) {
          console.log('Cleaning up timeline')
          timeline.destroy()
          timeline = null
        }
        if (threadPage) {
          console.log('Cleaning up thread page')
          threadPage.destroy()
          threadPage = null
        }
        if (loginPage) {
          loginPage.destroy()
          loginPage = null
        }
        if (registerPage) {
          registerPage.destroy()
          registerPage = null
        }
        if (profilePage) {
          profilePage.destroy()
          profilePage = null
        }
        if (notificationsPage) {
          notificationsPage.destroy()
          notificationsPage = null
        }
        if (settingsPage) {
          settingsPage.destroy()
          settingsPage = null
        }
        if (arcadePage) {
          arcadePage.destroy()
          arcadePage = null
        }
      }
      
      // Clear app content
      app.innerHTML = ''
      
      // Handle auth pages (full screen)
      if (view === 'login') {
        currentView = 'login'
        currentPostId = null
        currentUsername = null
        
        loginPage = createLoginPage({
          onSuccess: () => {
            window.history.pushState({}, '', '/arcade')
            navigateTo('arcade')
          }
        })
        
        app.appendChild(loginPage.getElement())
        return
      }
      
      if (view === 'register') {
        currentView = 'register'
        currentPostId = null
        currentUsername = null
        
        registerPage = createRegisterPage({
          onSuccess: () => {
            window.history.pushState({}, '', '/arcade')
            navigateTo('arcade')
          }
        })
        
        app.appendChild(registerPage.getElement())
        return
      }

      // Handle legal pages (public, no auth required, no layout)
      if (view === 'terms' || view === 'privacy' || view === 'about' || view === 'whitepaper') {
        currentView = view
        currentPostId = null
        currentUsername = null
        
        legalPage = createLegalPage({
          type: view
        })
        
        app.appendChild(legalPage.getElement())
        return
      }

      // Handle admin page (separate layout, no Left Nav)
      if (view === 'admin') {
        currentView = 'admin'
        currentAdminTab = adminTab || 'alerts'

        // Cleanup regular views
        if (timeline) {
          timeline.destroy()
          timeline = null
        }
        if (threadPage) {
          threadPage.destroy()
          threadPage = null
        }
        if (profilePage) {
          profilePage.destroy()
          profilePage = null
        }
        if (explorePage) {
          explorePage.destroy()
          explorePage = null
        }
        if (notificationsPage) {
          notificationsPage.destroy()
          notificationsPage = null
        }
        if (settingsPage) {
          settingsPage.destroy()
          settingsPage = null
        }

        const onTabChange = async (tab: 'alerts' | 'hidden' | 'users' | 'ads') => {
          currentAdminTab = tab
          window.history.pushState({}, '', `/admin/${tab}`)
          renderAdminTab(tab)
        }

        adminLayout = createAdminLayout({
          activeTab: currentAdminTab,
          onTabChange
        })

        app.appendChild(adminLayout.getElement())

        const renderAdminTab = async (tab: 'alerts' | 'hidden' | 'users' | 'ads') => {
          if (!adminLayout) return

          if (tab === 'alerts') {
            adminAlertsTab = createAdminAlertsTab({
              onNavigateToTab: onTabChange
            })
            const alertsElement = adminAlertsTab.getElement()
            if (alertsElement) {
              adminLayout.updateMainContent(alertsElement)
            }

            // Check for access denied
            try {
              const response = await fetch('/api/admin/alerts', { credentials: 'include' })
              if (response.status === 403) {
                adminLayout.setAccessDenied()
              }
            } catch (e) {
              console.error('Failed to check admin access:', e)
            }
          } else if (tab === 'hidden') {
            adminHiddenTab = createAdminHiddenTab({
              onNavigateToTab: onTabChange
            })
            const hiddenElement = adminHiddenTab.getElement()
            if (hiddenElement) {
              adminLayout.updateMainContent(hiddenElement)
            }
          } else if (tab === 'users') {
            adminUsersTab = createAdminUsersTab({
              onNavigateToTab: onTabChange
            })
            const usersElement = adminUsersTab.getElement()
            if (usersElement) {
              adminLayout.updateMainContent(usersElement)
            }
          } else if (tab === 'ads') {
            adminAdsTab = createAdminAdsTab({
              onNavigateToTab: onTabChange
            })
            const adsElement = adminAdsTab.getElement()
            if (adsElement) {
              adminLayout.updateMainContent(adsElement)
            }
          }
        }

        // Render initial tab
        renderAdminTab(currentAdminTab)
        return
      }

      // Handle explore page (within 3-column layout)
      if (view === 'explore') {
        currentView = 'explore'
        currentPostId = null
        currentUsername = null
        currentTag = tag || null
        
        // Create main container for 3-column layout
        const mainContainer = document.createElement('div')
        mainContainer.className = 'main-container'
        
        // Create Left Nav
        const leftNav = createLeftNav({
          activeItem: 'explore',
          unreadCount: unreadNotificationCount,
          currentUser: currentUser || undefined,
          onNavigate: async (item) => {
            console.log('Navigate to:', item)
            if (item === 'home') {
              window.history.pushState({}, '', '/home')
              navigateTo('timeline')
            } else if (item === 'explore') {
              window.history.pushState({}, '', '/explore')
              navigateTo('explore')
            } else if (item === 'arcade') {
              window.history.pushState({}, '', '/arcade')
              navigateTo('arcade')
            } else if (item === 'notifications') {
              window.history.pushState({}, '', '/notifications')
              navigateTo('notifications')
            } else if (item === 'settings') {
              window.history.pushState({}, '', '/settings')
              navigateTo('settings')
            } else if (item === 'profile') {
              if (!currentUser) {
                window.history.pushState({}, '', '/arcade')
                navigateTo('arcade')
                return
              }
              window.history.pushState({}, '', `/profile/${currentUser.username}`)
              navigateTo('profile', undefined, currentUser.username)
            }
          },
          onSignIn: () => {
            window.history.pushState({}, '', '/login')
            navigateTo('login')
          },
          onSignUp: () => {
            window.history.pushState({}, '', '/register')
            navigateTo('register')
          }
        })
        
        leftNavInstances.add(leftNav)
        
        // Create Explore Page (as main content)
        const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app'
        explorePage = createExplorePage({
          tag: currentTag || undefined,
          sandboxOrigin
        })
        
        // Create Right Panel
        const rightPanel = createRightPanel({
          onSearch: (query) => {
            console.log('Search:', query)
            // Handle search here
          },
          onFollowUser: (userId) => {
            console.log('Follow user:', userId)
            // Handle follow here
          }
        })
        
        // Assemble layout
        mainContainer.appendChild(leftNav.getElement())
        mainContainer.appendChild(explorePage.getElement())
        mainContainer.appendChild(rightPanel.getElement())
        
        app.appendChild(mainContainer)
        
        // Setup mobile left nav
        setupMobileLeftNav(leftNav.getElement())
        
        return
      }

      // Handle arcade page (within 3-column layout)
      if (view === 'arcade') {
        currentView = 'arcade'
        currentPostId = postId || null
        currentUsername = null
        currentTag = null
        
        // Create main container for 3-column layout
        const mainContainer = document.createElement('div')
        mainContainer.className = 'main-container'
        
        // Create Left Nav
        const leftNav = createLeftNav({
          activeItem: 'arcade',
          unreadCount: unreadNotificationCount,
          currentUser: currentUser || undefined,
          onNavigate: async (item) => {
            console.log('Navigate to:', item)
            if (item === 'home') {
              window.history.pushState({}, '', '/home')
              navigateTo('timeline')
            } else if (item === 'explore') {
              window.history.pushState({}, '', '/explore')
              navigateTo('explore')
            } else if (item === 'arcade') {
              window.history.pushState({}, '', '/arcade')
              navigateTo('arcade')
            } else if (item === 'notifications') {
              window.history.pushState({}, '', '/notifications')
              navigateTo('notifications')
            } else if (item === 'settings') {
              window.history.pushState({}, '', '/settings')
              navigateTo('settings')
            } else if (item === 'profile') {
              if (!currentUser) {
                window.history.pushState({}, '', '/arcade')
                navigateTo('arcade')
                return
              }
              window.history.pushState({}, '', `/profile/${currentUser.username}`)
              navigateTo('profile', undefined, currentUser.username)
            }
          },
          onSignIn: () => {
            window.history.pushState({}, '', '/login')
            navigateTo('login')
          },
          onSignUp: () => {
            window.history.pushState({}, '', '/register')
            navigateTo('register')
          }
        })
        
        leftNavInstances.add(leftNav)
        
        // Create Arcade Page (as main content)
        const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app'
        arcadePage = createArcadePage({
          sandboxOrigin,
          currentUser,
          initialGameId: currentPostId || undefined
        })
        
        // Create Right Panel
        const rightPanel = createRightPanel({
          onSearch: (query) => {
            console.log('Search:', query)
            // Handle search here
          },
          onFollowUser: (userId) => {
            console.log('Follow user:', userId)
            // Handle follow here
          }
        })
        
        // Assemble layout
        mainContainer.appendChild(leftNav.getElement())
        mainContainer.appendChild(arcadePage.getElement())
        mainContainer.appendChild(rightPanel.getElement())
        
        app.appendChild(mainContainer)
        
        // Setup mobile left nav
        setupMobileLeftNav(leftNav.getElement())
        
        return
      }
      
      // Handle profile page (within 3-column layout)
      if (view === 'profile' && username) {
        currentView = 'profile'
        currentPostId = null
        currentUsername = username
        currentTag = null
        
        // Create main container for 3-column layout
        const mainContainer = document.createElement('div')
        mainContainer.className = 'main-container'
        
        // Create Left Nav
        const leftNav = createLeftNav({
          activeItem: 'profile',
          unreadCount: unreadNotificationCount,
          currentUser: currentUser || undefined,
          onNavigate: async (item) => {
            console.log('Navigate to:', item)
            if (item === 'home') {
              window.history.pushState({}, '', '/home')
              navigateTo('timeline')
            } else if (item === 'explore') {
              window.history.pushState({}, '', '/explore')
              navigateTo('explore')
            } else if (item === 'arcade') {
              window.history.pushState({}, '', '/arcade')
              navigateTo('arcade')
            } else if (item === 'notifications') {
              window.history.pushState({}, '', '/notifications')
              navigateTo('notifications')
            } else if (item === 'settings') {
              window.history.pushState({}, '', '/settings')
              navigateTo('settings')
            } else if (item === 'profile') {
              if (!currentUser) {
                window.history.pushState({}, '', '/arcade')
                navigateTo('arcade')
                return
              }
              window.history.pushState({}, '', `/profile/${currentUser.username}`)
              navigateTo('profile', undefined, currentUser.username)
            }
          },
          onSignIn: () => {
            window.history.pushState({}, '', '/login')
            navigateTo('login')
          },
          onSignUp: () => {
            window.history.pushState({}, '', '/register')
            navigateTo('register')
          }
        })
        
        leftNavInstances.add(leftNav)
        
        // Create Profile Page (as main content)
        const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app'
        profilePage = createProfilePage({
          username,
          currentUser,
          sandboxOrigin
        })
        
        // Create Right Panel
        const rightPanel = createRightPanel({
          onSearch: (query) => {
            console.log('Search:', query)
            // Handle search here
          },
          onFollowUser: (userId) => {
            console.log('Follow user:', userId)
            // Handle follow here
          }
        })
        
        // Assemble layout
        mainContainer.appendChild(leftNav.getElement())
        mainContainer.appendChild(profilePage.getElement())
        mainContainer.appendChild(rightPanel.getElement())
        
        app.appendChild(mainContainer)
        
        // Setup mobile left nav
        setupMobileLeftNav(leftNav.getElement())
        
        return
      }
      
      // Handle notifications page (within 3-column layout)
      if (view === 'notifications') {
        currentView = 'notifications'
        currentPostId = null
        currentUsername = null
        currentTag = null
        
        // Fetch notifications and user data in parallel
        const [notificationsData] = await Promise.all([
          fetchNotifications()
        ])
        
        // Create main container for 3-column layout
        const mainContainer = document.createElement('div')
        mainContainer.className = 'main-container'
        
        // Create Left Nav with unread count
        const leftNav = createLeftNav({
          activeItem: 'notifications',
          unreadCount: unreadNotificationCount,
          currentUser: currentUser || undefined,
          onNavigate: async (item) => {
            console.log('Navigate to:', item)
            if (item === 'home') {
              window.history.pushState({}, '', '/home')
              navigateTo('timeline')
            } else if (item === 'explore') {
              window.history.pushState({}, '', '/explore')
              navigateTo('explore')
            } else if (item === 'arcade') {
              window.history.pushState({}, '', '/arcade')
              navigateTo('arcade')
            } else if (item === 'notifications') {
              window.history.pushState({}, '', '/notifications')
              navigateTo('notifications')
            } else if (item === 'settings') {
              window.history.pushState({}, '', '/settings')
              navigateTo('settings')
            } else if (item === 'profile') {
              if (!currentUser) {
                window.history.pushState({}, '', '/arcade')
                navigateTo('arcade')
                return
              }
              window.history.pushState({}, '', `/profile/${currentUser.username}`)
              navigateTo('profile', undefined, currentUser.username)
            }
          },
          onSignIn: () => {
            window.history.pushState({}, '', '/login')
            navigateTo('login')
          },
          onSignUp: () => {
            window.history.pushState({}, '', '/register')
            navigateTo('register')
          }
        })
        
        leftNavInstances.add(leftNav)
        
        // Create Notifications Page
        notificationsPage = createNotificationsPage({
          notifications: notificationsData.notifications,
          unreadCount: notificationsData.unread_count,
          onMarkAllRead: async () => {
            await fetch('/api/notifications/read-all', {
              method: 'POST',
              credentials: 'include'
            })
            unreadNotificationCount = 0
            leftNav.setUnreadCount(0)
          },
          onNavigateToPost: (postId) => {
            window.history.pushState({}, '', `/thread/${postId}`)
            navigateTo('thread', postId)
          }
        })
        
        // Create Right Panel
        const rightPanel = createRightPanel({
          onSearch: (query) => {
            console.log('Search:', query)
          },
          onFollowUser: (userId) => {
            console.log('Follow user:', userId)
          }
        })
        
        // Assemble layout
        mainContainer.appendChild(leftNav.getElement())
        mainContainer.appendChild(notificationsPage.getElement())
        mainContainer.appendChild(rightPanel.getElement())
        
        app.appendChild(mainContainer)
        
        // Setup mobile left nav
        setupMobileLeftNav(leftNav.getElement())
        
        return
      }
      
      // Handle settings page (within 3-column layout)
      if (view === 'settings') {
        currentView = 'settings'
        currentPostId = null
        currentUsername = null
        currentTag = null
        
        // Create main container for 3-column layout
        const mainContainer = document.createElement('div')
        mainContainer.className = 'main-container'
        
        // Create Left Nav
        const leftNav = createLeftNav({
          activeItem: 'settings',
          unreadCount: unreadNotificationCount,
          currentUser: currentUser || undefined,
          onNavigate: async (item) => {
            console.log('Navigate to:', item)
            if (item === 'home') {
              window.history.pushState({}, '', '/home')
              navigateTo('timeline')
            } else if (item === 'explore') {
              window.history.pushState({}, '', '/explore')
              navigateTo('explore')
            } else if (item === 'arcade') {
              window.history.pushState({}, '', '/arcade')
              navigateTo('arcade')
            } else if (item === 'notifications') {
              window.history.pushState({}, '', '/notifications')
              navigateTo('notifications')
            } else if (item === 'settings') {
              window.history.pushState({}, '', '/settings')
              navigateTo('settings')
            } else if (item === 'profile') {
              if (!currentUser) {
                window.history.pushState({}, '', '/arcade')
                navigateTo('arcade')
                return
              }
              window.history.pushState({}, '', `/profile/${currentUser.username}`)
              navigateTo('profile', undefined, currentUser.username)
            }
          },
          onSignIn: () => {
            window.history.pushState({}, '', '/login')
            navigateTo('login')
          },
          onSignUp: () => {
            window.history.pushState({}, '', '/register')
            navigateTo('register')
          }
        })
        
        leftNavInstances.add(leftNav)
        
        // Create Settings Page (as main content)
        settingsPage = createSettingsPage({
          currentUser: currentUser || undefined
        })
        
        // Load user data asynchronously
        const loadUserData = async () => {
          try {
            const userData = await getMe()
            if (userData) {
              // Recreate settings page with full user data
              const oldElement = settingsPage.getElement()
              settingsPage.destroy()
              settingsPage = createSettingsPage({
                currentUser: userData.user
              })
              
              // Wait for the next tick to ensure the element is in the DOM
              setTimeout(() => {
                if (oldElement.parentNode) {
                  oldElement.parentNode.replaceChild(settingsPage.getElement(), oldElement)
                } else {
                  // If still not in DOM, add it to the main container in the correct position
                  const leftNavElement = mainContainer.children[0]
                  if (leftNavElement && mainContainer.children[1]) {
                    mainContainer.insertBefore(settingsPage.getElement(), mainContainer.children[1])
                  }
                }
              }, 0)
            }
          } catch (error) {
            console.error('Failed to load user data:', error)
          }
        }
        
        loadUserData()
        
        // Create Right Panel
        const rightPanel = createRightPanel({
          onSearch: (query) => {
            console.log('Search:', query)
          },
          onFollowUser: (userId) => {
            console.log('Follow user:', userId)
          }
        })
        
        // Assemble layout
        mainContainer.appendChild(leftNav.getElement())
        mainContainer.appendChild(settingsPage.getElement())
        mainContainer.appendChild(rightPanel.getElement())
        
        app.appendChild(mainContainer)
        
        // Setup mobile left nav
        setupMobileLeftNav(leftNav.getElement())
        
        return
      }
      
      // Create main container for timeline/thread views
      const mainContainer = document.createElement('div')
      mainContainer.className = 'main-container'
      
      if (view === 'thread' && postId) {
        // Thread page view
        console.log('Creating thread page for postId:', postId)
        currentView = 'thread'
        currentPostId = postId
        
        const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app'
        threadPage = createThreadPage({
          postId,
          sandboxOrigin,
          currentUser,
          onBack: () => {
            console.log('Back button clicked, navigating to home')
            window.history.pushState({}, '', '/home')
            navigateTo('timeline')
          }
        })
        
        console.log('Thread page created, adding to container')
        mainContainer.appendChild(threadPage.getElement())
        console.log('Thread page added to DOM')
        
        // ThreadPage has its own LeftNav, find it and setup mobile functionality
        const threadLeftNav = threadPage.getElement().querySelector('.left-nav') as HTMLElement
        if (threadLeftNav) {
          // Add thread page specific class for styling
          threadLeftNav.classList.add('thread-page-left-nav')
          setupMobileLeftNav(threadLeftNav)
        }
      } else {
        // Timeline view
        currentView = 'timeline'
        currentPostId = null
        
        // Create Left Nav
        const leftNav = createLeftNav({
          activeItem: 'home',
          unreadCount: unreadNotificationCount,
          currentUser: currentUser || undefined,
          onNavigate: async (item) => {
            console.log('Navigate to:', item)
            if (item === 'home') {
              window.history.pushState({}, '', '/home')
              navigateTo('timeline')
            } else if (item === 'explore') {
              window.history.pushState({}, '', '/explore')
              navigateTo('explore')
            } else if (item === 'arcade') {
              window.history.pushState({}, '', '/arcade')
              navigateTo('arcade')
            } else if (item === 'notifications') {
              window.history.pushState({}, '', '/notifications')
              navigateTo('notifications')
            } else if (item === 'settings') {
              window.history.pushState({}, '', '/settings')
              navigateTo('settings')
            } else if (item === 'profile') {
              if (!currentUser) {
                window.history.pushState({}, '', '/arcade')
                navigateTo('arcade')
                return
              }
              window.history.pushState({}, '', `/profile/${currentUser.username}`)
              navigateTo('profile', undefined, currentUser.username)
            }
          },
          onSignIn: () => {
            window.history.pushState({}, '', '/login')
            navigateTo('login')
          },
          onSignUp: () => {
            window.history.pushState({}, '', '/register')
            navigateTo('register')
          }
        })
        
        leftNavInstances.add(leftNav)
        
        // Create Timeline
        const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app'
        timeline = createTimeline({
          sandboxOrigin,
          currentUser
        })
        
        // Listen for navigation events from timeline
        timeline.getElement().addEventListener('navigateToThread', (e: any) => {
          const postId = e.detail.postId
          window.history.pushState({ postId }, '', `/thread/${postId}`)
          navigateTo('thread', postId)
        })

        // Listen for openLeftNav events from timeline (mobile swipe)
        timeline.getElement().addEventListener('openLeftNav', () => {
          const leftNavElement = document.querySelector('.left-nav') as HTMLElement
          if (leftNavElement) {
            openLeftNav(leftNavElement)
          }
        })
        
        // Setup mobile left nav functionality
        setupMobileLeftNav(leftNav.getElement())
        
        // Create Right Panel
        const rightPanel = createRightPanel({
          onSearch: (query) => {
            console.log('Search:', query)
            // Handle search here
          },
          onFollowUser: (userId) => {
            console.log('Follow user:', userId)
            // Handle follow here
          }
        })
        
        // Assemble layout
        mainContainer.appendChild(leftNav.getElement())
        mainContainer.appendChild(timeline.getElement())
        mainContainer.appendChild(rightPanel.getElement())
      }
      
      app.appendChild(mainContainer)
    }
    
    // Handle browser back/forward
    window.addEventListener('popstate', async (e) => {
      const route = parseCurrentRoute()
      if (route) {
        await navigateTo(route.view, route.postId || undefined, route.username || undefined, route.tag || undefined, route.adminTab || undefined)
      }
    })
    
    // Handle SPA navigation events
    window.addEventListener('spaNavigate', async (e: any) => {
      const detail = e.detail
      await navigateTo(detail.view, detail.postId, detail.username, detail.tag, detail.adminTab)
    })
    
    // Initial navigation
    console.log('DOM Content Loaded, starting initial routing...')
    
    // Fetch notifications and check auth in parallel on app init
    await Promise.all([
      fetchNotifications(),
      checkAuth()
    ])
    
    const initialRoute = parseCurrentRoute()
    console.log('Initial route:', initialRoute)
    if (initialRoute) {
      await navigateTo(initialRoute.view, initialRoute.postId || undefined, initialRoute.username || undefined, initialRoute.tag || undefined, initialRoute.adminTab || undefined)
    }
  }
})
