import { createLeftNav, updateLeftNavUser } from './components/LeftNav.js'
import { createRightPanel } from './components/RightPanel.js'
import { getMe } from './lib/auth-cache.js'
import { initPerformanceMonitoring } from './lib/performance.js'
import { initI18n } from './lib/i18n.js'

console.log('Flaxia initialized')

// Initialize performance monitoring
initPerformanceMonitoring()

// Basic app initialization
document.addEventListener('DOMContentLoaded', async () => {
  const app = document.getElementById('app')
  if (app) {
    console.log('App mounted')

    // Top bar: Capacitor/Tauri mobile (production) or localhost dev (browser testing)
    const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    const isTauri = typeof window !== 'undefined' && ((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__)
    const isCapacitor = typeof window !== 'undefined' && typeof (window as any).Capacitor !== 'undefined' && typeof (window as any).Capacitor.isNativePlatform === 'function' && (window as any).Capacitor.isNativePlatform()
    const isTauriMobile = isTauri && /Android/i.test(navigator.userAgent)
    const isCapacitorMobile = isCapacitor && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    const isMobile = isTauriMobile || isCapacitorMobile
    if (isMobile || isLocalhost) {
      document.documentElement.classList.add('tauri-android')
      const topbar = document.getElementById('flaxia-topbar')
      if (topbar) topbar.hidden = false
    }

    history.scrollRestoration = 'manual'
    
    await initI18n()
    
    // Routing state
    let currentView: 'timeline' | 'thread' | 'login' | 'register' | 'profile' | 'explore' | 'search' | 'notifications' | 'bookmarks' | 'terms' | 'privacy' | 'about' | 'whitepaper' | 'admin' | 'settings' | 'arcade' = 'timeline'
    let currentPostId: string | null = null
    let currentUsername: string | null = null
    let currentTag: string | null = null
    let currentAdminTab: 'alerts' | 'hidden' | 'users' | 'ads' = 'alerts'
    let timeline: any = null
    let threadPage: any = null
    let savedScrollY = 0
    let loginPage: any = null
    let registerPage: any = null
    let profilePage: any = null
    let explorePage: any = null
    let legalPage: any = null
    let notificationsPage: any = null
    let settingsPage: any = null
    let arcadePage: any = null
    let searchPage: any = null
    let bookmarksPage: any = null
    let adminLayout: any = null
    let adminAlertsTab: any = null
    let adminHiddenTab: any = null
    let adminUsersTab: any = null
    let adminAdsTab: any = null
    let leftNavInstances: Set<any> = new Set()
    let currentUser: { username: string; id: string; display_name?: string; avatar_key?: string } | null = null
let unreadNotificationCount = 0
let previousUnreadCount = 0
let notificationPollInterval: ReturnType<typeof setInterval> | null = null
let cachedContentComponent: { view: string; component: any; scrollY: number } | null = null

let tauriNotify: ((title: string, body: string) => Promise<void>) | null = null
let tauriBadge: ((count: number) => Promise<void>) | null = null
let tauriSetNotificationCount: ((count: number) => Promise<void>) | null = null
let capacitorNotify: ((title: string, body: string) => Promise<void>) | null = null
let capacitorBadge: ((count: number) => Promise<void>) | null = null

const initTauriNotifications = async () => {
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification')

    // Try to grant permission, but don't gate on it — on Windows/Linux the
    // permission model doesn't apply (notifications always work), and on macOS
    // the OS will prompt or silently drop the notification if denied.
    try {
      const granted = await isPermissionGranted()
      if (!granted) {
        await requestPermission()
      }
    } catch {
      // permission API not supported on this platform — proceed anyway
    }

    tauriNotify = async (title: string, body: string) => {
      try {
        await sendNotification({ title, body: body || title })
      } catch (err) {
        console.error('[notif] sendNotification failed:', err)
      }
    }
    // Badge always works even without notification permission
    tauriBadge = async (count: number) => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        await getCurrentWindow().setBadgeCount(count)
      } catch {
        // badge not supported on this platform
      }
    }
    // Desktop tray icon badge: store count so Rust bg thread updates the icon
    if (!/Android/i.test(navigator.userAgent)) {
      tauriSetNotificationCount = async (count: number) => {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          console.log('[notif] invoking set_notification_count with', count)
          await invoke('set_notification_count', { count })
          console.log('[notif] invoke succeeded')
        } catch (err) {
          console.log('[notif] invoke error:', err)
        }
      }
    }
  } catch {
      // Not running in Tauri
    }
  }

