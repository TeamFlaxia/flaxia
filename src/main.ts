import './styles/main.css';
import './styles/redesign/foundation.css';
import './styles/redesign/shell.css';
import './styles/redesign/timeline.css';
import './styles/redesign/composer.css';
import './styles/redesign/overlays.css';
import './styles/redesign/pages.css';
import './styles/redesign/maps.css';
import './styles/redesign/mail.css';
import './styles/redesign/command.css';
import './styles/redesign/rail.css';
import './styles/redesign/motion.css';
import type { ArcadePageHandle } from './components/ArcadePage.js';
import type { BookmarksPage } from './components/BookmarksPage.js';
import { initCommandPalette, registerCommandActions } from './components/CommandPalette.js';
import { showCrowdConsentModal } from './components/CrowdConsentModal.js';
import type { ExplorePage } from './components/ExplorePage.js';
import type { LeftNav } from './components/LeftNav.js';
import type { NotificationsPage } from './components/NotificationsPage.js';
import type { ThreadPage } from './components/ThreadPage.js';
import type { Timeline } from './components/Timeline.js';
import { maybePromptAppUpdate } from './lib/app-update.js';
import { clearMeCache, getMe } from './lib/auth-cache.js';
import { retryPendingCredentialChange } from './lib/auth-credential-operation.js';
import { retryPendingDeletion } from './lib/auth-deletion.js';
import { resolveAuthRedirect } from './lib/auth-guard.js';
import { beginNativeAuthRedirect, initNativeAuthCallback } from './lib/auth-redirect.js';
import type { BottomNavDeps } from './lib/bottom-nav-setup.js';
import { ensureBottomNav, getBottomNav } from './lib/bottom-nav-setup.js';
import { initContentProtection } from './lib/content-protection.js';
import { canRunFlaxiaNode, initCrowdNode, notifyCrowdConsentChanged } from './lib/crowd-node.js';
import { getLocale, initI18n, t } from './lib/i18n.js';
import { lazyCreateLeftNav, lazyCreateRightPanel, lazyUpdateLeftNavUser } from './lib/lazy-nav.js';
import { closeLeftNav, openLeftNav, removeLeftNavOverlay, setupMobileLeftNav } from './lib/left-nav-drawer.js';
import type { LeftNavHandlers } from './lib/left-nav-handlers.js';
import { createLeftNavHandlers } from './lib/left-nav-handlers.js';
import { isModalOpen } from './lib/modal-state.js';
import { API_ORIGIN, isCapacitorNativePlatform, isNativeApp, isTauriNativePlatform } from './lib/native-api.js';
import { createNativeFetch } from './lib/native-fetch.js';
import {
  clearNativeBadge,
  initNativeNotify,
  initNativePushRegistration,
  notifyViaTauri,
  setNativeBadge,
} from './lib/native-notify.js';
import { initOfflineGames } from './lib/native-offline-games.js';
import { fetchNotifications, invalidateNotificationsCache } from './lib/notifications-api.js';
import { createOfflineFetch } from './lib/offline-fetch.js';
import { isOffline, setOffline } from './lib/offline-status.js';
import { createOfflineStore } from './lib/offline-store.js';
import { hidePageLoader, showPageLoader, showPageLoaderFailure } from './lib/page-loader.js';
import { initPerformanceMonitoring } from './lib/performance.js';
import { createPushSocket } from './lib/push-socket.js';
import { parseCurrentRoute, type RouteInfo, type RouteView } from './lib/router.js';
import { goBackInSpaOr, pushSpaHistory } from './lib/spa-history.js';
import { getResolvedTheme, initTheme, setTheme } from './lib/theme.js';
import { showToast } from './lib/toast.js';
import { autoUnlockVault, lockVaultSession } from './lib/vault/auto-unlock.js';
import { viewToBottomNavId } from './lib/view-nav.js';
import { initializeWebPush } from './lib/web-push.js';

interface PageComponent {
  getElement(): HTMLElement;
  destroy(): void;
}

// Initialize performance monitoring
initPerformanceMonitoring();

// Capture Capacitor's patched fetch; local assets stay in the bundle.
const nativeClient = isNativeApp();
const nativeFetch = createNativeFetch(window.fetch.bind(window));
// A real network request that bypasses the offline cache, so a stale
// navigator.onLine value cannot latch the app offline.
const probeConnectivity = async (): Promise<boolean> => {
  try {
    const response = await nativeFetch('/api/me', {
      cache: 'no-store',
      credentials: 'include',
      // Match the offline layer's 15s probe deadline: a probe stricter than
      // a real read would report "offline" while reads still succeed.
      signal: AbortSignal.timeout(15000),
    });
    try {
      await response.body?.cancel();
    } catch {
      // The response already proved connectivity.
    }
    return true;
  } catch {
    return false;
  }
};
window.fetch = nativeClient
  ? createOfflineFetch(nativeFetch, {
      store: createOfflineStore(),
      baseUrl: window.location.href,
      apiOrigin: API_ORIGIN,
      isOnline: () => navigator.onLine !== false,
      setOffline,
      probe: probeConnectivity,
    })
  : nativeFetch;
