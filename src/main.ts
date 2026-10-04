import './styles/main.css';
import type { ArcadePageHandle } from './components/ArcadePage.js';
import type { BookmarksPage } from './components/BookmarksPage.js';
import type { BottomNav } from './components/BottomNav.js';
import { showCrowdConsentModal } from './components/CrowdConsentModal.js';
import type { ExplorePage } from './components/ExplorePage.js';
import type { LeftNav } from './components/LeftNav.js';
import type { NotificationsPage } from './components/NotificationsPage.js';
import type { ThreadPage } from './components/ThreadPage.js';
import type { Timeline } from './components/Timeline.js';
import { getMe } from './lib/auth-cache.js';
import { initContentProtection } from './lib/content-protection.js';
import { canRunFlaxiaNode, initCrowdNode, notifyCrowdConsentChanged } from './lib/crowd-node.js';
import { initI18n, t } from './lib/i18n.js';
import { lazyCreateBottomNav, lazyCreateLeftNav, lazyCreateRightPanel, lazyUpdateLeftNavUser } from './lib/lazy-nav.js';
import { closeLeftNav, openLeftNav, removeLeftNavOverlay, setupMobileLeftNav } from './lib/left-nav-drawer.js';
import {
  clearNativeBadge,
  initNativeNotify,
  initNativePushRegistration,
  notifyViaTauri,
  setNativeBadge,
} from './lib/native-notify.js';
import { fetchNotifications, invalidateNotificationsCache } from './lib/notifications-api.js';
import { hidePageLoader, showPageLoader, showPageLoaderFailure } from './lib/page-loader.js';
import { initPerformanceMonitoring } from './lib/performance.js';
import { createPushSocket } from './lib/push-socket.js';
import { parseCurrentRoute } from './lib/router.js';
import { initTheme } from './lib/theme.js';
import { showToast } from './lib/toast.js';
import { viewToBottomNavId } from './lib/view-nav.js';
import { initializeWebPush } from './lib/web-push.js';

interface PageComponent {
  getElement(): HTMLElement;
  destroy(): void;
}

// Initialize performance monitoring
initPerformanceMonitoring();

// Initialize content protection (right-click, drag, keyboard shortcuts)
initContentProtection();

// Initialize theme (keeps system theme in sync during SPA navigation)
initTheme();

// Start i18n loading early (parallelizes the network fetch with script parsing/css loading)
initI18n();