const initCapacitorNotifications = async () => {
  try {
    const isNative = typeof window !== 'undefined' && typeof (window as any).Capacitor !== 'undefined' && typeof (window as any).Capacitor.isNativePlatform === 'function' && (window as any).Capacitor.isNativePlatform()
    if (!isNative) return

    const { LocalNotifications } = await import('@capacitor/local-notifications')
    const { Badge } = await import('@capawesome/capacitor-badge')

    await LocalNotifications.requestPermissions()

    capacitorNotify = async (title: string, body: string) => {
      try {
        await LocalNotifications.schedule({
          notifications: [{ title, body, id: Date.now() }],
        })
      } catch (err) {
        console.error('[notif] Capacitor sendNotification failed:', err)
      }
    }

    capacitorBadge = async (count: number) => {
      try {
        await Badge.set({ count })
      } catch {
        // badge not supported
      }
    }
  } catch {
    // Not running in Capacitor
  }
}

/** Register Web Push in browser (Service Worker), or skip in Tauri/Capacitor. */
/** Convert VAPID base64 key to Uint8Array for PushManager.subscribe(). */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - base64.length % 4) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

/** Register for Web Push via Service Worker (browser only). */
const registerPushToken = async () => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return // not supported (Tauri or old browser)
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready

    // Get VAPID public key from server
    const keyRes = await fetch('/api/push/vapid-key')
    if (!keyRes.ok) return
    const { publicKey } = await keyRes.json()

    // Subscribe
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })

    await fetch('/api/push/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(sub.toJSON()),
    })
    console.log('Web Push subscription registered')
  } catch (err) {
    console.log('Web Push registration not available:', err)
  }
}