if (nativeClient) window.fetch = initOfflineGames(nativeFetch).wrap(window.fetch);

// Initialize content protection (right-click, drag, keyboard shortcuts)
initContentProtection();

// Initialize theme (keeps system theme in sync during SPA navigation)
initTheme();

// Start i18n loading early (parallelizes the network fetch with script parsing/css loading)
initI18n();

// Basic app initialization
document.addEventListener('DOMContentLoaded', async () => {
  initNativeAuthCallback();
  if (await retryPendingDeletion()) clearMeCache();
  if ((await retryPendingCredentialChange()) === 'committed') clearMeCache();
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
      | 'child-safety'
      | 'about'
      | 'docs'
      | 'admin'
      | 'settings'
      | 'arcade'
      | 'maps'
      | 'billing-success'
      | 'billing-canceled'
      | 'download'
      | 'translate'
      | 'mail'
      | 'mail-thread'
      | 'mail-compose'
      | 'mail-settings' = 'timeline';
    let currentPostId: string | null = null;
    let _currentUsername: string | null = null;
    let currentTag: string | null = null;
    let currentAdminTab: 'analytics' | 'alerts' | 'hidden' | 'users' | 'ads' | 'counter' = 'alerts';
    let timeline: Timeline | null = null;
    let threadPage: ThreadPage | null = null;
    let savedScrollY = 0;
    let profilePage: PageComponent | null = null;
    let explorePage: ExplorePage | null = null;
    let legalPage: PageComponent | null = null;
    let docsPage: PageComponent | null = null;
    let notificationsPage: NotificationsPage | null = null;
    let settingsPage: ReturnType<typeof import('./components/SettingsPage.js').createSettingsPage> | null = null;
    let arcadePage: ArcadePageHandle | null = null;
    let mapsPage: PageComponent | null = null;
    let searchPage: PageComponent | null = null;
    let bookmarksPage: BookmarksPage | null = null;
    let downloadPage: PageComponent | null = null;
    let translatePage: { getElement: () => HTMLElement; destroy: () => void } | null = null;
    let mailPage: PageComponent | null = null;
    let mailSettingsPage: PageComponent | null = null;
    let mailThreadPage: PageComponent | null = null;
    let mailComposePage: PageComponent | null = null;
    let cachedContentComponent: { view: string; component: unknown; scrollY: number } | null = null;
    let adminLayout:
      | (PageComponent & { updateMainContent: (el: HTMLElement) => void; setAccessDenied: () => void })
      | null = null;
    let adminAlertsTab: PageComponent | null = null;
    let adminHiddenTab: PageComponent | null = null;
    let adminUsersTab: PageComponent | null = null;
    let adminAdsTab: PageComponent | null = null;
    const leftNavInstances: Set<LeftNav> = new Set();

    /** Deps for the mobile bottom bar (see src/lib/bottom-nav-setup.ts). */
    const bottomNavDeps = (): BottomNavDeps => ({
      navigate: navigateTo,
      getCurrentUser: () => currentUser,
    });
    let currentUser: {
      username: string;
      id: string;
      email?: string;
      display_name?: string;
      avatar_key?: string;
      badge_type?: string | null;
      name_color?: string | null;
    } | null = null;
    let unreadNotificationCount = 0;
    let mailUnreadCount = 0;

    // Native notification platforms (see src/lib/native-notify.ts)

    /// WebSocket 経由のプッシュ通知を受け取り OS 通知を表示する
    /// (接続管理・backoff は src/lib/push-socket.ts)
    const isCapacitorNative = isCapacitorNativePlatform();

    const pushSocket = createPushSocket(
      () => {
        const host = window.location.host;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${host}/api/ws/notifications`;
      },
      {
        onOpen: () => {
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
    // WebSocket 経由のプッシュ通知を受け取り OS 通知を表示する
    // (接続管理・backoff は src/lib/push-socket.ts)
    // Capacitor ライフサイクル: アプリ復帰時に WebSocket 再接続
    if (isCapacitorNative) {
      try {
        const { App } = await import('@capacitor/app');
        await App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) {
            // フォアグラウンド復帰時、WebSocket を再接続 & 未読カウント即時取得
            // (connect は接続中なら何もしない)
            if (!nativeClient) pushSocket.connect();
            refreshNotificationBadges();
          }
        });
      } catch {
        // Optional Capacitor lifecycle API: no app-state hook on this platform.
      }
    }

    // Offline / online をトーストで統一表示する。ブラウザのイベントだけでなく、
    // 誤った navigator.onLine を補正するバックグラウンド probe の結果も反映する。
    window.addEventListener('flaxiaConnectivityChange', (event) => {
      const { offline } = (event as CustomEvent<{ offline: boolean }>).detail;
      if (offline) showToast(t('common.offline'), true);
      else showToast(t('common.online'));
    });

    const updateBadgeUI = () => {
      leftNavInstances.forEach((leftNav) => {
        if (typeof leftNav.setUnreadCount === 'function') {
          leftNav.setUnreadCount(unreadNotificationCount);
        }
        if (typeof leftNav.setMailUnreadCount === 'function') {
          leftNav.setMailUnreadCount(mailUnreadCount);
        }
      });

      setNativeBadge(unreadNotificationCount);
    };

    const refreshMailUnreadCount = async () => {
      if (!currentUser) {
        mailUnreadCount = 0;
        updateBadgeUI();
        return;
      }
      const { getMailUnreadCount } = await import('./lib/mail/api.js');
      mailUnreadCount = await getMailUnreadCount().catch(() => 0);
      updateBadgeUI();
    };

    let previousNotificationIds: Set<string> | null = null;
    const refreshNotificationBadges = async () => {
      const data = await fetchNotifications();
      // Native HTTP owns Tauri's session jar; browser sockets cannot share it.
      if (isTauriNativePlatform()) {
        if (previousNotificationIds) {
          for (const notification of data.notifications) {
            if (!notification.read && !previousNotificationIds.has(notification.id)) {
              notifyViaTauri('Flaxia', notification.post_text_preview);
            }
          }
        }
        previousNotificationIds = new Set(data.notifications.map((notification) => notification.id));
      }
      unreadNotificationCount = data.unread_count || 0;
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
            name_color?: string | null;
          };
          currentUser = {
            id: userData.id,
            username: userData.username,
            display_name: userData.display_name,
            avatar_key: userData.avatar_key,
            badge_type: userData.badge_type,
            name_color: userData.name_color,
          };

          // Update all existing LeftNav instances with new user data
          leftNavInstances.forEach((leftNav) => {
            lazyUpdateLeftNavUser(leftNav, currentUser);
          });

          // Create/update the mobile bottom nav with the signed-in user
          (await ensureBottomNav(bottomNavDeps())).updateUser(currentUser);

          // 初回の未読通知数を取得（以降は WebSocket でリアルタイム更新）
          refreshNotificationBadges();
          void refreshMailUnreadCount();
          // Reopen a remembered vault after reload. The device key is
          // non-extractable and origin-bound; a device without one stays
          // locked and gets the inline unlock form where it is needed.
          autoUnlockVault();

          // WebSocket でリアルタイム通知受信（全プラットフォーム）
          if (!nativeClient) pushSocket.connect();

          return true;
        }
      } catch {
        // Guest or expired session: fall through to the signed-out state.
      }

      // Clear user state when not authenticated
      const wasLoggedIn = currentUser !== null;
      const previousUsername = currentUser?.username ?? null;
      currentUser = null;
      previousNotificationIds = null;
      mailUnreadCount = 0;
      if (wasLoggedIn) lockVaultSession();

      // Update all existing LeftNav instances to remove user area
      leftNavInstances.forEach((leftNav) => {
        lazyUpdateLeftNavUser(leftNav, null);
      });

      // Create/update the mobile bottom nav for the guest state
      (await ensureBottomNav(bottomNavDeps())).updateUser(null);

      // If user was logged in and now is not, they were logged out
      if (wasLoggedIn) {
        let frozenUsername: string | null = null;
        if (previousUsername) {
          try {
            const response = await fetch(`/api/users/${encodeURIComponent(previousUsername)}`);
            if (response.ok) {
              const data = (await response.json()) as { user?: { frozen?: boolean } };
              if (data.user?.frozen) frozenUsername = previousUsername;
            }
          } catch {
            // Fall through to the normal login redirect when profile state is unavailable.
          }
        }
        if (frozenUsername) {
          window.history.replaceState({}, '', `/users/${encodeURIComponent(frozenUsername)}`);
          navigateTo('profile', undefined, frozenUsername);
          return false;
        }

        window.history.replaceState({}, '', '/login');
        navigateTo('login');
        return false;
      }

      return false;
    };

    if (nativeClient) {
      window.setInterval(() => {
        if (currentUser && !isOffline()) void refreshNotificationBadges();
      }, 60000);
      // A probe can recover connectivity without the browser firing `online`,
      // so both signals refresh the session and timeline. The cooldown keeps a
      // browser online event and a probe success from refreshing twice.
      let lastReconnectAt = 0;
      const reconnect = async () => {
        const now = Date.now();
        if (now - lastReconnectAt < 1000) return;
        lastReconnectAt = now;
        clearMeCache();
        await checkAuth();
        timeline?.refresh();
      };
      window.addEventListener('online', () => void reconnect());
      window.addEventListener('flaxiaConnectivityChange', (event) => {
        if (!(event as CustomEvent<{ offline: boolean }>).detail.offline) void reconnect();
      });
    }

    // Fetch notifications (see src/lib/notifications-api.ts)

    // Mobile left nav overlay management (see src/lib/left-nav-drawer.ts)

    // Auth guard - redirect to login if not authenticated (only for protected routes)
    // Route decisions live in src/lib/auth-guard.ts; checkAuth owns the session.
    const requireAuth = async () => {
      const isAuthenticated = await checkAuth();
      const redirect = resolveAuthRedirect(window.location.pathname, isAuthenticated);
      if (!redirect) return true;
      // Use replaceState so the browser back button doesn't return to the
      // protected route (which would just redirect again, causing an infinite loop)
      window.history.replaceState({}, '', redirect.path);
      navigateTo(redirect.view);
      return false;
    };

    // Main landmark: the content column carries role="main" so assistive tech can
    // skip the shell's nav and aside columns (the page itself stays unchanged).
    const markMainContent = (content: HTMLElement): HTMLElement => {
      content.setAttribute('role', 'main');
      return content;
    };

    // URL routing (see src/lib/router.ts)

    // Page loading overlay (see src/lib/page-loader.ts)

    // Navigate to view
    const navigateTo = async (
      view: RouteView,
      postId?: string,
      username?: string,
      tag?: string,
      adminTab?: 'analytics' | 'alerts' | 'hidden' | 'users' | 'ads' | 'counter',
      searchQuery?: string,
      searchType?: 'posts' | 'users' | 'arcade',
    ) => {
      // Authentication UI lives on auth.flaxia.app. A full navigation keeps the
      // login flow out of this SPA and returns through /api/auth/callback.
      if (view === 'login' || view === 'register') {
        const here = `${window.location.pathname}${window.location.search}`;
        const returnTo = here === '/login' || here === '/register' ? '/home' : here;
        if (await beginNativeAuthRedirect(returnTo, view)) return;
        if (nativeClient) {
          // In the app WebView there is no usable /api/auth/start: the origin
          // is capacitor://localhost or https://localhost, and navigating
          // there strands the user outside the app shell. Stay and explain.
          console.warn('[auth] native sign-in browser could not be opened');
          showToast(t('auth.external_failed'), true);
          return;
        }
        const query = new URLSearchParams({
          return_to: returnTo,
          lang: getLocale(),
          theme: getResolvedTheme(),
        });
        if (view === 'register') query.set('mode', 'register');
        window.location.assign(`/api/auth/start?${query.toString()}`);
        return;
      }

      // Close mobile nav if open
      closeLeftNav();

      // Sync active item on the mobile bottom nav
      const syncedNav = getBottomNav();
      if (syncedNav) {
        const navId = viewToBottomNavId(view);
        if (navId) syncedNav.setActiveItem(navId);
      }

      {
        // Auth guard for protected routes
        const isAuthenticated = await requireAuth();
        if (!isAuthenticated) {
          return; // Auth guard will redirect to login
        }

        // Cache current view when navigating to thread or arcade (for back navigation with preserved content)
        if ((view === 'thread' || view === 'arcade') && currentView !== view) {
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
          } else if (currentView === 'bookmarks' && bookmarksPage) {
            cachedContentComponent = { view: 'bookmarks', component: bookmarksPage, scrollY: window.scrollY };
            bookmarksPage = null;
          } else if (currentView === 'notifications' && notificationsPage) {
            cachedContentComponent = { view: 'notifications', component: notificationsPage, scrollY: window.scrollY };
            notificationsPage = null;
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
          timeline.destroy();
          timeline = null;
        }
        if (threadPage) {
          threadPage.destroy();
          threadPage = null;
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
        if (mapsPage) {
          mapsPage.destroy();
          mapsPage = null;
        }
        if (searchPage) {
          searchPage.destroy();
          searchPage = null;
        }
        if (downloadPage) {
          downloadPage.destroy();
          downloadPage = null;
        }
        if (translatePage) {
          translatePage.destroy();
          translatePage = null;
        }
        if (mailPage) {
          mailPage.destroy();
          mailPage = null;
        }
        if (mailSettingsPage) {
          mailSettingsPage.destroy();
          mailSettingsPage = null;
        }
        if (mailThreadPage) {
          mailThreadPage.destroy();
          mailThreadPage = null;
        }
        if (mailComposePage) {
          mailComposePage.destroy();
          mailComposePage = null;
        }
      }
      showPageLoader();
      app.innerHTML = '';

      // Wrap rendering in try-catch so errors don't leave the loader stuck
      try {
        // Handle legal pages (public, no auth required, no layout)
        if (view === 'terms' || view === 'privacy' || view === 'child-safety' || view === 'about') {
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

        // Handle mail pages (requires auth, within the standard 3-column layout)
        if (view === 'mail' || view === 'mail-settings' || view === 'mail-thread' || view === 'mail-compose') {
          currentView = view;
          currentPostId = postId || null;
          _currentUsername = null;
          currentTag = null;

          const mainContainer = document.createElement('div');
          mainContainer.className = 'main-container';

          const leftNav = await lazyCreateLeftNav({
            activeItem: 'mail',
            unreadCount: unreadNotificationCount,
            mailUnreadCount,
            currentUser: currentUser || undefined,
            ...leftNavHandlers(),
          });
          leftNavInstances.add(leftNav);

          const rightPanel = await lazyCreateRightPanel();
          mainContainer.appendChild(leftNav.getElement());

          if (view === 'mail-settings') {
            const { createMailSettingsPage } = await import('./components/MailSettingsPage.js');
            mailSettingsPage = createMailSettingsPage({
              currentUser: currentUser ? { id: currentUser.id, username: currentUser.username } : null,
            });
            mainContainer.appendChild(mailSettingsPage.getElement());
          } else if (view === 'mail-thread') {
            const { createMailThreadPage } = await import('./components/MailThreadPage.js');
            mailThreadPage = createMailThreadPage({
              currentUser: currentUser ? { id: currentUser.id, username: currentUser.username } : null,
              threadId: postId || '',
            });
            mainContainer.appendChild(mailThreadPage.getElement());
          } else if (view === 'mail-compose') {
            const { createMailComposePage } = await import('./components/MailComposePage.js');
            const { takePendingDraftId } = await import('./lib/mail/navigation.js');
            mailComposePage = createMailComposePage({
              currentUser: currentUser ? { id: currentUser.id, username: currentUser.username } : null,
              draftId: takePendingDraftId() || undefined,
            });
            mainContainer.appendChild(mailComposePage.getElement());
          } else {
            const { createMailPage } = await import('./components/MailPage.js');
            mailPage = createMailPage({
              currentUser: currentUser ? { id: currentUser.id, username: currentUser.username } : null,
            });
            mainContainer.appendChild(mailPage.getElement());
          }

          mainContainer.appendChild(rightPanel.getElement());
          app.appendChild(mainContainer);
          hidePageLoader();
          setupMobileLeftNav(leftNav.getElement());
          return;
        }

        // Handle app download page (public, within the standard 3-column layout)
        if (view === 'download') {
          currentView = 'download';
          currentPostId = null;
          _currentUsername = null;
          currentTag = null;

          const mainContainer = document.createElement('div');
          mainContainer.className = 'main-container';

          const leftNav = await lazyCreateLeftNav({
            activeItem: 'download',
            unreadCount: unreadNotificationCount,
            mailUnreadCount,
            currentUser: currentUser || undefined,
            ...leftNavHandlers(),
          });

          leftNavInstances.add(leftNav);

          const { createDownloadPage } = await import('./components/DownloadPage.js');
          downloadPage = createDownloadPage();

          const rightPanel = await lazyCreateRightPanel({
            onSearch: (query) => {
              console.log('Search:', query);
            },
            onFollowUser: (userId) => {
              console.log('Follow user:', userId);
            },
          });

          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(downloadPage.getElement());
          mainContainer.appendChild(rightPanel.getElement());

          app.appendChild(mainContainer);
          hidePageLoader();

          setupMobileLeftNav(leftNav.getElement());

          return;
        }

        // Handle translate page (public, within the standard 3-column layout)
        if (view === 'translate') {
          currentView = 'translate';
          currentPostId = null;
          _currentUsername = null;
          currentTag = null;

          const mainContainer = document.createElement('div');
          mainContainer.className = 'main-container';

          const leftNav = await lazyCreateLeftNav({
            activeItem: 'translate',
            unreadCount: unreadNotificationCount,
            mailUnreadCount,
            currentUser: currentUser || undefined,
            ...leftNavHandlers(),
          });

          leftNavInstances.add(leftNav);

          const { createTranslatePage } = await import('./components/TranslatePage.js');
          translatePage = createTranslatePage();

          const rightPanel = await lazyCreateRightPanel();

          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(markMainContent(translatePage.getElement()));
          mainContainer.appendChild(rightPanel.getElement());

          app.appendChild(mainContainer);
          hidePageLoader();

          setupMobileLeftNav(leftNav.getElement());

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

          let adminAccessGranted = false;
          const onTabChange = async (tab: 'analytics' | 'alerts' | 'hidden' | 'users' | 'ads' | 'counter') => {
            if (!adminAccessGranted) return;
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

          try {
            const access = await fetch('/api/admin/access', { credentials: 'include', cache: 'no-store' });
            if (!access.ok) {
              adminLayout.setAccessDenied();
              return;
            }
          } catch {
            adminLayout.setAccessDenied();
            return;
          }

          adminAccessGranted = true;
          const renderAdminTab = async (tab: 'analytics' | 'alerts' | 'hidden' | 'users' | 'ads' | 'counter') => {
            if (!adminLayout) return;

            if (tab === 'analytics') {
              const { createAdminAnalyticsTab } = await import('./components/AdminAnalyticsTab.js');
              adminLayout.updateMainContent(createAdminAnalyticsTab().getElement());
            } else if (tab === 'alerts') {
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
            mailUnreadCount,
            currentUser: currentUser || undefined,
            ...leftNavHandlers(),
          });

          leftNavInstances.add(leftNav);

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app';

          if (cachedContentComponent?.view === 'explore') {
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
          const rightPanel = await lazyCreateRightPanel();

          // Assemble layout
          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(markMainContent(explorePage.getElement()));
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
            mailUnreadCount,
            currentUser: currentUser || undefined,
            ...leftNavHandlers(),
          });

          leftNavInstances.add(leftNav);

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app';

          if (cachedContentComponent?.view === 'search') {
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

          const rightPanel = await lazyCreateRightPanel();

          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(markMainContent(searchPage.getElement()));
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
            mailUnreadCount,
            currentUser: currentUser || undefined,
            ...leftNavHandlers(),
          });

          leftNavInstances.add(leftNav);

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app';

          const { createArcadePage } = await import('./components/ArcadePage.js');
          arcadePage = createArcadePage({
            sandboxOrigin,
            currentUser,
            initialGameId: currentPostId || undefined,
            onBack: () => {
              goBackInSpaOr(() => {
                window.history.replaceState({}, '', '/home');
                navigateTo('timeline');
              });
            },
          });

          // Create Right Panel
          const rightPanel = await lazyCreateRightPanel();

          // Assemble layout
          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(markMainContent(arcadePage.getElement()));
          mainContainer.appendChild(rightPanel.getElement());

          app.appendChild(mainContainer);
          hidePageLoader();

          // Setup mobile left nav
          setupMobileLeftNav(leftNav.getElement());

          return;
        }

        if (view === 'maps') {
          currentView = 'maps';
          currentPostId = null;
          _currentUsername = null;
          currentTag = null;

          const mainContainer = document.createElement('div');
          mainContainer.className = 'main-container';

          const leftNav = await lazyCreateLeftNav({
            activeItem: 'maps',
            unreadCount: unreadNotificationCount,
            mailUnreadCount,
            currentUser: currentUser || undefined,
            ...leftNavHandlers(),
          });

          leftNavInstances.add(leftNav);

          const { createMapsPage } = await import('./components/MapsPage.js');
          mapsPage = createMapsPage();

          const rightPanel = await lazyCreateRightPanel();

          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(markMainContent(mapsPage.getElement()));
          mainContainer.appendChild(rightPanel.getElement());

          app.appendChild(mainContainer);
          hidePageLoader();

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
            mailUnreadCount,
            currentUser: currentUser || undefined,
            ...leftNavHandlers(),
          });

          leftNavInstances.add(leftNav);

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app';

          if (cachedContentComponent?.view === 'profile') {
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
          const rightPanel = await lazyCreateRightPanel();

          // Assemble layout
          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(markMainContent(profilePage.getElement()));
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
            mailUnreadCount,
            currentUser: currentUser || undefined,
            ...leftNavHandlers(),
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
          mainContainer.appendChild(markMainContent(bookmarksPage.getElement()));
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
            mailUnreadCount,
            currentUser: currentUser || undefined,
            ...leftNavHandlers(),
          });

          leftNavInstances.add(leftNav);

          // Create Notifications Page. Always rebuild from the freshly fetched
          // data (only the scroll position is restored) so notifications that
          // arrived while a thread/Arcade was open are not lost.
          let notificationsScrollY = 0;
          if (cachedContentComponent?.view === 'notifications') {
            notificationsScrollY = cachedContentComponent.scrollY;
            (cachedContentComponent.component as NotificationsPage).destroy();
            cachedContentComponent = null;
          }
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
              pushSpaHistory(`/thread/${postId}`, { postId });
              navigateTo('thread', postId);
            },
          });

          requestAnimationFrame(() => {
            window.scrollTo(0, notificationsScrollY);
          });

          // Create Right Panel
          const rightPanel = await lazyCreateRightPanel();

          // Assemble layout
          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(markMainContent(notificationsPage.getElement()));
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
            mailUnreadCount,
            currentUser: currentUser || undefined,
            ...leftNavHandlers(),
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
                const initialCategory = currentSettingsPage.getActiveCategory();
                currentSettingsPage.destroy();
                settingsPage = settingsModule.createSettingsPage({
                  initialCategory,
                  currentUser: userData.user as {
                    id: string;
                    username: string;
                    display_name?: string;
                    avatar_key?: string;
                  },
                });

                const newSettingsElement = markMainContent(settingsPage.getElement());
                // Wait for the next tick to ensure the element is in the DOM
                setTimeout(() => {
                  if (oldElement.parentNode) {
                    oldElement.parentNode.replaceChild(newSettingsElement, oldElement);
                  } else {
                    const leftNavElement = mainContainer.children[0];
                    if (leftNavElement && mainContainer.children[1]) {
                      mainContainer.insertBefore(newSettingsElement, mainContainer.children[1]);
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
          const rightPanel = await lazyCreateRightPanel();

          // Assemble layout
          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(markMainContent(settingsPage.getElement()));
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
              goBackInSpaOr(() => {
                window.history.replaceState({}, '', '/home');
                navigateTo('timeline');
              });
            },
          });

          // ThreadPage owns the content column inside its own three-column shell.
          const threadMainContent = threadPage.getElement().querySelector('.thread-main-content');
          if (threadMainContent instanceof HTMLElement) markMainContent(threadMainContent);
          mainContainer.appendChild(threadPage.getElement());

          // ThreadPage has its own LeftNav, find it and setup mobile functionality
          const threadLeftNav = threadPage.getElement().querySelector('.left-nav') as HTMLElement;
          if (threadLeftNav) {
            // Add thread page specific class for styling
            threadLeftNav.classList.add('thread-page-left-nav');
            setupMobileLeftNav(threadLeftNav);
          }

          // Create Right Panel
          const threadRightPanel = await lazyCreateRightPanel();
          mainContainer.appendChild(threadRightPanel.getElement());
        } else {
          // Timeline view
          currentView = 'timeline';
          currentPostId = null;

          // Create Left Nav
          const leftNav = await lazyCreateLeftNav({
            activeItem: 'home',
            unreadCount: unreadNotificationCount,
            mailUnreadCount,
            currentUser: currentUser || undefined,
            ...leftNavHandlers(),
          });

          leftNavInstances.add(leftNav);

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app';

          if (cachedContentComponent?.view === 'timeline') {
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
            // PostCard emits spaNavigate directly; no duplicate listener here.

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
          const rightPanel = await lazyCreateRightPanel();

          // Assemble layout
          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(markMainContent(timeline.getElement()));
          mainContainer.appendChild(rightPanel.getElement());
        }

        app.appendChild(mainContainer);
        hidePageLoader();
      } catch (e) {
        console.error('Navigation error:', e);
        showPageLoaderFailure();
      }
    };

    // Shared LeftNav callbacks (see src/lib/left-nav-handlers.ts)
    const leftNavHandlers = (): LeftNavHandlers =>
      createLeftNavHandlers({
        navigate: navigateTo,
        getCurrentUsername: () => currentUser?.username ?? null,
      });

    async function safeNavigate(
      view: RouteView,
      postId?: string,
      username?: string,
      tag?: string,
      adminTab?: RouteInfo['adminTab'],
      searchQuery?: string,
      searchType?: RouteInfo['searchType'],
    ) {
      try {
        await navigateTo(view, postId, username, tag, adminTab, searchQuery, searchType);
      } catch (e) {
        console.error('Navigation failed:', e);
        // Show error on the loading overlay if it's visible, otherwise reload
        showPageLoaderFailure();
      }
    }

    // Handle browser back/forward. Native Android back first traverses SPA
    // history; the OS exits only when Capacitor has no in-app history to pop.
    if (isCapacitorNative) {
      void import('@capacitor/app')
        .then(({ App }) =>
          App.addListener('backButton', ({ canGoBack }) => {
            if (canGoBack || window.history.length > 1) {
              window.history.back();
            } else {
              void App.exitApp();
            }
          }),
        )
        .catch((error: unknown) => console.warn('Native back handling unavailable:', error));
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
          view: RouteView;
          postId?: string;
          username?: string;
          tag?: string;
          adminTab?: RouteInfo['adminTab'];
          searchQuery?: string;
          searchType?: RouteInfo['searchType'];
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
    const initialRoute = parseCurrentRoute();
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

    // Command palette (⌘K / Ctrl+K) — Obsidian-style quick switcher.
    initCommandPalette();
    const openComposerFromShell = () => {
      const nav = leftNavInstances.values().next().value as { openComposer?: () => void } | undefined;
      if (nav?.openComposer) nav.openComposer();
      else document.querySelector<HTMLTextAreaElement>('.composer-textarea')?.focus();
    };
    registerCommandActions(() => {
      const navigationGroup = t('command.group_navigation');
      const actionGroup = t('command.group_actions');
      const actions: Array<{
        id: string;
        label: string;
        group: string;
        hint?: string;
        keywords?: string;
        run: () => void;
      }> = [
        {
          id: 'home',
          label: t('nav.home'),
          group: navigationGroup,
          keywords: 'home timeline',
          run: () => {
            pushSpaHistory('/home');
            void navigateTo('timeline');
          },
        },
        {
          id: 'explore',
          label: t('nav.explore'),
          group: navigationGroup,
          keywords: 'explore search',
          run: () => {
            pushSpaHistory('/explore');
            void navigateTo('explore');
          },
        },
        {
          id: 'arcade',
          label: t('nav.arcade'),
          group: navigationGroup,
          keywords: 'arcade games',
          run: () => {
            pushSpaHistory('/arcade');
            void navigateTo('arcade');
          },
        },
        {
          id: 'maps',
          label: t('nav.maps'),
          group: navigationGroup,
          keywords: 'maps weather',
          run: () => {
            pushSpaHistory('/maps');
            void navigateTo('maps');
          },
        },
        {
          id: 'translate',
          label: t('nav.translate'),
          group: navigationGroup,
          keywords: 'translate google translate 翻訳',
          run: () => {
            pushSpaHistory('/translate');
            void navigateTo('translate');
          },
        },
        {
          id: 'notifications',
          label: t('nav.notifications'),
          group: navigationGroup,
          run: () => {
            pushSpaHistory('/notifications');
            void navigateTo('notifications');
          },
        },
        {
          id: 'bookmarks',
          label: t('nav.bookmarks'),
          group: navigationGroup,
          run: () => {
            pushSpaHistory('/bookmarks');
            void navigateTo('bookmarks');
          },
        },
        {
          id: 'settings',
          label: t('nav.settings'),
          group: navigationGroup,
          run: () => {
            pushSpaHistory('/settings');
            void navigateTo('settings');
          },
        },
        {
          id: 'theme',
          label: getResolvedTheme() === 'dark' ? t('command.theme_light') : t('command.theme_dark'),
          group: actionGroup,
          hint: 'T',
          run: () => setTheme(getResolvedTheme() === 'dark' ? 'light' : 'dark'),
        },
        {
          id: 'focus-composer',
          label: t('command.new_post'),
          group: actionGroup,
          hint: 'N',
          keywords: 'compose post write',
          run: openComposerFromShell,
        },
      ];
      if (currentUser) {
        actions.push({
          id: 'profile',
          label: t('nav.profile'),
          group: navigationGroup,
          run: () => {
            if (!currentUser) return;
            pushSpaHistory(`/profile/${currentUser.username}`);
            void navigateTo('profile', undefined, currentUser.username);
          },
        });
      }
      return actions;
    });

    // N / T quick actions from the shell cheat sheet. Skip while typing,
    // while a dialog owns the keyboard, or when a modifier is held.
    window.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector('.cmd-overlay:not([hidden])') || isModalOpen()) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      }
      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        openComposerFromShell();
      } else if (key === 't') {
        event.preventDefault();
        setTheme(getResolvedTheme() === 'dark' ? 'light' : 'dark');
      }
    });

    // Register Service Worker for Web Push (browser) — non-blocking
    initializeWebPush(isCapacitorNative).catch(() => {});

    deferInit(async () => {
      // Desktop Windows/Linux only: recommend a newer GitHub release once.
      maybePromptAppUpdate().catch(() => {});

      // Defer platform-specific notification init (not critical for first paint)
      initNativeNotify().catch(() => {});
      // Only register for FCM after notification access has already been granted.
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