// Basic app initialization
document.addEventListener('DOMContentLoaded', async () => {
  const app = document.getElementById('app');
  if (app) {
    history.scrollRestoration = 'manual';

    await initI18n();

    // Routing state
    let currentView:
      | 'timeline'
      | 'thread'
      | 'login'
      | 'register'
      | 'profile'
      | 'explore'
      | 'search'
      | 'notifications'
      | 'bookmarks'
      | 'terms'
      | 'privacy'
      | 'about'
      | 'docs'
      | 'admin'
      | 'settings'
      | 'arcade'
      | 'billing-success'
      | 'billing-canceled' = 'timeline';
    let currentPostId: string | null = null;
    let _currentUsername: string | null = null;
    let currentTag: string | null = null;
    let currentAdminTab: 'alerts' | 'hidden' | 'users' | 'ads' | 'counter' = 'alerts';
    let timeline: Timeline | null = null;
    let threadPage: ThreadPage | null = null;
    let savedScrollY = 0;
    let loginPage: PageComponent | null = null;
    let registerPage: PageComponent | null = null;
    let profilePage: PageComponent | null = null;
    let explorePage: ExplorePage | null = null;
    let legalPage: PageComponent | null = null;
    let docsPage: PageComponent | null = null;
    let notificationsPage: NotificationsPage | null = null;
    let settingsPage: PageComponent | null = null;
    let arcadePage: ArcadePageHandle | null = null;
    let searchPage: PageComponent | null = null;
    let bookmarksPage: BookmarksPage | null = null;
    let cachedContentComponent: { view: string; component: unknown; scrollY: number } | null = null;
    let adminLayout:
      | (PageComponent & { updateMainContent: (el: HTMLElement) => void; setAccessDenied: () => void })
      | null = null;
    let adminAlertsTab: PageComponent | null = null;
    let adminHiddenTab: PageComponent | null = null;
    let adminUsersTab: PageComponent | null = null;
    let adminAdsTab: PageComponent | null = null;
    const leftNavInstances: Set<LeftNav> = new Set();
    let bottomNav: BottomNav | null = null;

    /** Map a top-level view to the matching bottom-nav item id ('' = none). */
    /** Shared navigation handler for the mobile bottom bar. */
    const handleBottomNavNavigate = (item: string): void => {
      if (item === 'home') {
        window.history.pushState({}, '', '/home');
        navigateTo('timeline');
      } else if (item === 'explore') {
        window.history.pushState({}, '', '/explore');
        navigateTo('explore');
      } else if (item === 'arcade') {
        window.history.pushState({}, '', '/arcade');
        navigateTo('arcade');
      } else if (item === 'notifications') {
        window.history.pushState({}, '', '/notifications');
        navigateTo('notifications');
      } else if (item === 'account') {
        if (!currentUser) {
          window.history.pushState({}, '', '/login');
          navigateTo('login');
          return;
        }
        window.history.pushState({}, '', `/profile/${currentUser.username}`);
        navigateTo('profile', undefined, currentUser.username);
      }
    };
    /** Create the single global bottom-nav instance once and mount it. */
    const ensureBottomNav = async (): Promise<void> => {
      if (bottomNav) return;
      bottomNav = await lazyCreateBottomNav({
        activeItem: 'home',
        currentUser: currentUser || undefined,
        onNavigate: handleBottomNavNavigate,
        onSignIn: () => {
          window.history.pushState({}, '', '/login');
          navigateTo('login');
        },
        onSignUp: () => {
          window.history.pushState({}, '', '/register');
          navigateTo('register');
        },
      });
      document.body.appendChild(bottomNav.getElement());
    };
    let currentUser: {
      username: string;
      id: string;
      display_name?: string;
      avatar_key?: string;
      badge_type?: string | null;
    } | null = null;
    let unreadNotificationCount = 0;

    // Native notification platforms (see src/lib/native-notify.ts)

    /// WebSocket 経由のプッシュ通知を受け取り OS 通知を表示する
    /// (接続管理・backoff は src/lib/push-socket.ts)
    const isCapacitorNative =
      typeof window !== 'undefined' &&
      typeof window.Capacitor !== 'undefined' &&
      typeof window.Capacitor.isNativePlatform === 'function' &&
      window.Capacitor.isNativePlatform();

    const pushSocket = createPushSocket(
      () => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const sessionToken = localStorage.getItem('flaxia_session');
        return `${protocol}//${window.location.host}/api/ws/notifications${sessionToken ? `?token=${encodeURIComponent(sessionToken)}` : ''}`;
      },
      {
        onOpen: () => {
          console.log('[push] connected');
          refreshNotificationBadges();
        },
        onMessage: (raw) => {
          const data = raw as {
            type?: string;
            unread_count?: number;
            push?: { title: string; body: string };
            title?: string;
            body?: string;
          };
          if (data.type === 'notification') {
            if (typeof data.unread_count === 'number') {
              unreadNotificationCount = data.unread_count;
              updateBadgeUI();
            }
            if (data.push) {
              notifyViaTauri(data.push.title, data.push.body);
            }
            // OS 通知の表示は Push (FCM / Web Push) が担当する。
            // Tauri には Push サービスが無いため WebSocket 経由でのみ表示する。
          } else if (data.title) {
            notifyViaTauri(data.title, data.body || 'New notification');
            refreshNotificationBadges();
          }
        },
      },
    );
    const connectPushWebSocket = () => pushSocket.connect();

    /** Register Web Push in browser (Service Worker), or skip in Tauri/Capacitor. */
    /** Web Push registration (see src/lib/web-push.ts). */

    // Capacitor ライフサイクル: アプリ復帰時に WebSocket 再接続
    if (isCapacitorNative) {
      try {
        const { App } = await import('@capacitor/app');
        await App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) {
            // フォアグラウンド復帰時、WebSocket を再接続 & 未読カウント即時取得
            // (connect は接続中なら何もしない)
            connectPushWebSocket();
            refreshNotificationBadges();
          }
        });
      } catch {
        console.log('[push] @capacitor/app not available');
      }
    }

    // Offline / online をトーストで統一表示する
    window.addEventListener('offline', () => showToast(t('common.offline'), true));
    window.addEventListener('online', () => showToast(t('common.online')));

    const updateBadgeUI = () => {
      leftNavInstances.forEach((leftNav) => {
        if (typeof leftNav.setUnreadCount === 'function') {
          leftNav.setUnreadCount(unreadNotificationCount);
        }
      });

      setNativeBadge(unreadNotificationCount);
    };

    const refreshNotificationBadges = async () => {
      console.log('[poll] refreshNotificationBadges called');
      const data = await fetchNotifications();
      unreadNotificationCount = data.unread_count || 0;
      console.log('[poll] unread count:', unreadNotificationCount);
      updateBadgeUI();
    };

    // Expose for Rust desktop background polling (lib.rs background thread, Tauri desktop only)
    const isTauriDesktop =
      typeof window !== 'undefined' &&
      (window.__TAURI__ || window.__TAURI_INTERNALS__) &&
      !/Android/i.test(navigator.userAgent) &&
      !isCapacitorNative;
    if (isTauriDesktop) {
      window.__tauriDesktopPoll = refreshNotificationBadges;
    }

    const startNotificationPolling = () => {
      // 初回一度だけ HTTP 取得（以降は WebSocket でリアルタイム更新）
      refreshNotificationBadges();
    };

    const stopNotificationPolling = () => {
      // polling は廃止。WebSocket 切断時は再接続時に onopen で再取得する
    };

    // Check current user session
    const checkAuth = async () => {
      try {
        const data = await getMe();
        if (data) {
          const userData = data.user as {
            id: string;
            username: string;
            display_name?: string;
            avatar_key?: string;
            badge_type?: string | null;
          };
          currentUser = {
            id: userData.id,
            username: userData.username,
            display_name: userData.display_name,
            avatar_key: userData.avatar_key,
            badge_type: userData.badge_type,
          };

          // Update all existing LeftNav instances with new user data
          leftNavInstances.forEach((leftNav) => {
            lazyUpdateLeftNavUser(leftNav, currentUser);
          });

          // Create/update the mobile bottom nav with the signed-in user
          await ensureBottomNav();
          bottomNav?.updateUser(currentUser);

          // 初回の未読通知数を取得（以降は WebSocket でリアルタイム更新）
          startNotificationPolling();

          // WebSocket でリアルタイム通知受信（全プラットフォーム）
          connectPushWebSocket();

          return true;
        }
      } catch (error) {
        console.log('Not authenticated:', error);
      }

      // Clear user state when not authenticated
      const wasLoggedIn = currentUser !== null;
      currentUser = null;

      // Update all existing LeftNav instances to remove user area
      leftNavInstances.forEach((leftNav) => {
        lazyUpdateLeftNavUser(leftNav, null);
      });

      // Create/update the mobile bottom nav for the guest state
      await ensureBottomNav();
      bottomNav?.updateUser(null);

      // If user was logged in and now is not, they were logged out
      if (wasLoggedIn) {
        console.log('User session expired - redirecting to login');
        stopNotificationPolling();
        window.history.replaceState({}, '', '/login');
        navigateTo('login');
        return false;
      }

      return false;
    };

    // Fetch notifications (see src/lib/notifications-api.ts)

    // Mobile left nav overlay management (see src/lib/left-nav-drawer.ts)

    // Auth guard - redirect to login if not authenticated (only for protected routes)
    const requireAuth = async () => {
      const isAuthenticated = await checkAuth();

      // Check if current route is public (accessible to guests)
      const path = window.location.pathname;
      const cleanPath = path.replace(/\/$/, '');
      const _urlParams = new URLSearchParams(window.location.search);

      // Public routes that don't require authentication:
      // - / (home/timeline)
      // - /home (landing page)
      // - /explore (with or without tag parameter)
      // - /arcade (game arcade)
      // - /users/:username (profile pages)
      // - /profile/:username (profile pages - alias for /users/)
      // - /thread/:id (thread pages)
      // - /terms, /privacy, /about (legal pages)
      // - /docs, /docs/:slug (docs blog)
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
        cleanPath === '/docs' ||
        cleanPath.startsWith('/docs/') ||
        cleanPath.startsWith('/users/') ||
        cleanPath.startsWith('/profile/') ||
        cleanPath.startsWith('/arcade/') ||
        cleanPath.startsWith('/thread/');

      // Allow public routes for everyone
      if (isPublicRoute) {
        return true;
      }

      // For /notifications, redirect to arcade if not authenticated
      if (cleanPath === '/notifications') {
        if (!isAuthenticated) {
          window.history.replaceState({}, '', '/arcade');
          navigateTo('arcade');
          return false;
        }
        return true;
      }

      // For all other protected routes, redirect to login if not authenticated
      if (!isAuthenticated) {
        // Use replaceState so the browser back button doesn't return to the
        // protected route (which would just redirect again, causing an infinite loop)
        window.history.replaceState({}, '', '/login');
        navigateTo('login');
        return false;
      }

      return true;
    };

    // URL routing (see src/lib/router.ts)

    // Page loading overlay (see src/lib/page-loader.ts)

    // Navigate to view
    const navigateTo = async (
      view:
        | 'timeline'
        | 'thread'
        | 'login'
        | 'register'
        | 'profile'
        | 'explore'
        | 'search'
        | 'notifications'
        | 'bookmarks'
        | 'terms'
        | 'privacy'
        | 'about'
        | 'docs'
        | 'admin'
        | 'settings'
        | 'arcade'
        | 'billing-success'
        | 'billing-canceled',
      postId?: string,
      username?: string,
      tag?: string,
      adminTab?: 'alerts' | 'hidden' | 'users' | 'counter',
      searchQuery?: string,
      searchType?: 'posts' | 'users' | 'arcade',
    ) => {
      console.log('Navigate to:', view, postId, username, tag, 'Current view:', currentView, 'adminTab:', adminTab);

      // Close mobile nav if open
      closeLeftNav();

      // Sync active item on the mobile bottom nav
      if (bottomNav) {
        const navId = viewToBottomNavId(view);
        if (navId) bottomNav.setActiveItem(navId);
      }

      // For auth routes, proceed directly
      if (view === 'login' || view === 'register') {
        // Cleanup current view
        if (timeline) {
          console.log('Cleaning up timeline');
          timeline.destroy();
          timeline = null;
        }
        if (threadPage) {
          console.log('Cleaning up thread page');
          threadPage.destroy();
          threadPage = null;
        }
        if (loginPage) {
          loginPage.destroy();
          loginPage = null;
        }
        if (registerPage) {
          registerPage.destroy();
          registerPage = null;
        }
        if (profilePage) {
          profilePage.destroy();
          profilePage = null;
        }
        if (notificationsPage) {
          notificationsPage.destroy();
          notificationsPage = null;
        }
        if (settingsPage) {
          settingsPage.destroy();
          settingsPage = null;
        }
        if (bookmarksPage) {
          bookmarksPage.destroy();
          bookmarksPage = null;
        }
      } else {
        // Auth guard for protected routes
        const isAuthenticated = await requireAuth();
        if (!isAuthenticated) {
          return; // Auth guard will redirect to login
        }

        // Cache current view when navigating to thread or arcade (for back navigation with preserved content)
        if ((view === 'thread' || view === 'arcade') && currentView !== view) {
          console.log(`Caching current view for back navigation to ${view}:`, currentView);
          if (currentView === 'timeline' && timeline) {
            cachedContentComponent = { view: 'timeline', component: timeline, scrollY: window.scrollY };
            timeline = null;
          } else if (currentView === 'profile' && profilePage) {
            cachedContentComponent = { view: 'profile', component: profilePage, scrollY: window.scrollY };
            profilePage = null;
          } else if (currentView === 'explore' && explorePage) {
            cachedContentComponent = { view: 'explore', component: explorePage, scrollY: window.scrollY };
            explorePage = null;
          } else if (currentView === 'search' && searchPage) {
            cachedContentComponent = { view: 'search', component: searchPage, scrollY: window.scrollY };
            searchPage = null;
          } else if (currentView === 'arcade' && arcadePage) {
            arcadePage.suspend();
            cachedContentComponent = { view: 'arcade', component: arcadePage, scrollY: window.scrollY };
            arcadePage = null;
          } else if (currentView === 'bookmarks' && bookmarksPage) {
            cachedContentComponent = { view: 'bookmarks', component: bookmarksPage, scrollY: window.scrollY };
            bookmarksPage = null;
          }
        }

        // Save scroll position when leaving timeline (for fresh timeline creation back navigation)
        if (currentView === 'timeline' && view !== 'timeline') {
          savedScrollY = window.scrollY;
        } else if (view !== 'timeline') {
          savedScrollY = 0;
        }

        // Cleanup current view (cached components already nulled above)
        if (timeline) {
          console.log('Cleaning up timeline');
          timeline.destroy();
          timeline = null;
        }
        if (threadPage) {
          console.log('Cleaning up thread page');
          threadPage.destroy();
          threadPage = null;
        }
        if (loginPage) {
          loginPage.destroy();
          loginPage = null;
        }
        if (registerPage) {
          registerPage.destroy();
          registerPage = null;
        }
        if (profilePage) {
          profilePage.destroy();
          profilePage = null;
        }
        if (notificationsPage) {
          notificationsPage.destroy();
          notificationsPage = null;
        }
        if (settingsPage) {
          settingsPage.destroy();
          settingsPage = null;
        }
        if (bookmarksPage) {
          bookmarksPage.destroy();
          bookmarksPage = null;
        }
        if (arcadePage) {
          arcadePage.destroy();
          arcadePage = null;
        }
        if (searchPage) {
          searchPage.destroy();
          searchPage = null;
        }
      }
      showPageLoader();
      app.innerHTML = '';

      // Wrap rendering in try-catch so errors don't leave the loader stuck
      try {
        // Handle auth pages (full screen, no nav)
        if (view === 'login') {
          removeLeftNavOverlay();
          currentView = 'login';
          currentPostId = null;
          _currentUsername = null;

          const { createLoginPage } = await import('./components/LoginPage.js');
          loginPage = createLoginPage({
            onSuccess: () => {
              window.history.pushState({}, '', '/arcade');
              navigateTo('arcade');
            },
          });

          app.appendChild(loginPage.getElement());
          hidePageLoader();
          return;
        }

        if (view === 'register') {
          removeLeftNavOverlay();
          currentView = 'register';
          currentPostId = null;
          _currentUsername = null;

          const { createRegisterPage } = await import('./components/RegisterPage.js');
          registerPage = createRegisterPage({
            onSuccess: () => {
              window.history.pushState({}, '', '/arcade');
              navigateTo('arcade');
            },
          });

          app.appendChild(registerPage.getElement());
          hidePageLoader();
          return;
        }

        // Handle legal pages (public, no auth required, no layout)
        if (view === 'terms' || view === 'privacy' || view === 'about') {
          removeLeftNavOverlay();
          currentView = view;
          currentPostId = null;
          _currentUsername = null;

          const { createLegalPage } = await import('./components/LegalPage.js');
          legalPage = createLegalPage({
            type: view,
          });

          app.appendChild(legalPage.getElement());
          hidePageLoader();
          return;
        }

        // Handle docs blog (public, no auth required, no layout)
        if (view === 'docs') {
          removeLeftNavOverlay();
          currentView = view;
          currentPostId = postId || null;
          _currentUsername = null;

          const { createDocsPage } = await import('./components/DocsPage.js');
          docsPage = createDocsPage({
            slug: postId || undefined,
          });

          app.appendChild(docsPage.getElement());
          hidePageLoader();
          return;
        }

        // Handle billing success/canceled pages
        if (view === 'billing-success' || view === 'billing-canceled') {
          removeLeftNavOverlay();
          currentView = view;
          currentPostId = null;
          _currentUsername = null;

          const { createBillingResultPage } = await import('./components/BillingResultPage.js');
          const billingPage = createBillingResultPage({
            success: view === 'billing-success',
          });

          app.appendChild(billingPage.getElement());
          hidePageLoader();
          return;
        }

        // Handle admin page (separate layout, no Left Nav)
        if (view === 'admin') {
          currentView = 'admin';
          currentAdminTab = adminTab || 'alerts';

          // Cleanup regular views
          if (timeline) (timeline as Timeline).destroy();
          timeline = null;
          if (threadPage) (threadPage as ThreadPage).destroy();
          threadPage = null;
          if (profilePage) (profilePage as PageComponent).destroy();
          profilePage = null;
          if (explorePage) (explorePage as ExplorePage).destroy();
          explorePage = null;
          if (notificationsPage) (notificationsPage as NotificationsPage).destroy();
          notificationsPage = null;
          if (settingsPage) (settingsPage as PageComponent).destroy();
          settingsPage = null;

          const adminModule = await import('./components/AdminLayout.js');
          const adminTabsModule = await Promise.all([
            import('./components/AdminAlertsTab.js'),
            import('./components/AdminHiddenTab.js'),
            import('./components/AdminUsersTab.js'),
            import('./components/AdminAdsTab.js'),
          ]);

          const onTabChange = async (tab: 'alerts' | 'hidden' | 'users' | 'ads' | 'counter') => {
            currentAdminTab = tab;
            window.history.pushState({}, '', `/admin/${tab}`);
            renderAdminTab(tab);
          };

          adminLayout = adminModule.createAdminLayout({
            activeTab: currentAdminTab,
            onTabChange,
          });

          app.appendChild(adminLayout.getElement());
          hidePageLoader();

          const renderAdminTab = async (tab: 'alerts' | 'hidden' | 'users' | 'ads' | 'counter') => {
            if (!adminLayout) return;

            if (tab === 'alerts') {
              adminAlertsTab = adminTabsModule[0].createAdminAlertsTab({
                onNavigateToTab: onTabChange,
              });
              const alertsElement = adminAlertsTab.getElement();
              if (alertsElement) {
                adminLayout.updateMainContent(alertsElement);
              }

              // Check for access denied
              try {
                const response = await fetch('/api/admin/alerts', { credentials: 'include' });
                if (response.status === 403) {
                  adminLayout.setAccessDenied();
                }
              } catch (e) {
                console.error('Failed to check admin access:', e);
              }
            } else if (tab === 'hidden') {
              adminHiddenTab = adminTabsModule[1].createAdminHiddenTab({
                onNavigateToTab: onTabChange,
              });
              const hiddenElement = adminHiddenTab.getElement();
              if (hiddenElement) {
                adminLayout.updateMainContent(hiddenElement);
              }
            } else if (tab === 'users') {
              adminUsersTab = adminTabsModule[2].createAdminUsersTab({
                onNavigateToTab: onTabChange,
              });
              const usersElement = adminUsersTab.getElement();
              if (usersElement) {
                adminLayout.updateMainContent(usersElement);
              }
            } else if (tab === 'ads') {
              adminAdsTab = adminTabsModule[3].createAdminAdsTab({
                onNavigateToTab: onTabChange,
              });
              const adsElement = adminAdsTab.getElement();
              if (adsElement) {
                adminLayout.updateMainContent(adsElement);
              }
            } else if (tab === 'counter') {
              const counterModule = await import('./components/AdminCounterTab.js');
              const adminCounterTab = counterModule.createAdminCounterTab({
                onNavigateToTab: onTabChange,
              });
              const counterElement = adminCounterTab.getElement();
              if (counterElement) {
                adminLayout.updateMainContent(counterElement);
              }
            }
          };

          // Render initial tab
          renderAdminTab(currentAdminTab);
          return;
        }

        // Handle explore page (within 3-column layout)
        if (view === 'explore') {
          currentView = 'explore';
          currentPostId = null;
          _currentUsername = null;
          currentTag = tag || null;

          // Create main container for 3-column layout
          const mainContainer = document.createElement('div');
          mainContainer.className = 'main-container';

          // Create Left Nav
          const leftNav = await lazyCreateLeftNav({
            activeItem: 'explore',
            unreadCount: unreadNotificationCount,
            currentUser: currentUser || undefined,
            onNavigate: leftNavNavigateHandler,
            onSignIn: leftNavSignInHandler,
            onSignUp: leftNavSignUpHandler,
          });

          leftNavInstances.add(leftNav);

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app';

          if (cachedContentComponent?.view === 'explore') {
            console.log('Restoring cached explore page');
            explorePage = cachedContentComponent.component as ExplorePage;
            const scrollY = cachedContentComponent.scrollY;
            cachedContentComponent = null;

            requestAnimationFrame(() => {
              window.scrollTo(0, scrollY);
            });
          } else {
            // Create fresh explore page
            const { createExplorePage } = await import('./components/ExplorePage.js');
            explorePage = createExplorePage({
              tag: currentTag || undefined,
              sandboxOrigin,
              currentUser,
            });
            window.scrollTo(0, 0);
          }

          // Create Right Panel
          const rightPanel = await lazyCreateRightPanel({
            onSearch: (query) => {
              console.log('Search:', query);
              // Handle search here
            },
            onFollowUser: (userId) => {
              console.log('Follow user:', userId);
              // Handle follow here
            },
          });

          // Assemble layout
          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(explorePage.getElement());
          mainContainer.appendChild(rightPanel.getElement());

          app.appendChild(mainContainer);
          hidePageLoader();

          // Setup mobile left nav
          setupMobileLeftNav(leftNav.getElement());

          return;
        }

        // Handle search page (within 3-column layout)
        if (view === 'search') {
          currentView = 'search';
          currentPostId = null;
          _currentUsername = null;
          currentTag = null;

          const mainContainer = document.createElement('div');
          mainContainer.className = 'main-container';

          const leftNav = await lazyCreateLeftNav({
            activeItem: 'explore',
            unreadCount: unreadNotificationCount,
            currentUser: currentUser || undefined,
            onNavigate: leftNavNavigateHandler,
            onSignIn: leftNavSignInHandler,
            onSignUp: leftNavSignUpHandler,
          });

          leftNavInstances.add(leftNav);

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app';

          if (cachedContentComponent?.view === 'search') {
            console.log('Restoring cached search page');
            searchPage = cachedContentComponent.component as PageComponent;
            const scrollY = cachedContentComponent.scrollY;
            cachedContentComponent = null;

            requestAnimationFrame(() => {
              window.scrollTo(0, scrollY);
            });
          } else {
            const { createSearchPage } = await import('./components/SearchPage.js');
            searchPage = createSearchPage({
              query: searchQuery || '',
              type: searchType || 'posts',
              currentUser: currentUser,
              sandboxOrigin,
            });
          }

          const rightPanel = await lazyCreateRightPanel({
            onSearch: (query) => {
              console.log('Search:', query);
            },
            onFollowUser: (userId) => {
              console.log('Follow user:', userId);
            },
          });

          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(searchPage.getElement());
          mainContainer.appendChild(rightPanel.getElement());

          app.appendChild(mainContainer);
          hidePageLoader();

          setupMobileLeftNav(leftNav.getElement());

          return;
        }

        // Handle arcade page (within 3-column layout)
        if (view === 'arcade') {
          currentView = 'arcade';
          currentPostId = postId || null;
          _currentUsername = null;
          currentTag = null;

          // Create main container for 3-column layout
          const mainContainer = document.createElement('div');
          mainContainer.className = 'main-container';

          // Create Left Nav
          const leftNav = await lazyCreateLeftNav({
            activeItem: 'arcade',
            unreadCount: unreadNotificationCount,
            currentUser: currentUser || undefined,
            onNavigate: leftNavNavigateHandler,
            onSignIn: leftNavSignInHandler,
            onSignUp: leftNavSignUpHandler,
          });

          leftNavInstances.add(leftNav);

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app';

          if (cachedContentComponent?.view === 'arcade') {
            console.log('Restoring cached arcade page');
            arcadePage = cachedContentComponent.component as ArcadePageHandle;
            arcadePage.resume();
            const scrollY = cachedContentComponent.scrollY;
            cachedContentComponent = null;

            requestAnimationFrame(() => {
              window.scrollTo(0, scrollY);
            });
          } else {
            // Create fresh arcade page
            const { createArcadePage } = await import('./components/ArcadePage.js');
            arcadePage = createArcadePage({
              sandboxOrigin,
              currentUser,
              initialGameId: currentPostId || undefined,
              onBack: () => {
                window.history.pushState({}, '', '/home');
                navigateTo('timeline');
              },
            });
          }

          // Create Right Panel
          const rightPanel = await lazyCreateRightPanel({
            onSearch: (query) => {
              console.log('Search:', query);
              // Handle search here
            },
            onFollowUser: (userId) => {
              console.log('Follow user:', userId);
              // Handle follow here
            },
          });

          // Assemble layout
          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(arcadePage.getElement());
          mainContainer.appendChild(rightPanel.getElement());

          app.appendChild(mainContainer);
          hidePageLoader();

          // Setup mobile left nav
          setupMobileLeftNav(leftNav.getElement());

          return;
        }

        // Handle profile page (within 3-column layout)
        if (view === 'profile' && username) {
          currentView = 'profile';
          currentPostId = null;
          _currentUsername = username;
          currentTag = null;

          // Create main container for 3-column layout
          const mainContainer = document.createElement('div');
          mainContainer.className = 'main-container';

          // Create Left Nav
          const leftNav = await lazyCreateLeftNav({
            activeItem: 'profile',
            unreadCount: unreadNotificationCount,
            currentUser: currentUser || undefined,
            onNavigate: leftNavNavigateHandler,
            onSignIn: leftNavSignInHandler,
            onSignUp: leftNavSignUpHandler,
          });

          leftNavInstances.add(leftNav);

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app';

          if (cachedContentComponent?.view === 'profile') {
            console.log('Restoring cached profile');
            profilePage = cachedContentComponent.component as PageComponent;
            const scrollY = cachedContentComponent.scrollY;
            cachedContentComponent = null;

            requestAnimationFrame(() => {
              window.scrollTo(0, scrollY);
            });
          } else {
            // Create fresh profile page
            const { createProfilePage } = await import('./components/ProfilePage.js');
            profilePage = createProfilePage({
              username,
              currentUser,
              sandboxOrigin,
              onOpenSettings: () => navigateTo('settings'),
            });
          }

          // Create Right Panel
          const rightPanel = await lazyCreateRightPanel({
            onSearch: (query) => {
              console.log('Search:', query);
              // Handle search here
            },
            onFollowUser: (userId) => {
              console.log('Follow user:', userId);
              // Handle follow here
            },
          });

          // Assemble layout
          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(profilePage.getElement());
          mainContainer.appendChild(rightPanel.getElement());

          app.appendChild(mainContainer);
          hidePageLoader();

          // Setup mobile left nav
          setupMobileLeftNav(leftNav.getElement());

          return;
        }

        // Handle bookmarks page (within 3-column layout)
        if (view === 'bookmarks') {
          currentView = 'bookmarks';
          currentPostId = null;
          _currentUsername = null;
          currentTag = null;

          if (!currentUser) {
            window.history.pushState({}, '', '/explore');
            navigateTo('explore');
            return;
          }

          const mainContainer = document.createElement('div');
          mainContainer.className = 'main-container';

          const leftNav = await lazyCreateLeftNav({
            activeItem: 'bookmarks',
            unreadCount: unreadNotificationCount,
            currentUser: currentUser || undefined,
            onNavigate: leftNavNavigateHandler,
            onSignIn: leftNavSignInHandler,
            onSignUp: leftNavSignUpHandler,
          });
          leftNavInstances.add(leftNav);

          if (cachedContentComponent?.view === 'bookmarks') {
            bookmarksPage = cachedContentComponent.component as BookmarksPage;
            const scrollY = cachedContentComponent.scrollY;
            cachedContentComponent = null;
            requestAnimationFrame(() => {
              window.scrollTo(0, scrollY);
            });
          } else {
            const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app';
            const { createBookmarksPage } = await import('./components/BookmarksPage.js');
            bookmarksPage = createBookmarksPage({
              sandboxOrigin,
              currentUser,
            });
            window.scrollTo(0, 0);
          }

          const rightPanel = await lazyCreateRightPanel({
            onSearch: (query) => {},
            onFollowUser: (userId) => {},
          });

          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(bookmarksPage.getElement());
          mainContainer.appendChild(rightPanel.getElement());
          app.appendChild(mainContainer);
          hidePageLoader();
          setupMobileLeftNav(leftNav.getElement());
          return;
        }

        // Handle notifications page (within 3-column layout)
        if (view === 'notifications') {
          currentView = 'notifications';
          currentPostId = null;
          _currentUsername = null;
          currentTag = null;

          // Fetch notifications data for the page content
          const [notificationsData] = await Promise.all([fetchNotifications()]);
          unreadNotificationCount = notificationsData.unread_count || 0;

          // Create main container for 3-column layout
          const mainContainer = document.createElement('div');
          mainContainer.className = 'main-container';

          // Create Left Nav with unread count
          const leftNav = await lazyCreateLeftNav({
            activeItem: 'notifications',
            unreadCount: unreadNotificationCount,
            currentUser: currentUser || undefined,
            onNavigate: leftNavNavigateHandler,
            onSignIn: leftNavSignInHandler,
            onSignUp: leftNavSignUpHandler,
          });

          leftNavInstances.add(leftNav);

          // Create Notifications Page
          const { createNotificationsPage } = await import('./components/NotificationsPage.js');
          notificationsPage = createNotificationsPage({
            notifications: notificationsData.notifications,
            unreadCount: notificationsData.unread_count,
            onMarkAllRead: async () => {
              await fetch('/api/notifications/read-all', {
                method: 'POST',
                credentials: 'include',
              });
              unreadNotificationCount = 0;
              // キャッシュをクリアして次回のfetchで最新データを取得
              invalidateNotificationsCache();
              await clearNativeBadge();
              leftNavInstances.forEach((ln) => {
                if (typeof ln.setUnreadCount === 'function') {
                  ln.setUnreadCount(0);
                }
              });
            },
            onNavigateToPost: (postId) => {
              window.history.pushState({}, '', `/thread/${postId}`);
              navigateTo('thread', postId);
            },
          });

          // Create Right Panel
          const rightPanel = await lazyCreateRightPanel({
            onSearch: (query) => {
              console.log('Search:', query);
            },
            onFollowUser: (userId) => {
              console.log('Follow user:', userId);
            },
          });

          // Assemble layout
          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(notificationsPage.getElement());
          mainContainer.appendChild(rightPanel.getElement());

          app.appendChild(mainContainer);
          hidePageLoader();

          // Setup mobile left nav
          setupMobileLeftNav(leftNav.getElement());

          return;
        }

        // Handle settings page (within 3-column layout)
        if (view === 'settings') {
          currentView = 'settings';
          currentPostId = null;
          _currentUsername = null;
          currentTag = null;

          // Create main container for 3-column layout
          const mainContainer = document.createElement('div');
          mainContainer.className = 'main-container';

          // Create Left Nav
          const leftNav = await lazyCreateLeftNav({
            activeItem: 'settings',
            unreadCount: unreadNotificationCount,
            currentUser: currentUser || undefined,
            onNavigate: leftNavNavigateHandler,
            onSignIn: leftNavSignInHandler,
            onSignUp: leftNavSignUpHandler,
          });

          leftNavInstances.add(leftNav);

          // Create Settings Page (as main content)
          const settingsModule = await import('./components/SettingsPage.js');
          settingsPage = settingsModule.createSettingsPage({
            currentUser: currentUser || undefined,
          });

          // Load user data asynchronously
          const loadUserData = async () => {
            try {
              const userData = await getMe();
              if (userData && settingsPage) {
                const currentSettingsPage = settingsPage;
                // Recreate settings page with full user data
                const oldElement = currentSettingsPage.getElement();
                currentSettingsPage.destroy();
                settingsPage = settingsModule.createSettingsPage({
                  currentUser: userData.user as {
                    id: string;
                    username: string;
                    display_name?: string;
                    avatar_key?: string;
                  },
                });

                const newSettingsPage = settingsPage;
                // Wait for the next tick to ensure the element is in the DOM
                setTimeout(() => {
                  if (oldElement.parentNode) {
                    oldElement.parentNode.replaceChild(newSettingsPage.getElement(), oldElement);
                  } else {
                    const leftNavElement = mainContainer.children[0];
                    if (leftNavElement && mainContainer.children[1]) {
                      mainContainer.insertBefore(newSettingsPage.getElement(), mainContainer.children[1]);
                    }
                  }
                }, 0);
              }
            } catch (error) {
              console.error('Failed to load user data:', error);
            }
          };

          loadUserData();

          // Create Right Panel
          const rightPanel = await lazyCreateRightPanel({
            onSearch: (query) => {
              console.log('Search:', query);
            },
            onFollowUser: (userId) => {
              console.log('Follow user:', userId);
            },
          });

          // Assemble layout
          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(settingsPage.getElement());
          mainContainer.appendChild(rightPanel.getElement());

          app.appendChild(mainContainer);
          hidePageLoader();

          // Setup mobile left nav
          setupMobileLeftNav(leftNav.getElement());

          return;
        }

        // Create main container for timeline/thread views
        const mainContainer = document.createElement('div');
        mainContainer.className = 'main-container';

        if (view === 'thread' && postId) {
          // Thread page view
          console.log('Creating thread page for postId:', postId);
          currentView = 'thread';
          currentPostId = postId;

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app';
          const { createThreadPage } = await import('./components/ThreadPage.js');
          threadPage = createThreadPage({
            postId,
            sandboxOrigin,
            currentUser,
            unreadCount: unreadNotificationCount,
            onBack: () => {
              console.log('Back button clicked, returning to previous view');
              if (cachedContentComponent) {
                window.history.back();
              } else {
                window.history.pushState({}, '', '/home');
                navigateTo('timeline');
              }
            },
          });

          console.log('Thread page created, adding to container');
          mainContainer.appendChild(threadPage.getElement());
          console.log('Thread page added to DOM');

          // ThreadPage has its own LeftNav, find it and setup mobile functionality
          const threadLeftNav = threadPage.getElement().querySelector('.left-nav') as HTMLElement;
          if (threadLeftNav) {
            // Add thread page specific class for styling
            threadLeftNav.classList.add('thread-page-left-nav');
            setupMobileLeftNav(threadLeftNav);
          }

          // Create Right Panel
          const threadRightPanel = await lazyCreateRightPanel({
            onSearch: (query) => {
              console.log('Search:', query);
            },
            onFollowUser: (userId) => {
              console.log('Follow user:', userId);
            },
          });
          mainContainer.appendChild(threadRightPanel.getElement());
        } else {
          // Timeline view
          currentView = 'timeline';
          currentPostId = null;

          // Create Left Nav
          const leftNav = await lazyCreateLeftNav({
            activeItem: 'home',
            unreadCount: unreadNotificationCount,
            currentUser: currentUser || undefined,
            onNavigate: leftNavNavigateHandler,
            onSignIn: leftNavSignInHandler,
            onSignUp: leftNavSignUpHandler,
          });

          leftNavInstances.add(leftNav);

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app';

          if (cachedContentComponent?.view === 'timeline') {
            console.log('Restoring cached timeline');
            timeline = cachedContentComponent.component as Timeline;
            const scrollY = cachedContentComponent.scrollY;
            cachedContentComponent = null;

            requestAnimationFrame(() => {
              window.scrollTo(0, scrollY);
            });
          } else {
            // Create fresh timeline
            const { createTimeline } = await import('./components/Timeline.js');
            timeline = createTimeline({
              sandboxOrigin,
              currentUser,
            });

            // Listen for navigation events from timeline
            timeline.getElement().addEventListener('navigateToThread', (e: Event) => {
              const postId = (e as CustomEvent<{ postId: string }>).detail.postId;
              window.history.pushState({ postId }, '', `/thread/${postId}`);
              navigateTo('thread', postId);
            });

            // Listen for openLeftNav events from timeline (mobile swipe)
            timeline.getElement().addEventListener('openLeftNav', () => {
              const leftNavElement = document.querySelector('.left-nav') as HTMLElement;
              if (leftNavElement) {
                openLeftNav(leftNavElement);
              }
            });

            // Restore scroll position after timeline posts load
            timeline.getElement().addEventListener(
              'timelineReady',
              () => {
                if (savedScrollY > 0) {
                  const scrollY = savedScrollY;
                  savedScrollY = 0;
                  window.scrollTo(0, scrollY);
                }
              },
              { once: true },
            );
          }

          // Setup mobile left nav functionality
          setupMobileLeftNav(leftNav.getElement());

          // Create Right Panel
          const rightPanel = await lazyCreateRightPanel({
            onSearch: (query) => {
              console.log('Search:', query);
              // Handle search here
            },
            onFollowUser: (userId) => {
              console.log('Follow user:', userId);
              // Handle follow here
            },
          });

          // Assemble layout
          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(timeline.getElement());
          mainContainer.appendChild(rightPanel.getElement());
        }

        app.appendChild(mainContainer);
        hidePageLoader();
      } catch (e) {
        console.error('Navigation error:', e);
        showPageLoaderFailure();
      }
    };

    // Shared LeftNav callbacks to avoid duplication across all createLeftNav calls
    const leftNavNavigateHandler = async (item: string): Promise<void> => {
      if (item === 'home') {
        window.history.pushState({}, '', '/home');
        navigateTo('timeline');
      } else if (item === 'explore') {
        window.history.pushState({}, '', '/explore');
        navigateTo('explore');
      } else if (item === 'arcade') {
        window.history.pushState({}, '', '/arcade');
        navigateTo('arcade');
      } else if (item === 'notifications') {
        window.history.pushState({}, '', '/notifications');
        navigateTo('notifications');
      } else if (item === 'bookmarks') {
        window.history.pushState({}, '', '/bookmarks');
        navigateTo('bookmarks');
      } else if (item === 'settings') {
        window.history.pushState({}, '', '/settings');
        navigateTo('settings');
      } else if (item === 'profile') {
        if (!currentUser) {
          window.history.pushState({}, '', '/arcade');
          navigateTo('arcade');
          return;
        }
        window.history.pushState({}, '', `/profile/${currentUser.username}`);
        navigateTo('profile', undefined, currentUser.username);
      }
    };

    const leftNavSignInHandler = (): void => {
      window.history.pushState({}, '', '/login');
      navigateTo('login');
    };

    const leftNavSignUpHandler = (): void => {
      window.history.pushState({}, '', '/register');
      navigateTo('register');
    };

    async function safeNavigate(
      view: string,
      postId?: string,
      username?: string,
      tag?: string,
      adminTab?: string,
      searchQuery?: string,
      searchType?: string,
    ) {
      try {
        await navigateTo(
          view as
            | 'timeline'
            | 'thread'
            | 'login'
            | 'register'
            | 'profile'
            | 'explore'
            | 'search'
            | 'notifications'
            | 'bookmarks'
            | 'terms'
            | 'privacy'
            | 'about'
            | 'docs'
            | 'admin'
            | 'settings'
            | 'arcade',
          postId,
          username,
          tag,
          adminTab as 'alerts' | 'hidden' | 'users' | 'counter',
          searchQuery,
          searchType as 'posts' | 'users' | 'arcade',
        );
      } catch (e) {
        console.error('Navigation failed:', e);
        // Show error on the loading overlay if it's visible, otherwise reload
        showPageLoaderFailure();
      }
    }

    // Handle browser back/forward
    window.addEventListener('popstate', async (e) => {
      const route = parseCurrentRoute();
      if (route) {
        await safeNavigate(
          route.view,
          route.postId || undefined,
          route.username || undefined,
          route.tag || undefined,
          route.adminTab || undefined,
          route.searchQuery || undefined,
          route.searchType || undefined,
        );
      }
    });

    // Handle SPA navigation events
    window.addEventListener('spaNavigate', async (e: Event) => {
      const detail = (
        e as CustomEvent<{
          view: string;
          postId?: string;
          username?: string;
          tag?: string;
          adminTab?: string;
          searchQuery?: string;
          searchType?: string;
        }>
      ).detail;
      await safeNavigate(
        detail.view,
        detail.postId,
        detail.username,
        detail.tag,
        detail.adminTab,
        detail.searchQuery,
        detail.searchType,
      );
    });

    // Initial navigation
    console.log('DOM Content Loaded, starting initial routing...');

    const initialRoute = parseCurrentRoute();
    console.log('Initial route:', initialRoute);
    if (initialRoute) {
      await safeNavigate(
        initialRoute.view,
        initialRoute.postId || undefined,
        initialRoute.username || undefined,
        initialRoute.tag || undefined,
        initialRoute.adminTab || undefined,
        initialRoute.searchQuery || undefined,
        initialRoute.searchType || undefined,
      );
    }

    // Defer non-critical initialization to after the first paint
    const deferInit = (fn: () => void) => {
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(fn, { timeout: 3000 });
      } else {
        setTimeout(fn, 3000);
      }
    };

    // Register Service Worker for Web Push (browser) — non-blocking
    initializeWebPush(isCapacitorNative).catch(() => {});

    deferInit(async () => {
      // Defer platform-specific notification init (not critical for first paint)
      initNativeNotify().catch(() => {});
      initNativePushRegistration().catch(() => {});

      if (!canRunFlaxiaNode()) return;

      // Flaxia owns the consent UI. `initCrowdNode` asks us back only while the
      // decision is unset; the node bundle owns persistence and lifecycle.
      try {
        await initCrowdNode((controls) => {
          showCrowdConsentModal({
            onAccept: () => {
              controls.accept();
              notifyCrowdConsentChanged();
            },
            onReject: () => {
              controls.reject();
              notifyCrowdConsentChanged();
            },
          });
        });
      } catch (e) {
        // A missing/unreachable node bundle must never break app init.
        console.error('Failed to initialize Crowd node:', e);
      }
    });
  }
});