const initializeWebPush = async () => {
  if (typeof window !== 'undefined' && ((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__)) {
    return // Tauri desktop/mobile — no Service Worker push needed
  }
  if (typeof window !== 'undefined' && typeof (window as any).Capacitor !== 'undefined' && typeof (window as any).Capacitor.isNativePlatform === 'function' && (window as any).Capacitor.isNativePlatform()) {
    return // Capacitor mobile — no Service Worker push needed
  }
  await registerPushToken()
}

// Initialize Tauri native notifications (badge / local notif, no-op in browser)
await initTauriNotifications()
// Initialize Capacitor native notifications (mobile only)
await initCapacitorNotifications()
// Register Service Worker for Web Push (browser only, no-op in Tauri/Capacitor)
initializeWebPush()

const refreshNotificationBadges = async () => {
  const data = await fetchNotifications()
  leftNavInstances.forEach((leftNav: any) => {
    if (typeof leftNav.setUnreadCount === 'function') {
      leftNav.setUnreadCount(unreadNotificationCount)
    }
  })

  // Update badge count (Tauri desktop or Capacitor mobile)
  if (capacitorBadge) {
    capacitorBadge(unreadNotificationCount)
  } else if (tauriBadge) {
    tauriBadge(unreadNotificationCount)
  }

    // Update notification count for desktop tray icon badge (Rust bg thread checks this)
  if (tauriSetNotificationCount) {
    console.log('[notif] calling set_notification_count with', unreadNotificationCount)
    tauriSetNotificationCount(unreadNotificationCount).catch(err => {
      console.log('[notif] set_notification_count failed:', err)
    })
  } else {
    console.log('[notif] tauriSetNotificationCount is null (not in Tauri desktop)')
  }

  // Show notification when new unread notifications arrive
  const isRealTauriAndroid = typeof window !== 'undefined' && ((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__) && /Android/i.test(navigator.userAgent)
  const isCapacitorMobile = typeof window !== 'undefined' && typeof (window as any).Capacitor !== 'undefined' && typeof (window as any).Capacitor.isNativePlatform === 'function' && (window as any).Capacitor.isNativePlatform()
  if (tauriNotify && !isRealTauriAndroid && !isCapacitorMobile && unreadNotificationCount > previousUnreadCount && data?.notifications?.length) {
    const latest = data.notifications[0]
    let body = ''
    if (latest.actor) {
      body = `${latest.actor.display_name || latest.actor.username}: `
    }
    body += latest.post_text_preview || 'New notification'
    tauriNotify('Flaxia', body).catch(err => {
      console.error('[notif] tauriNotify failed:', err)
    })
  } else if (capacitorNotify && isCapacitorMobile && unreadNotificationCount > previousUnreadCount && data?.notifications?.length) {
    const latest = data.notifications[0]
    let body = ''
    if (latest.actor) {
      body = `${latest.actor.display_name || latest.actor.username}: `
    }
    body += latest.post_text_preview || 'New notification'
    capacitorNotify('Flaxia', body).catch(err => {
      console.error('[notif] capacitorNotify failed:', err)
    })
  }
  previousUnreadCount = unreadNotificationCount
}

// Expose for Rust desktop background polling (lib.rs background thread, Tauri desktop only)
const isCapacitorPlatform = typeof window !== 'undefined' && typeof (window as any).Capacitor !== 'undefined' && typeof (window as any).Capacitor.isNativePlatform === 'function' && (window as any).Capacitor.isNativePlatform()
const isTauriDesktop = typeof window !== 'undefined' && ((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__) && !/Android/i.test(navigator.userAgent) && !isCapacitorPlatform
if (isTauriDesktop) {
  ;(window as any).__tauriDesktopPoll = refreshNotificationBadges
}

    const startNotificationPolling = () => {
      if (notificationPollInterval) return
      notificationPollInterval = setInterval(refreshNotificationBadges, 30000)
    }

    const stopNotificationPolling = () => {
      if (notificationPollInterval) {
        clearInterval(notificationPollInterval)
        notificationPollInterval = null
      }
    }
    
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
          
          // Start background polling for unread notification count
          startNotificationPolling()
          
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
        stopNotificationPolling()
        window.history.replaceState({}, '', '/login')
        navigateTo('login')
        return false
      }
      
      return false
    }

    // Fetch notifications
    interface NotificationData {
      notifications: Array<{
        id: string
        type: 'reported' | 'fresh' | 'warned' | 'hidden' | 'ap_follow' | 'ap_like' | 'ap_announce' | 'reply' | 'mention' | 'poll_ended'
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

    let cachedNotifications: NotificationData | null = null
    let lastNotificationFetch = 0
    const NOTIFICATION_FETCH_TTL = 10000 // 10秒以内の連続fetchはキャッシュ

    const fetchNotifications = async (): Promise<NotificationData> => {
      const now = Date.now()
      if (cachedNotifications && (now - lastNotificationFetch) < NOTIFICATION_FETCH_TTL) {
        return cachedNotifications
      }
      try {
        const response = await fetch('/api/notifications', { credentials: 'include' })
        if (response.ok) {
          const data = await response.json() as NotificationData
          unreadNotificationCount = data.unread_count || 0
          cachedNotifications = data
          lastNotificationFetch = now
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

    let leftNavWasOpen = false

    const openLeftNav = (leftNavElement: HTMLElement): void => {
      if (window.innerWidth > 768) return

      leftNavWasOpen = true
      leftNavElement.classList.add('left-nav--open')

      if (!leftNavOverlay) {
        leftNavOverlay = createLeftNavOverlay()
      }
      leftNavOverlay.classList.add('left-nav-overlay--visible')

      // Prevent body scroll
      document.body.style.overflow = 'hidden'
    }

    const closeLeftNav = (): void => {
      if (!leftNavWasOpen) return
      leftNavWasOpen = false

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

    let currentResizeHandler: (() => void) | null = null
    let currentKeydownHandler: ((e: KeyboardEvent) => void) | null = null
    let currentModalChangeHandler: ((e: Event) => void) | null = null

    const setupMobileLeftNav = (leftNavElement: HTMLElement): void => {
      // Clean up existing button and event listeners
      if (leftNavOpenButton) {
        leftNavOpenButton.remove()
        leftNavOpenButton = null
      }
      if (currentResizeHandler) {
        window.removeEventListener('resize', currentResizeHandler)
        currentResizeHandler = null
      }
      if (currentKeydownHandler) {
        document.removeEventListener('keydown', currentKeydownHandler)
        currentKeydownHandler = null
      }
      if (currentModalChangeHandler) {
        window.removeEventListener('modalchange', currentModalChangeHandler)
        currentModalChangeHandler = null
      }

      // Always create the button (CSS shows/hides via media query)
      leftNavOpenButton = createLeftNavOpenButton(leftNavElement)

      // Listen for openLeftNav events from timeline
      document.addEventListener('openLeftNav', () => {
        openLeftNav(leftNavElement)
      })

      // Handle escape key to close
      currentKeydownHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && window.innerWidth <= 768) {
          closeLeftNav()
        }
      }
      document.addEventListener('keydown', currentKeydownHandler)

      // Handle window resize
      currentResizeHandler = () => {
        if (window.innerWidth > 768) {
          closeLeftNav()
        }
      }
      window.addEventListener('resize', currentResizeHandler)

      // Close mobile nav when modal opens
      currentModalChangeHandler = (e: Event) => {
        if (window.innerWidth > 768) return
        const { open } = (e as CustomEvent<{ open: boolean }>).detail
        closeLeftNav()
        if (leftNavOpenButton) {
          leftNavOpenButton.style.display = open ? 'none' : ''
        }
      }
      window.addEventListener('modalchange', currentModalChangeHandler)
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
      // - /profile/:username (profile pages - alias for /users/)
      // - /thread/:id (thread pages)
      // - /terms, /privacy, /about, /whitepaper (legal pages)
      // - /login, /register (auth pages)
      const isPublicRoute = 
        cleanPath === '' || 
        cleanPath === '/' ||
        cleanPath === '/home' ||
        cleanPath === '/explore' ||
        cleanPath === '/search' ||
        cleanPath === '/arcade' ||
        cleanPath === '/login' ||
        cleanPath === '/register' ||
        cleanPath === '/terms' ||
        cleanPath === '/privacy' ||
        cleanPath === '/about' ||
        cleanPath === '/whitepaper' ||
        cleanPath.startsWith('/users/') ||
        cleanPath.startsWith('/profile/') ||
        cleanPath.startsWith('/thread/')
      
      // Allow public routes for everyone
      if (isPublicRoute) {
        return true
      }
      
      // For /notifications, redirect to arcade if not authenticated
      if (cleanPath === '/notifications') {
        if (!isAuthenticated) {
          // Use replaceState so the browser back button doesn't return to the
          // protected route (which would just redirect again, causing an infinite loop)
          window.history.replaceState({}, '', '/arcade')
          navigateTo('arcade')
          return false
        }
        return true
      }
      
      // For all other protected routes, redirect to login if not authenticated
      if (!isAuthenticated) {
        // Use replaceState so the browser back button doesn't return to the
        // protected route (which would just redirect again, causing an infinite loop)
        window.history.replaceState({}, '', '/login')
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

      // Search route - public, no auth required
      if (cleanPath === '/search') {
        const urlParams = new URLSearchParams(window.location.search)
        const q = urlParams.get('q') || ''
        const type = urlParams.get('type') || 'posts'
        console.log('Search route detected, query:', q, 'type:', type)
        return { view: 'search' as const, postId: null, username: null, tag: null, searchQuery: q, searchType: type as 'posts' | 'users' | 'arcade' }
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

      // Bookmarks route - requires auth
      if (cleanPath === '/bookmarks') {
        console.log('Bookmarks route detected')
        return { view: 'bookmarks' as const, postId: null, username: null, tag: null }
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
    const navigateTo = async (view: 'timeline' | 'thread' | 'login' | 'register' | 'profile' | 'explore' | 'search' | 'notifications' | 'bookmarks' | 'terms' | 'privacy' | 'about' | 'whitepaper' | 'admin' | 'settings' | 'arcade', postId?: string, username?: string, tag?: string, adminTab?: 'alerts' | 'hidden' | 'users', searchQuery?: string, searchType?: 'posts' | 'users' | 'arcade') => {
      console.log('Navigate to:', view, postId, username, tag, 'Current view:', currentView, 'adminTab:', adminTab)

      // Close mobile nav if open
      closeLeftNav()

      // Always check auth state on navigation to ensure session is up-to-date
      // This will trigger session extension via /api/me call
      await checkAuth()

      // Refresh notification count for authenticated routes
      if (view !== 'login' && view !== 'register') {
        await fetchNotifications()
      }
      
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
        if (bookmarksPage) {
          bookmarksPage.destroy()
          bookmarksPage = null
        }
      } else {
        // Auth guard for protected routes
        const isAuthenticated = await requireAuth()
        if (!isAuthenticated) {
          return // Auth guard will redirect to login
        }
        
        // Cache current view when navigating to thread or arcade (for back navigation with preserved content)
        if ((view === 'thread' || view === 'arcade') && currentView !== view) {
          console.log(`Caching current view for back navigation to ${view}:`, currentView)
          if (currentView === 'timeline' && timeline) {
            cachedContentComponent = { view: 'timeline', component: timeline, scrollY: window.scrollY }
            timeline = null
          } else if (currentView === 'profile' && profilePage) {
            cachedContentComponent = { view: 'profile', component: profilePage, scrollY: window.scrollY }
            profilePage = null
          } else if (currentView === 'explore' && explorePage) {
            cachedContentComponent = { view: 'explore', component: explorePage, scrollY: window.scrollY }
            explorePage = null
          } else if (currentView === 'search' && searchPage) {
            cachedContentComponent = { view: 'search', component: searchPage, scrollY: window.scrollY }
            searchPage = null
          } else if (currentView === 'arcade' && arcadePage) {
            cachedContentComponent = { view: 'arcade', component: arcadePage, scrollY: window.scrollY }
            arcadePage = null
          } else if (currentView === 'bookmarks' && bookmarksPage) {
            cachedContentComponent = { view: 'bookmarks', component: bookmarksPage, scrollY: window.scrollY }
            bookmarksPage = null
          }
        }

        // Save scroll position when leaving timeline (for fresh timeline creation back navigation)
        if (currentView === 'timeline' && view !== 'timeline') {
          savedScrollY = window.scrollY
        } else if (view !== 'timeline') {
          savedScrollY = 0
        }

        // Cleanup current view (cached components already nulled above)
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
        if (bookmarksPage) {
          bookmarksPage.destroy()
          bookmarksPage = null
        }
        if (arcadePage) {
          arcadePage.destroy()
          arcadePage = null
        }
        if (searchPage) {
          searchPage.destroy()
          searchPage = null
        }
      }
      
      // Clear app content
      app.innerHTML = ''
      
      // Handle auth pages (full screen, no nav)
      if (view === 'login') {
        if (leftNavOpenButton) {
          leftNavOpenButton.remove()
          leftNavOpenButton = null
        }
        if (leftNavOverlay) {
          leftNavOverlay.remove()
          leftNavOverlay = null
        }
        currentView = 'login'
        currentPostId = null
        currentUsername = null
        
        const { createLoginPage } = await import('./components/LoginPage.js')
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
        if (leftNavOpenButton) {
          leftNavOpenButton.remove()
          leftNavOpenButton = null
        }
        if (leftNavOverlay) {
          leftNavOverlay.remove()
          leftNavOverlay = null
        }
        currentView = 'register'
        currentPostId = null
        currentUsername = null
        
        const { createRegisterPage } = await import('./components/RegisterPage.js')
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
        if (leftNavOpenButton) {
          leftNavOpenButton.remove()
          leftNavOpenButton = null
        }
        if (leftNavOverlay) {
          leftNavOverlay.remove()
          leftNavOverlay = null
        }
        currentView = view
        currentPostId = null
        currentUsername = null
        
        const { createLegalPage } = await import('./components/LegalPage.js')
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

        const adminModule = await import('./components/AdminLayout.js')
        const adminTabsModule = await Promise.all([
          import('./components/AdminAlertsTab.js'),
          import('./components/AdminHiddenTab.js'),
          import('./components/AdminUsersTab.js'),
          import('./components/AdminAdsTab.js'),
        ])

        const onTabChange = async (tab: 'alerts' | 'hidden' | 'users' | 'ads') => {
          currentAdminTab = tab
          window.history.pushState({}, '', `/admin/${tab}`)
          renderAdminTab(tab)
        }

        adminLayout = adminModule.createAdminLayout({
          activeTab: currentAdminTab,
          onTabChange
        })

        app.appendChild(adminLayout.getElement())

        const renderAdminTab = async (tab: 'alerts' | 'hidden' | 'users' | 'ads') => {
          if (!adminLayout) return

          if (tab === 'alerts') {
            adminAlertsTab = adminTabsModule[0].createAdminAlertsTab({
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
            adminHiddenTab = adminTabsModule[1].createAdminHiddenTab({
              onNavigateToTab: onTabChange
            })
            const hiddenElement = adminHiddenTab.getElement()
            if (hiddenElement) {
              adminLayout.updateMainContent(hiddenElement)
            }
          } else if (tab === 'users') {
            adminUsersTab = adminTabsModule[2].createAdminUsersTab({
              onNavigateToTab: onTabChange
            })
            const usersElement = adminUsersTab.getElement()
            if (usersElement) {
              adminLayout.updateMainContent(usersElement)
            }
          } else if (tab === 'ads') {
            adminAdsTab = adminTabsModule[3].createAdminAdsTab({
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
            } else if (item === 'bookmarks') {
              window.history.pushState({}, '', '/bookmarks')
              navigateTo('bookmarks')
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
        
        const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app'
        
        if (cachedContentComponent?.view === 'explore') {
          console.log('Restoring cached explore page')
          explorePage = cachedContentComponent.component
          const scrollY = cachedContentComponent.scrollY
          cachedContentComponent = null
          
          requestAnimationFrame(() => {
            window.scrollTo(0, scrollY)
          })
        } else {
          // Create fresh explore page
          const { createExplorePage } = await import('./components/ExplorePage.js')
          explorePage = createExplorePage({
            tag: currentTag || undefined,
            sandboxOrigin,
            currentUser
          })
          window.scrollTo(0, 0)
        }
        
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

      // Handle search page (within 3-column layout)
      if (view === 'search') {
        currentView = 'search'
        currentPostId = null
        currentUsername = null
        currentTag = null

        const mainContainer = document.createElement('div')
        mainContainer.className = 'main-container'

        const leftNav = createLeftNav({
          activeItem: 'explore',
          unreadCount: unreadNotificationCount,
          currentUser: currentUser || undefined,
          onNavigate: async (item) => {
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
            } else if (item === 'bookmarks') {
              window.history.pushState({}, '', '/bookmarks')
              navigateTo('bookmarks')
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

        const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app'
        
        if (cachedContentComponent?.view === 'search') {
          console.log('Restoring cached search page')
          searchPage = cachedContentComponent.component
          const scrollY = cachedContentComponent.scrollY
          cachedContentComponent = null
          
          requestAnimationFrame(() => {
            window.scrollTo(0, scrollY)
          })
        } else {
          const { createSearchPage } = await import('./components/SearchPage.js')
          searchPage = createSearchPage({
            query: searchQuery || '',
            type: searchType || 'posts',
            currentUser: currentUser,
            sandboxOrigin
          })
        }

        const rightPanel = createRightPanel({
          onSearch: (query) => {
            console.log('Search:', query)
          },
          onFollowUser: (userId) => {
            console.log('Follow user:', userId)
          }
        })

        mainContainer.appendChild(leftNav.getElement())
        mainContainer.appendChild(searchPage.getElement())
        mainContainer.appendChild(rightPanel.getElement())

        app.appendChild(mainContainer)

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
            } else if (item === 'bookmarks') {
              window.history.pushState({}, '', '/bookmarks')
              navigateTo('bookmarks')
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
        
        const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app'
        
        if (cachedContentComponent?.view === 'arcade') {
          console.log('Restoring cached arcade page')
          arcadePage = cachedContentComponent.component
          const scrollY = cachedContentComponent.scrollY
          cachedContentComponent = null
          
          requestAnimationFrame(() => {
            window.scrollTo(0, scrollY)
          })
        } else {
          // Create fresh arcade page
          const { createArcadePage } = await import('./components/ArcadePage.js')
          arcadePage = createArcadePage({
            sandboxOrigin,
            currentUser,
            initialGameId: currentPostId || undefined,
            onBack: () => {
              console.log('Arcade back button clicked')
              window.history.back()
            }
          })
        }
        
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
            } else if (item === 'bookmarks') {
              window.history.pushState({}, '', '/bookmarks')
              navigateTo('bookmarks')
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
        
        const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app'
        
        if (cachedContentComponent?.view === 'profile') {
          console.log('Restoring cached profile')
          profilePage = cachedContentComponent.component
          const scrollY = cachedContentComponent.scrollY
          cachedContentComponent = null
          
          requestAnimationFrame(() => {
            window.scrollTo(0, scrollY)
          })
        } else {
          // Create fresh profile page
          const { createProfilePage } = await import('./components/ProfilePage.js')
          profilePage = createProfilePage({
            username,
            currentUser,
            sandboxOrigin
          })
        }
        
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
      
      // Handle bookmarks page (within 3-column layout)
      if (view === 'bookmarks') {
        currentView = 'bookmarks'
        currentPostId = null
        currentUsername = null
        currentTag = null

        if (!currentUser) {
          window.history.pushState({}, '', '/explore')
          navigateTo('explore')
          return
        }

        const mainContainer = document.createElement('div')
        mainContainer.className = 'main-container'

        const leftNav = createLeftNav({
          activeItem: 'bookmarks',
          unreadCount: unreadNotificationCount,
          currentUser: currentUser || undefined,
          onNavigate: async (item) => {
            if (item === 'home') { window.history.pushState({}, '', '/home'); navigateTo('timeline') }
            else if (item === 'explore') { window.history.pushState({}, '', '/explore'); navigateTo('explore') }
            else if (item === 'arcade') { window.history.pushState({}, '', '/arcade'); navigateTo('arcade') }
            else if (item === 'notifications') { window.history.pushState({}, '', '/notifications'); navigateTo('notifications') }
            else if (item === 'bookmarks') { window.history.pushState({}, '', '/bookmarks'); navigateTo('bookmarks') }
            else if (item === 'settings') { window.history.pushState({}, '', '/settings'); navigateTo('settings') }
            else if (item === 'profile') {
              if (!currentUser) { window.history.pushState({}, '', '/arcade'); navigateTo('arcade'); return }
              window.history.pushState({}, '', `/profile/${currentUser.username}`)
              navigateTo('profile', undefined, currentUser.username)
            }
          },
          onSignIn: () => { window.history.pushState({}, '', '/login'); navigateTo('login') },
          onSignUp: () => { window.history.pushState({}, '', '/register'); navigateTo('register') }
        })
        leftNavInstances.add(leftNav)

        if (cachedContentComponent?.view === 'bookmarks') {
          bookmarksPage = cachedContentComponent.component
          const scrollY = cachedContentComponent.scrollY
          cachedContentComponent = null
          requestAnimationFrame(() => { window.scrollTo(0, scrollY) })
        } else {
          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app'
          const { createBookmarksPage } = await import('./components/BookmarksPage.js')
          bookmarksPage = createBookmarksPage({
            sandboxOrigin,
            currentUser
          })
          window.scrollTo(0, 0)
        }

        const rightPanel = createRightPanel({
          onSearch: (query) => {},
          onFollowUser: (userId) => {}
        })

        mainContainer.appendChild(leftNav.getElement())
        mainContainer.appendChild(bookmarksPage.getElement())
        mainContainer.appendChild(rightPanel.getElement())
        app.appendChild(mainContainer)
        setupMobileLeftNav(leftNav.getElement())
        return
      }

      // Handle notifications page (within 3-column layout)
      if (view === 'notifications') {
        currentView = 'notifications'
        currentPostId = null
        currentUsername = null
        currentTag = null
        
        // Save unread count before fetching notifications data (the API might mark
        // notifications as read, which would reset the count and lose the badge)
        const savedUnreadCount = unreadNotificationCount
        
        // Fetch notifications data for the page content
        const [notificationsData] = await Promise.all([
          fetchNotifications()
        ])
        
        // Restore the pre-fetch unread count so the badge reflects the actual unread count
        // (fetchNotifications may have changed it)
        if (notificationsData.unread_count === 0 && savedUnreadCount > 0) {
          unreadNotificationCount = savedUnreadCount
        }
        
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
            } else if (item === 'bookmarks') {
              window.history.pushState({}, '', '/bookmarks')
              navigateTo('bookmarks')
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
        const { createNotificationsPage } = await import('./components/NotificationsPage.js')
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
            leftNavInstances.forEach((ln: any) => {
              if (typeof ln.setUnreadCount === 'function') {
                ln.setUnreadCount(0)
              }
            })
            stopNotificationPolling()
            startNotificationPolling()
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
            } else if (item === 'bookmarks') {
              window.history.pushState({}, '', '/bookmarks')
              navigateTo('bookmarks')
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
        const settingsModule = await import('./components/SettingsPage.js')
        settingsPage = settingsModule.createSettingsPage({
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
              settingsPage = settingsModule.createSettingsPage({
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
        const { createThreadPage } = await import('./components/ThreadPage.js')
        threadPage = createThreadPage({
          postId,
          sandboxOrigin,
          currentUser,
          unreadCount: unreadNotificationCount,
          onBack: () => {
            console.log('Back button clicked, returning to previous view')
            if (cachedContentComponent) {
              window.history.back()
            } else {
              window.history.pushState({}, '', '/home')
              navigateTo('timeline')
            }
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

        // Create Right Panel
        const threadRightPanel = createRightPanel({
          onSearch: (query) => {
            console.log('Search:', query)
          },
          onFollowUser: (userId) => {
            console.log('Follow user:', userId)
          }
        })
        mainContainer.appendChild(threadRightPanel.getElement())
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
            } else if (item === 'bookmarks') {
              window.history.pushState({}, '', '/bookmarks')
              navigateTo('bookmarks')
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
        
        const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app'
        
        if (cachedContentComponent?.view === 'timeline') {
          console.log('Restoring cached timeline')
          timeline = cachedContentComponent.component
          const scrollY = cachedContentComponent.scrollY
          cachedContentComponent = null
          
          requestAnimationFrame(() => {
            window.scrollTo(0, scrollY)
          })
        } else {
          // Create fresh timeline
          const { createTimeline } = await import('./components/Timeline.js')
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
          
          // Restore scroll position after timeline posts load
          timeline.getElement().addEventListener('timelineReady', () => {
            if (savedScrollY > 0) {
              const scrollY = savedScrollY
              savedScrollY = 0
              window.scrollTo(0, scrollY)
            }
          }, { once: true })
        }
        
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
        await navigateTo(route.view, route.postId || undefined, route.username || undefined, route.tag || undefined, route.adminTab || undefined, route.searchQuery || undefined, route.searchType || undefined)
      }
    })
    
    // Handle SPA navigation events
    window.addEventListener('spaNavigate', async (e: any) => {
      const detail = e.detail
      await navigateTo(detail.view, detail.postId, detail.username, detail.tag, detail.adminTab, detail.searchQuery, detail.searchType)
    })
    
    // Initial navigation
    console.log('DOM Content Loaded, starting initial routing...')
    
    const initialRoute = parseCurrentRoute()
    console.log('Initial route:', initialRoute)
    if (initialRoute) {
      await navigateTo(initialRoute.view, initialRoute.postId || undefined, initialRoute.username || undefined, initialRoute.tag || undefined, initialRoute.adminTab || undefined, initialRoute.searchQuery || undefined, initialRoute.searchType || undefined)
    }

    // Defer non-critical initialization to after the first paint
    const deferInit = (fn: () => void) => {
      if ('requestIdleCallback' in window) {
        (window as any).requestIdleCallback(fn, { timeout: 3000 })
      } else {
        setTimeout(fn, 3000)
      }
    }

    deferInit(async () => {
      const { initFlaxiaNode } = await import('/api/crowd/index.js')
      initFlaxiaNode({
        orchestratorUrl: 'https://flaxia-worker.remydre8.workers.dev',
        siteId: 'flaxia',
        consent: {
          brandName: 'Flaxia',
          position: 'bottom-right',
        },
        capabilities: ['ai-inference'],
        maxCpuLoad: 0.15,
      })
    })
  }
})
