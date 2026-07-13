import type { ArcadePageHandle } from './components/ArcadePage.js';
import { BookmarksPage } from './components/BookmarksPage.js';
import { ConversationView } from './components/ConversationView.js';
import { ExplorePage } from './components/ExplorePage.js';
import type { GroupChatView } from './components/GroupChatView.js';
import type { GroupsPage } from './components/GroupsPage.js';
import { createLeftNav, LeftNav, updateLeftNavUser } from './components/LeftNav.js';
import { MessagesPage } from './components/MessagesPage.js';
import { NotificationsPage } from './components/NotificationsPage.js';
import { createRightPanel } from './components/RightPanel.js';
import { ThreadPage } from './components/ThreadPage.js';
import { Timeline } from './components/Timeline.js';
import { getMe } from './lib/auth-cache.js';
import { initI18n } from './lib/i18n.js';
import { initPerformanceMonitoring } from './lib/performance.js';

interface PageComponent {
  getElement(): HTMLElement;
  destroy(): void;
}

console.log('Flaxia initialized');

// Initialize performance monitoring
initPerformanceMonitoring();

// Start i18n loading early (parallelizes the network fetch with script parsing/css loading)
initI18n();

// Basic app initialization
document.addEventListener('DOMContentLoaded', async () => {
  const app = document.getElementById('app');
  if (app) {
    console.log('App mounted');

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
      | 'whitepaper'
      | 'admin'
      | 'settings'
      | 'arcade'
      | 'messages'
      | 'groups'
      | 'call' = 'timeline';
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
    let notificationsPage: NotificationsPage | null = null;
    let settingsPage: PageComponent | null = null;
    let arcadePage: ArcadePageHandle | null = null;
    let searchPage: PageComponent | null = null;
    let bookmarksPage: BookmarksPage | null = null;
    let messagesPage: MessagesPage | null = null;
    let conversationView: ConversationView | null = null;
    let groupsPage: GroupsPage | null = null;
    let groupChatView: GroupChatView | null = null;
    let callUI: { element: HTMLElement; destroy: () => void } | null = null;
    let cachedContentComponent: { view: string; component: unknown; scrollY: number } | null = null;
    let adminLayout:
      | (PageComponent & { updateMainContent: (el: HTMLElement) => void; setAccessDenied: () => void })
      | null = null;
    let adminAlertsTab: PageComponent | null = null;
    let adminHiddenTab: PageComponent | null = null;
    let adminUsersTab: PageComponent | null = null;
    let adminAdsTab: PageComponent | null = null;
    const leftNavInstances: Set<LeftNav> = new Set();
    let currentUser: { username: string; id: string; display_name?: string; avatar_key?: string } | null = null;
    let unreadNotificationCount = 0;
    let unreadDmCount = 0;
    let previousUnreadCount = 0;

    let tauriNotify: ((title: string, body: string) => Promise<void>) | null = null;
    let tauriBadge: ((count: number) => Promise<void>) | null = null;
    let tauriSetNotificationCount: ((count: number) => Promise<void>) | null = null;
    let capacitorNotify: ((title: string, body: string) => Promise<void>) | null = null;
    let capacitorBadge: ((count: number) => Promise<void>) | null = null;

    const initTauriNotifications = async () => {
      try {
        const { isPermissionGranted, requestPermission, sendNotification } = await import(
          '@tauri-apps/plugin-notification'
        );

        try {
          const granted = await isPermissionGranted();
          if (!granted) {
            await requestPermission();
          }
        } catch {
          // permission API not supported on this platform — proceed anyway
        }

        tauriNotify = async (title: string, body: string) => {
          try {
            await sendNotification({ title, body: body || title });
          } catch (err) {
            console.error('[notif] sendNotification failed:', err);
          }
        };
      } catch {
        console.log('[notif] Tauri notification plugin not available — OS notifications disabled');
      }
    };

    /** Dock/taskbar badge + tray icon badge — independent of the notification plugin. */
    const initTauriBadge = async () => {
      const isTauriEnv = typeof window !== 'undefined' && (window.__TAURI__ || window.__TAURI_INTERNALS__);

      if (!isTauriEnv) {
        console.log('[badge] Not in Tauri environment — skipping badge init');
        return;
      }

      // Dock/taskbar badge count (macOS, Windows, some Linux DEs)
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        tauriBadge = async (count: number) => {
          try {
            await getCurrentWindow().setBadgeCount(count);
          } catch (err) {
            console.log('[badge] setBadgeCount failed:', err);
          }
        };
      } catch {
        console.log('[badge] @tauri-apps/api/window not available');
      }

      // Desktop tray icon: invoke Rust set_notification_count
      if (!/Android/i.test(navigator.userAgent)) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          tauriSetNotificationCount = async (count: number) => {
            try {
              await invoke('set_notification_count', { count });
            } catch (err) {
              console.log('[badge] invoke error:', err);
            }
          };
        } catch {
          console.log('[badge] @tauri-apps/api/core not available');
        }
      }
    };

    /// WebSocket 経由のプッシュ通知を受け取り OS 通知を表示する
    let pushWs: WebSocket | null = null;
    let _pushWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const isCapacitorNative =
      typeof window !== 'undefined' &&
      typeof window.Capacitor !== 'undefined' &&
      typeof window.Capacitor.isNativePlatform === 'function' &&
      window.Capacitor.isNativePlatform();

    const connectPushWebSocket = () => {
      if (pushWs) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const sessionToken = localStorage.getItem('flaxia_session');
      const url = `${protocol}//${window.location.host}/api/ws/notifications${sessionToken ? `?token=${encodeURIComponent(sessionToken)}` : ''}`;

      console.log('[push] connecting to', url);
      try {
        const ws = new WebSocket(url);
        ws.onopen = () => {
          console.log('[push] connected');
          refreshNotificationBadges();
        };
        ws.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            console.log('[push] received:', data);
            if (data.type === 'notification') {
              unreadNotificationCount = data.unread_count;
              updateBadgeUI();
              if (data.push && typeof tauriNotify === 'function') {
                tauriNotify(data.push.title, data.push.body);
              }
              if (data.push && typeof capacitorNotify === 'function') {
                capacitorNotify(data.push.title, data.push.body);
              }
              // Handle incoming call notification
              if (data.push?.type === 'call' && data.push?.postId) {
                showIncomingCall(data.push.postId);
              }
            } else if (data.title) {
              if (typeof tauriNotify === 'function') {
                tauriNotify(data.title, data.body || 'New notification');
              }
              if (typeof capacitorNotify === 'function') {
                capacitorNotify(data.title, data.body || 'New notification');
              }
              refreshNotificationBadges();
            }
          } catch (e) {
            console.error('[push] parse error:', e);
          }
        };
        ws.onclose = (ev) => {
          console.log(`[push] disconnected (code=${ev.code} reason=${ev.reason}), reconnecting in 10s`);
          pushWs = null;
          _pushWsReconnectTimer = setTimeout(() => {
            _pushWsReconnectTimer = null;
            connectPushWebSocket();
          }, 10000);
        };
        ws.onerror = (ev) => {
          console.error('[push] error:', ev);
        };
        pushWs = ws;
      } catch (e) {
        console.error('[push] connection error:', e);
        pushWs = null;
        _pushWsReconnectTimer = setTimeout(() => {
          _pushWsReconnectTimer = null;
          connectPushWebSocket();
        }, 10000);
      }
    };

    const initCapacitorNotifications = async () => {
      try {
        const isNative =
          typeof window !== 'undefined' &&
          typeof window.Capacitor !== 'undefined' &&
          typeof window.Capacitor.isNativePlatform === 'function' &&
          window.Capacitor.isNativePlatform();
        if (!isNative) return;

        const { LocalNotifications } = await import('@capacitor/local-notifications');
        const { Badge } = await import('@capawesome/capacitor-badge');

        await LocalNotifications.requestPermissions();

        try {
          await LocalNotifications.createChannel({
            id: 'flaxia_notifications',
            name: 'Flaxia Notifications',
            importance: 5,
            sound: 'default',
            visibility: 1,
          });
        } catch {
          // channel may already exist
        }

        let notifId = 0;
        capacitorNotify = async (title: string, body: string) => {
          try {
            notifId = (notifId + 1) % 2147483647;
            await LocalNotifications.schedule({
              notifications: [{ title, body, id: notifId }],
            });
          } catch (err) {
            console.error('[notif] Capacitor sendNotification failed:', err);
          }
        };

        capacitorBadge = async (count: number) => {
          try {
            await Badge.set({ count });
          } catch {
            // badge not supported
          }
        };
      } catch {
        // Not running in Capacitor
      }
    };

    const initCapacitorPushRegistration = async () => {
      if (!isCapacitorNative) return;
      try {
        const { PushNotifications } = await import('@capacitor/push-notifications');
        await PushNotifications.requestPermissions();
        await PushNotifications.register();

        await PushNotifications.addListener('registration', (token) => {
          fetch('/api/push/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ type: 'fcm', endpoint: token.value }),
          }).catch((err) => console.error('[push] FCM register failed:', err));
        });

        await PushNotifications.addListener('registrationError', (err) => {
          console.error('[push] FCM registration error:', err);
        });

        await PushNotifications.addListener('pushNotificationReceived', (notification) => {
          if (notification.title && typeof capacitorNotify === 'function') {
            capacitorNotify(notification.title, notification.body || '');
          }
        });

        await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          const clickUrl = action.notification?.data?.click_url;
          if (clickUrl) {
            window.location.href = clickUrl;
          }
        });
      } catch {
        console.log('[push] @capacitor/push-notifications not available');
      }
    };

    /** Register Web Push in browser (Service Worker), or skip in Tauri/Capacitor. */
    /** Convert VAPID base64 key to Uint8Array for PushManager.subscribe(). */
    function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
      const padding = '='.repeat((4 - (base64.length % 4)) % 4);
      const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(b64);
      return Uint8Array.from(raw, (c) => c.charCodeAt(0));
    }

    /** Register for Web Push via Service Worker (browser only). */
    const registerPushToken = async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        return; // not supported (Tauri or old browser)
      }

      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;

        // Get VAPID public key from server
        const keyRes = await fetch('/api/push/vapid-key');
        if (!keyRes.ok) return;
        const { publicKey } = (await keyRes.json()) as { publicKey: string };

        // Subscribe
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });

        await fetch('/api/push/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(sub.toJSON()),
        });
        console.log('Web Push subscription registered');
      } catch (err) {
        console.log('Web Push registration not available:', err);
      }
    };

    const initializeWebPush = async () => {
      if (typeof window !== 'undefined' && (window.__TAURI__ || window.__TAURI_INTERNALS__)) {
        return; // Tauri desktop/mobile — no Service Worker push needed
      }
      if (isCapacitorNative) {
        return; // Capacitor mobile — no Service Worker push needed
      }
      await registerPushToken();
    };

    // Capacitor ライフサイクル: アプリ復帰時に WebSocket 再接続
    if (isCapacitorNative) {
      try {
        const { App } = await import('@capacitor/app');
        await App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) {
            // フォアグラウンド復帰時、WebSocket を再接続 & 未読カウント即時取得
            if (!pushWs) connectPushWebSocket();
            refreshNotificationBadges();
          }
        });
      } catch {
        console.log('[push] @capacitor/app not available');
      }
    }

    const updateBadgeUI = () => {
      leftNavInstances.forEach((leftNav) => {
        if (typeof leftNav.setUnreadCount === 'function') {
          leftNav.setUnreadCount(unreadNotificationCount);
        }
      });
      updateLeftNavOpenBadge(unreadNotificationCount);

      if (capacitorBadge) {
        capacitorBadge(unreadNotificationCount);
      } else if (tauriBadge) {
        tauriBadge(unreadNotificationCount);
      }

      if (tauriSetNotificationCount) {
        tauriSetNotificationCount(unreadNotificationCount).catch((err) => {
          console.log('[badge] set_notification_count failed:', err);
        });
      }
    };

    const refreshNotificationBadges = async () => {
      console.log('[poll] refreshNotificationBadges called');
      const data = await fetchNotifications();
      await fetchDmUnreadCount();
      await fetchGroupUnreadCount();
      console.log('[poll] unread count:', unreadNotificationCount);
      updateBadgeUI();

      // Show notification when new unread notifications arrive (legacy polling path)
      const isRealTauriAndroid =
        typeof window !== 'undefined' &&
        (window.__TAURI__ || window.__TAURI_INTERNALS__) &&
        /Android/i.test(navigator.userAgent);
      if (
        tauriNotify &&
        !isRealTauriAndroid &&
        !isCapacitorNative &&
        unreadNotificationCount > previousUnreadCount &&
        data?.notifications?.length
      ) {
        const latest = data.notifications[0];
        let body = '';
        if (latest.actor) {
          const u = latest.actor.username;
          const d = latest.actor.display_name;
          body = d && d !== u ? `@${u} (${d})` : `@${u}: `;
        }
        body += latest.post_text_preview || 'New notification';
        tauriNotify('Flaxia', body).catch((err) => {
          console.error('[notif] tauriNotify failed:', err);
        });
      } else if (
        capacitorNotify &&
        isCapacitorNative &&
        unreadNotificationCount > previousUnreadCount &&
        data?.notifications?.length
      ) {
        const latest = data.notifications[0];
        let body = '';
        if (latest.actor) {
          const u = latest.actor.username;
          const d = latest.actor.display_name;
          body = d && d !== u ? `@${u} (${d})` : `@${u}: `;
        }
        body += latest.post_text_preview || 'New notification';
        capacitorNotify('Flaxia', body).catch((err) => {
          console.error('[notif] capacitorNotify failed:', err);
        });
      }
      previousUnreadCount = unreadNotificationCount;
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
          const userData = data.user as { id: string; username: string; display_name?: string; avatar_key?: string };
          currentUser = {
            id: userData.id,
            username: userData.username,
            display_name: userData.display_name,
            avatar_key: userData.avatar_key,
          };

          // Update all existing LeftNav instances with new user data
          leftNavInstances.forEach((leftNav) => {
            updateLeftNavUser(leftNav, currentUser);
          });

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
        updateLeftNavUser(leftNav, null);
      });

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

    // Fetch notifications
    interface NotificationData {
      notifications: Array<{
        id: string;
        type:
          | 'reported'
          | 'fresh'
          | 'warned'
          | 'hidden'
          | 'ap_follow'
          | 'ap_like'
          | 'ap_announce'
          | 'reply'
          | 'mention'
          | 'poll_ended';
        post_id: string;
        post_text_preview: string;
        actor?: {
          username: string;
          display_name: string;
          avatar_key: string | null;
        };
        read: boolean;
        created_at: string;
      }>;
      unread_count: number;
    }

    let cachedNotifications: NotificationData | null = null;
    let lastNotificationFetch = 0;
    const NOTIFICATION_FETCH_TTL = 10000; // 10秒以内の連続fetchはキャッシュ

    let unreadGroupCount = 0;

    const fetchDmUnreadCount = async (): Promise<void> => {
      try {
        const res = await fetch('/api/dm/unread-count', { credentials: 'include' });
        if (res.ok) {
          const data = (await res.json()) as { unread_count: number };
          unreadDmCount = data.unread_count || 0;
          leftNavInstances.forEach((ln) => {
            if (typeof ln.setUnreadDmCount === 'function') {
              ln.setUnreadDmCount(unreadDmCount);
            }
          });
        }
      } catch {
        // ignore
      }
    };

    const fetchGroupUnreadCount = async (): Promise<void> => {
      try {
        const res = await fetch('/api/groups/unread-count', { credentials: 'include' });
        if (res.ok) {
          const data = (await res.json()) as { unread_count: number };
          unreadGroupCount = data.unread_count || 0;
          leftNavInstances.forEach((ln) => {
            if (typeof ln.setUnreadGroupCount === 'function') {
              ln.setUnreadGroupCount(unreadGroupCount);
            }
          });
        }
      } catch {
        // ignore
      }
    };

    const fetchNotifications = async (): Promise<NotificationData> => {
      const now = Date.now();
      if (cachedNotifications && now - lastNotificationFetch < NOTIFICATION_FETCH_TTL) {
        return cachedNotifications;
      }
      try {
        const response = await fetch('/api/notifications', { credentials: 'include' });
        if (response.ok) {
          const data = (await response.json()) as NotificationData;
          unreadNotificationCount = data.unread_count || 0;
          cachedNotifications = data;
          lastNotificationFetch = now;
          return data;
        }
      } catch (error) {
        console.log('Failed to fetch notifications:', error);
      }
      return { notifications: [], unread_count: 0 };
    };

    // Mobile left nav overlay management
    let leftNavOverlay: HTMLElement | null = null;
    let leftNavOpenButton: HTMLButtonElement | null = null;

    const createLeftNavOverlay = (): HTMLElement => {
      const overlay = document.createElement('div');
      overlay.className = 'left-nav-overlay';
      overlay.addEventListener('click', () => {
        closeLeftNav();
      });
      document.body.appendChild(overlay);
      return overlay;
    };

    const createLeftNavOpenButton = (leftNavElement: HTMLElement): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'left-nav-open-button';
      button.setAttribute('aria-label', 'Open navigation');
      button.innerHTML = '→<span class="left-nav-open-badge"></span>';
      button.addEventListener('click', () => {
        openLeftNav(leftNavElement);
      });
      document.body.appendChild(button);
      return button;
    };

    const updateLeftNavOpenBadge = (count: number): void => {
      if (!leftNavOpenButton) return;
      const badge = leftNavOpenButton.querySelector('.left-nav-open-badge') as HTMLElement;
      if (!badge) return;
      if (count > 0) {
        badge.textContent = count >= 99 ? '99+' : String(count);
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    };

    let leftNavWasOpen = false;

    const openLeftNav = (leftNavElement: HTMLElement): void => {
      if (window.innerWidth > 768) return;

      leftNavWasOpen = true;
      leftNavElement.classList.add('left-nav--open');

      if (!leftNavOverlay) {
        leftNavOverlay = createLeftNavOverlay();
      }
      leftNavOverlay.classList.add('left-nav-overlay--visible');

      // Prevent body scroll
      document.body.style.overflow = 'hidden';
    };

    const closeLeftNav = (): void => {
      if (!leftNavWasOpen) return;
      leftNavWasOpen = false;

      const leftNavElement = document.querySelector('.left-nav') as HTMLElement;
      if (leftNavElement) {
        leftNavElement.classList.remove('left-nav--open');
      }

      if (leftNavOverlay) {
        leftNavOverlay.classList.remove('left-nav-overlay--visible');
      }

      // Restore body scroll
      document.body.style.overflow = '';
    };

    let currentResizeHandler: (() => void) | null = null;
    let currentKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
    let currentModalChangeHandler: ((e: Event) => void) | null = null;

    const setupMobileLeftNav = (leftNavElement: HTMLElement): void => {
      // Clean up existing button and event listeners
      if (leftNavOpenButton) {
        leftNavOpenButton.remove();
        leftNavOpenButton = null;
      }
      if (currentResizeHandler) {
        window.removeEventListener('resize', currentResizeHandler);
        currentResizeHandler = null;
      }
      if (currentKeydownHandler) {
        document.removeEventListener('keydown', currentKeydownHandler);
        currentKeydownHandler = null;
      }
      if (currentModalChangeHandler) {
        window.removeEventListener('modalchange', currentModalChangeHandler);
        currentModalChangeHandler = null;
      }

      // Always create the button (CSS shows/hides via media query)
      leftNavOpenButton = createLeftNavOpenButton(leftNavElement);

      // Sync button visibility with current notification count
      updateLeftNavOpenBadge(unreadNotificationCount);

      // Listen for openLeftNav events from timeline
      document.addEventListener('openLeftNav', () => {
        openLeftNav(leftNavElement);
      });

      // Handle escape key to close
      currentKeydownHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && window.innerWidth <= 768) {
          closeLeftNav();
        }
      };
      document.addEventListener('keydown', currentKeydownHandler);

      // Handle window resize
      currentResizeHandler = () => {
        if (window.innerWidth > 768) {
          closeLeftNav();
        }
      };
      window.addEventListener('resize', currentResizeHandler);

      // Close mobile nav when modal opens
      currentModalChangeHandler = (e: Event) => {
        if (window.innerWidth > 768) return;
        const { open } = (e as CustomEvent<{ open: boolean }>).detail;
        closeLeftNav();
        if (leftNavOpenButton) {
          leftNavOpenButton.style.display = open ? 'none' : '';
        }
      };
      window.addEventListener('modalchange', currentModalChangeHandler);
    };

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
        cleanPath.startsWith('/arcade/') ||
        cleanPath.startsWith('/thread/');

      // Allow public routes for everyone
      if (isPublicRoute) {
        return true;
      }

      // For /messages, redirect to arcade if not authenticated
      if (cleanPath === '/messages' || cleanPath.startsWith('/messages/')) {
        if (!isAuthenticated) {
          window.history.replaceState({}, '', '/arcade');
          navigateTo('arcade');
          return false;
        }
        return true;
      }

      // For /groups, redirect to arcade if not authenticated
      if (cleanPath === '/groups' || cleanPath.startsWith('/groups/')) {
        if (!isAuthenticated) {
          window.history.replaceState({}, '', '/arcade');
          navigateTo('arcade');
          return false;
        }
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

    // Parse current URL
    const parseCurrentRoute = () => {
      const path = window.location.pathname;
      console.log('Current path:', path, 'Full URL:', window.location.href);

      // Remove trailing slash and ensure consistent format
      const cleanPath = path.replace(/\/$/, '');
      console.log('Clean path:', cleanPath);

      // Auth routes
      if (cleanPath === '/login') {
        console.log('Login route detected');
        return { view: 'login' as const, postId: null, username: null, tag: null };
      }

      if (cleanPath === '/register') {
        console.log('Register route detected');
        return { view: 'register' as const, postId: null, username: null, tag: null };
      }

      // Legal pages (public)
      if (cleanPath === '/terms') {
        console.log('Terms route detected');
        return { view: 'terms' as const, postId: null, username: null, tag: null };
      }

      if (cleanPath === '/privacy') {
        console.log('Privacy route detected');
        return { view: 'privacy' as const, postId: null, username: null, tag: null };
      }

      if (cleanPath === '/about') {
        console.log('About route detected');
        return { view: 'about' as const, postId: null, username: null, tag: null };
      }

      if (cleanPath === '/whitepaper') {
        console.log('Whitepaper route detected');
        return { view: 'whitepaper' as const, postId: null, username: null, tag: null };
      }

      // Explore route - public, no auth required
      const exploreMatch = cleanPath.match(/^\/explore$/);
      if (exploreMatch) {
        const urlParams = new URLSearchParams(window.location.search);
        const tag = urlParams.get('tag');
        console.log('Explore route detected, tag:', tag);
        return { view: 'explore' as const, postId: null, username: null, tag };
      }

      // Search route - public, no auth required
      if (cleanPath === '/search') {
        const urlParams = new URLSearchParams(window.location.search);
        const q = urlParams.get('q') || '';
        const type = urlParams.get('type') || 'posts';
        console.log('Search route detected, query:', q, 'type:', type);
        return {
          view: 'search' as const,
          postId: null,
          username: null,
          tag: null,
          searchQuery: q,
          searchType: type as 'posts' | 'users' | 'arcade',
        };
      }

      // Arcade game route - public, no auth required
      const arcadeGameMatch = cleanPath.match(/^\/arcade\/([^/]+)$/);
      if (arcadeGameMatch) {
        console.log('Arcade game route detected, gameId:', arcadeGameMatch[1]);
        return { view: 'arcade' as const, postId: arcadeGameMatch[1], username: null, tag: null };
      }

      // Arcade route - public, no auth required
      if (cleanPath === '/arcade') {
        console.log('Arcade route detected');
        return { view: 'arcade' as const, postId: null, username: null, tag: null };
      }

      // Thread route (check before profile) - public, no auth required
      const threadMatch = cleanPath.match(/^\/thread\/([^/]+)$/);
      if (threadMatch) {
        console.log('Thread route detected, postId:', threadMatch[1]);
        return { view: 'thread' as const, postId: threadMatch[1], username: null, tag: null };
      }

      // Profile routes - matches both /users/:username and /profile/:username
      const usersProfileMatch = cleanPath.match(/^\/users\/([^/]+)$/);
      const profileMatch = cleanPath.match(/^\/profile\/([^/]+)$/);
      console.log('Profile match test:', { usersProfileMatch, profileMatch }, 'cleanPath:', cleanPath);

      if (usersProfileMatch && usersProfileMatch[1]) {
        console.log('Users profile route detected, username:', usersProfileMatch[1]);
        return { view: 'profile' as const, postId: null, username: usersProfileMatch[1], tag: null };
      }

      if (profileMatch && profileMatch[1]) {
        console.log('Profile route detected, username:', profileMatch[1]);
        return { view: 'profile' as const, postId: null, username: profileMatch[1], tag: null };
      }

      // Notifications route - requires auth
      if (cleanPath === '/notifications') {
        console.log('Notifications route detected');
        return { view: 'notifications' as const, postId: null, username: null, tag: null };
      }

      // Messages routes - require auth
      const messagesConvMatch = cleanPath.match(/^\/messages\/([^/]+)$/);
      if (messagesConvMatch) {
        console.log('Messages conversation route detected, id:', messagesConvMatch[1]);
        return { view: 'messages' as const, postId: messagesConvMatch[1], username: null, tag: null };
      }

      if (cleanPath === '/messages') {
        console.log('Messages route detected');
        return { view: 'messages' as const, postId: null, username: null, tag: null };
      }

      // Groups routes - require auth
      const groupsConvMatch = cleanPath.match(/^\/groups\/([^/]+)$/);
      if (groupsConvMatch) {
        console.log('Groups chat route detected, id:', groupsConvMatch[1]);
        return { view: 'groups' as const, postId: groupsConvMatch[1], username: null, tag: null };
      }

      if (cleanPath === '/groups') {
        console.log('Groups route detected');
        return { view: 'groups' as const, postId: null, username: null, tag: null };
      }

      // Call route - requires auth
      const callMatch = cleanPath.match(/^\/call\/([^/]+)$/);
      if (callMatch) {
        console.log('Call route detected, id:', callMatch[1]);
        return { view: 'call' as const, postId: callMatch[1], username: null, tag: null };
      }

      // Bookmarks route - requires auth
      if (cleanPath === '/bookmarks') {
        console.log('Bookmarks route detected');
        return { view: 'bookmarks' as const, postId: null, username: null, tag: null };
      }

      // Settings route - requires auth
      if (cleanPath === '/settings') {
        console.log('Settings route detected');
        return { view: 'settings' as const, postId: null, username: null, tag: null };
      }

      // Sandbox route - public, no auth required
      const sandboxMatch = cleanPath.match(/^\/sandbox\/post\/([^/]+)$/);
      if (sandboxMatch) {
        console.log('Sandbox route detected, postId:', sandboxMatch[1]);
        // For sandbox, don't initialize the app - let the sandbox page handle itself
        console.log('Sandbox page detected, skipping app initialization');
        return null;
      }

      // Admin route - requires auth
      const adminMatch = cleanPath.match(/^\/admin(\/alerts|\/hidden|\/users|\/counter)?$/);
      if (adminMatch) {
        console.log('Admin route detected');
        const tab = adminMatch[1]
          ? (adminMatch[1].replace('/', '') as 'alerts' | 'hidden' | 'users' | 'counter')
          : 'alerts';
        return { view: 'admin' as const, postId: null, username: null, tag: null, adminTab: tab };
      }

      // Home route - public, no auth required
      if (cleanPath === '/home') {
        console.log('Home route detected');
        return { view: 'timeline' as const, postId: null, username: null, tag: null };
      }

      // Default timeline (only for root path) - public, no auth required
      if (cleanPath === '' || cleanPath === '/') {
        console.log('Timeline route detected');
        return { view: 'timeline' as const, postId: null, username: null, tag: null };
      }

      // If no route matched, default to timeline
      console.log('Unknown route, defaulting to timeline');
      return { view: 'timeline' as const, postId: null, username: null, tag: null };
    };

    // Page loading overlay
    let pageLoader: HTMLDivElement | null = null;
    let pageLoaderTimer: ReturnType<typeof setTimeout> | null = null;

    function showPageLoader() {
      if (!pageLoader) {
        pageLoader = document.createElement('div');
        pageLoader.className = 'page-loader';
        pageLoader.id = 'page-loader';
        pageLoader.innerHTML =
          '<div class="page-loader-content"><div class="page-loader-spinner"></div><div>Loading...</div></div>';
        document.body.appendChild(pageLoader);
      } else {
        const content = pageLoader.querySelector('.page-loader-content')!;
        content.innerHTML = '<div class="page-loader-spinner"></div><div>Loading...</div>';
        content.className = 'page-loader-content';
      }
      pageLoader!.classList.add('active');

      if (pageLoaderTimer) clearTimeout(pageLoaderTimer);
      pageLoaderTimer = setTimeout(() => {
        if (!pageLoader || !pageLoader.classList.contains('active')) return;
        const content = pageLoader.querySelector('.page-loader-content')!;
        content.innerHTML =
          '<div style="font-size:2rem;margin-bottom:1rem;">⚠</div><div>Failed to load page</div><button class="page-loader-reload-btn" style="margin-top:1rem;padding:0.6rem 1.5rem;border:1px solid var(--border);border-radius:8px;background:var(--accent);color:#000;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;transition:background .2s">Reload</button>';
        content.className = 'page-loader-content';
        const btn = content.querySelector('.page-loader-reload-btn') as HTMLButtonElement;
        btn.onclick = () => {
          window.location.reload();
        };
        btn.onmouseenter = () => {
          btn.style.background = 'var(--accent-dark)';
        };
        btn.onmouseleave = () => {
          btn.style.background = 'var(--accent)';
        };
      }, 15000);
    }

    function hidePageLoader() {
      if (pageLoader) pageLoader.classList.remove('active');
      if (pageLoaderTimer) {
        clearTimeout(pageLoaderTimer);
        pageLoaderTimer = null;
      }
    }

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
        | 'whitepaper'
        | 'admin'
        | 'settings'
        | 'arcade'
        | 'messages'
        | 'groups'
        | 'call',
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
        if (messagesPage) {
          messagesPage.destroy();
          messagesPage = null;
        }
        if (conversationView) {
          conversationView.destroy();
          conversationView = null;
        }
        if (groupsPage) {
          groupsPage.destroy();
          groupsPage = null;
        }
        if (groupChatView) {
          groupChatView.destroy();
          groupChatView = null;
        }
      } else {
        // Auth guard for protected routes
        const isAuthenticated = await requireAuth();
        if (!isAuthenticated) {
          return; // Auth guard will redirect to login
        }

        // Cache current view when navigating to thread, arcade, or messages conversation (for back navigation with preserved content)
        if (
          (view === 'thread' || view === 'arcade' || view === 'messages' || view === 'groups') &&
          currentView !== view
        ) {
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
          } else if (currentView === 'messages' && messagesPage) {
            cachedContentComponent = { view: 'messages', component: messagesPage, scrollY: window.scrollY };
            messagesPage = null;
          } else if (currentView === 'groups' && groupsPage) {
            cachedContentComponent = { view: 'groups', component: groupsPage, scrollY: window.scrollY };
            groupsPage = null;
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
        if (messagesPage) {
          messagesPage.destroy();
          messagesPage = null;
        }
        if (conversationView) {
          conversationView.destroy();
          conversationView = null;
        }
        if (groupsPage) {
          groupsPage.destroy();
          groupsPage = null;
        }
        if (groupChatView) {
          groupChatView.destroy();
          groupChatView = null;
        }
      }

      // Clear app content
      showPageLoader();
      app.innerHTML = '';

      // Wrap rendering in try-catch so errors don't leave the loader stuck
      try {
        // Handle auth pages (full screen, no nav)
        if (view === 'login') {
          if (leftNavOpenButton) {
            leftNavOpenButton.remove();
            leftNavOpenButton = null;
          }
          if (leftNavOverlay) {
            leftNavOverlay.remove();
            leftNavOverlay = null;
          }
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
          if (leftNavOpenButton) {
            leftNavOpenButton.remove();
            leftNavOpenButton = null;
          }
          if (leftNavOverlay) {
            leftNavOverlay.remove();
            leftNavOverlay = null;
          }
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
        if (view === 'terms' || view === 'privacy' || view === 'about' || view === 'whitepaper') {
          if (leftNavOpenButton) {
            leftNavOpenButton.remove();
            leftNavOpenButton = null;
          }
          if (leftNavOverlay) {
            leftNavOverlay.remove();
            leftNavOverlay = null;
          }
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
          const leftNav = createLeftNav({
            activeItem: 'explore',
            unreadCount: unreadNotificationCount,
            currentUser: currentUser || undefined,
            onNavigate: async (item) => {
              console.log('Navigate to:', item);
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
              } else if (item === 'messages') {
                window.history.pushState({}, '', '/messages');
                navigateTo('messages');
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
            },
            onSignIn: () => {
              window.history.pushState({}, '', '/login');
              navigateTo('login');
            },
            onSignUp: () => {
              window.history.pushState({}, '', '/register');
              navigateTo('register');
            },
          });

          leftNavInstances.add(leftNav);

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app';

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
          const rightPanel = createRightPanel({
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

          const leftNav = createLeftNav({
            activeItem: 'explore',
            unreadCount: unreadNotificationCount,
            currentUser: currentUser || undefined,
            onNavigate: async (item) => {
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
              } else if (item === 'messages') {
                window.history.pushState({}, '', '/messages');
                navigateTo('messages');
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
            },
            onSignIn: () => {
              window.history.pushState({}, '', '/login');
              navigateTo('login');
            },
            onSignUp: () => {
              window.history.pushState({}, '', '/register');
              navigateTo('register');
            },
          });

          leftNavInstances.add(leftNav);

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app';

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

          const rightPanel = createRightPanel({
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
          const leftNav = createLeftNav({
            activeItem: 'arcade',
            unreadCount: unreadNotificationCount,
            currentUser: currentUser || undefined,
            onNavigate: async (item) => {
              console.log('Navigate to:', item);
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
              } else if (item === 'messages') {
                window.history.pushState({}, '', '/messages');
                navigateTo('messages');
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
            },
            onSignIn: () => {
              window.history.pushState({}, '', '/login');
              navigateTo('login');
            },
            onSignUp: () => {
              window.history.pushState({}, '', '/register');
              navigateTo('register');
            },
          });

          leftNavInstances.add(leftNav);

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app';

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
                console.log('Arcade back button clicked');
                window.history.back();
              },
            });
          }

          // Create Right Panel
          const rightPanel = createRightPanel({
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
          const leftNav = createLeftNav({
            activeItem: 'profile',
            unreadCount: unreadNotificationCount,
            currentUser: currentUser || undefined,
            onNavigate: async (item) => {
              console.log('Navigate to:', item);
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
              } else if (item === 'messages') {
                window.history.pushState({}, '', '/messages');
                navigateTo('messages');
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
            },
            onSignIn: () => {
              window.history.pushState({}, '', '/login');
              navigateTo('login');
            },
            onSignUp: () => {
              window.history.pushState({}, '', '/register');
              navigateTo('register');
            },
          });

          leftNavInstances.add(leftNav);

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app';

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
            });
          }

          // Create Right Panel
          const rightPanel = createRightPanel({
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

          const leftNav = createLeftNav({
            activeItem: 'bookmarks',
            unreadCount: unreadNotificationCount,
            currentUser: currentUser || undefined,
            onNavigate: async (item) => {
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
              } else if (item === 'messages') {
                window.history.pushState({}, '', '/messages');
                navigateTo('messages');
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
            },
            onSignIn: () => {
              window.history.pushState({}, '', '/login');
              navigateTo('login');
            },
            onSignUp: () => {
              window.history.pushState({}, '', '/register');
              navigateTo('register');
            },
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
            const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app';
            const { createBookmarksPage } = await import('./components/BookmarksPage.js');
            bookmarksPage = createBookmarksPage({
              sandboxOrigin,
              currentUser,
            });
            window.scrollTo(0, 0);
          }

          const rightPanel = createRightPanel({
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

          // Create main container for 3-column layout
          const mainContainer = document.createElement('div');
          mainContainer.className = 'main-container';

          // Create Left Nav with unread count
          const leftNav = createLeftNav({
            activeItem: 'notifications',
            unreadCount: unreadNotificationCount,
            currentUser: currentUser || undefined,
            onNavigate: async (item) => {
              console.log('Navigate to:', item);
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
              } else if (item === 'messages') {
                window.history.pushState({}, '', '/messages');
                navigateTo('messages');
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
            },
            onSignIn: () => {
              window.history.pushState({}, '', '/login');
              navigateTo('login');
            },
            onSignUp: () => {
              window.history.pushState({}, '', '/register');
              navigateTo('register');
            },
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
              cachedNotifications = null;
              lastNotificationFetch = 0;
              leftNavInstances.forEach((ln) => {
                if (typeof ln.setUnreadCount === 'function') {
                  ln.setUnreadCount(0);
                }
              });
              updateLeftNavOpenBadge(0);
              if (capacitorBadge) {
                await capacitorBadge(0);
              }
              if (tauriBadge) {
                await tauriBadge(0);
              }
            },
            onNavigateToPost: (postId) => {
              window.history.pushState({}, '', `/thread/${postId}`);
              navigateTo('thread', postId);
            },
          });

          // Create Right Panel
          const rightPanel = createRightPanel({
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

        // Handle messages page (within 3-column layout)
        if (view === 'messages') {
          currentView = 'messages';
          currentPostId = postId || null;
          _currentUsername = null;
          currentTag = null;

          if (!currentUser) {
            window.history.pushState({}, '', '/explore');
            navigateTo('explore');
            return;
          }

          // Create main container for 3-column layout
          const mainContainer = document.createElement('div');
          mainContainer.className = 'main-container';

          const leftNav = createLeftNav({
            activeItem: 'messages',
            unreadCount: unreadNotificationCount,
            unreadDmCount,
            unreadGroupCount,
            currentUser: currentUser || undefined,
            onNavigate: async (item) => {
              if (item === 'home') {
                window.history.pushState({}, '', '/home');
                navigateTo('timeline');
              } else if (item === 'explore') {
                window.history.pushState({}, '', '/explore');
                navigateTo('explore');
              } else if (item === 'arcade') {
                window.history.pushState({}, '', '/arcade');
                navigateTo('arcade');
              } else if (item === 'messages') {
                window.history.pushState({}, '', '/messages');
                navigateTo('messages');
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
            },
            onSignIn: () => {
              window.history.pushState({}, '', '/login');
              navigateTo('login');
            },
            onSignUp: () => {
              window.history.pushState({}, '', '/register');
              navigateTo('register');
            },
          });

          leftNavInstances.add(leftNav);

          if (postId) {
            // Conversation thread view
            if (cachedContentComponent?.view === 'messages' && messagesPage) {
              messagesPage = null;
            }

            const { createConversationView } = await import('./components/ConversationView.js');
            conversationView = createConversationView({
              conversationId: postId,
              currentUser,
              onBack: () => {
                window.history.pushState({}, '', '/messages');
                navigateTo('messages');
              },
            });

            mainContainer.appendChild(leftNav.getElement());
            mainContainer.appendChild(conversationView.getElement());
          } else {
            // Combined messages + groups list view
            if (cachedContentComponent?.view === 'messages') {
              messagesPage = cachedContentComponent.component as MessagesPage;
              cachedContentComponent = null;
              messagesPage.refresh();
            } else {
              const { createMessagesPage } = await import('./components/MessagesPage.js');
              messagesPage = createMessagesPage({
                currentUser,
                onNavigateToConversation: (convId) => {
                  window.history.pushState({}, '', `/messages/${convId}`);
                  navigateTo('messages', convId);
                },
                onNavigateToGroup: (groupId) => {
                  window.history.pushState({}, '', `/groups/${groupId}`);
                  navigateTo('groups', groupId);
                },
              });
            }

            // Create Right Panel
            const rightPanel = createRightPanel({
              onSearch: (query) => {},
              onFollowUser: (userId) => {},
            });

            mainContainer.appendChild(leftNav.getElement());
            mainContainer.appendChild(messagesPage.getElement());
            mainContainer.appendChild(rightPanel.getElement());
          }

          app.appendChild(mainContainer);
          hidePageLoader();

          setupMobileLeftNav(leftNav.getElement());

          return;
        }

        // Handle groups page - only for specific group chat view
        if (view === 'groups') {
          if (!postId) {
            // No group ID: redirect to combined messages page
            window.history.pushState({}, '', '/messages');
            navigateTo('messages');
            return;
          }

          currentView = 'groups';
          currentPostId = postId || null;
          _currentUsername = null;
          currentTag = null;

          if (!currentUser) {
            window.history.pushState({}, '', '/explore');
            navigateTo('explore');
            return;
          }

          const mainContainer = document.createElement('div');
          mainContainer.className = 'main-container';

          const leftNav = createLeftNav({
            activeItem: 'messages',
            unreadCount: unreadNotificationCount,
            unreadDmCount,
            unreadGroupCount,
            currentUser: currentUser || undefined,
            onNavigate: async (item) => {
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
              } else if (item === 'messages') {
                window.history.pushState({}, '', '/messages');
                navigateTo('messages');
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
            },
            onSignIn: () => {
              window.history.pushState({}, '', '/login');
              navigateTo('login');
            },
            onSignUp: () => {
              window.history.pushState({}, '', '/register');
              navigateTo('register');
            },
          });

          leftNavInstances.add(leftNav);

          if (cachedContentComponent?.view === 'groups' && groupsPage) {
            groupsPage = null;
          }

          const { createGroupChatView } = await import('./components/GroupChatView.js');
          groupChatView = createGroupChatView({
            groupId: postId,
            currentUser,
            onBack: () => {
              window.history.pushState({}, '', '/messages');
              navigateTo('messages');
            },
          });

          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(groupChatView.getElement());

          app.appendChild(mainContainer);
          hidePageLoader();

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
          const leftNav = createLeftNav({
            activeItem: 'settings',
            unreadCount: unreadNotificationCount,
            currentUser: currentUser || undefined,
            onNavigate: async (item) => {
              console.log('Navigate to:', item);
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
              } else if (item === 'messages') {
                window.history.pushState({}, '', '/messages');
                navigateTo('messages');
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
            },
            onSignIn: () => {
              window.history.pushState({}, '', '/login');
              navigateTo('login');
            },
            onSignUp: () => {
              window.history.pushState({}, '', '/register');
              navigateTo('register');
            },
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
          const rightPanel = createRightPanel({
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

        if (view === 'call' && postId) {
          // Call view - render timeline with call overlay
          currentView = 'timeline';
          currentPostId = null;

          const leftNav = createLeftNav({
            activeItem: 'home',
            unreadCount: unreadNotificationCount,
            unreadDmCount,
            unreadGroupCount,
            currentUser: currentUser || undefined,
            onNavigate: async (item) => {
              if (item === 'home') {
                window.history.pushState({}, '', '/home');
                navigateTo('timeline');
              } else if (item === 'explore') {
                window.history.pushState({}, '', '/explore');
                navigateTo('explore');
              } else if (item === 'arcade') {
                window.history.pushState({}, '', '/arcade');
                navigateTo('arcade');
              } else if (item === 'messages') {
                window.history.pushState({}, '', '/messages');
                navigateTo('messages');
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
            },
            onSignIn: () => {
              window.history.pushState({}, '', '/login');
              navigateTo('login');
            },
            onSignUp: () => {
              window.history.pushState({}, '', '/register');
              navigateTo('register');
            },
          });

          leftNavInstances.add(leftNav);

          const { createTimeline } = await import('./components/Timeline.js');
          timeline = createTimeline({
            sandboxOrigin: import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app',
            currentUser,
          });

          const rightPanel = createRightPanel({
            onSearch: () => {},
            onFollowUser: () => {},
          });

          mainContainer.appendChild(leftNav.getElement());
          mainContainer.appendChild(timeline.getElement());
          mainContainer.appendChild(rightPanel.getElement());
          app.appendChild(mainContainer);
          hidePageLoader();
          setupMobileLeftNav(leftNav.getElement());

          return;
        }

        if (view === 'thread' && postId) {
          // Thread page view
          console.log('Creating thread page for postId:', postId);
          currentView = 'thread';
          currentPostId = postId;

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app';
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
          const threadRightPanel = createRightPanel({
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
          document.title = 'Flaxia - SNS';

          // Create Left Nav
          const leftNav = createLeftNav({
            activeItem: 'home',
            unreadCount: unreadNotificationCount,
            unreadDmCount,
            currentUser: currentUser || undefined,
            onNavigate: async (item) => {
              console.log('Navigate to:', item);
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
              } else if (item === 'messages') {
                window.history.pushState({}, '', '/messages');
                navigateTo('messages');
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
            },
            onSignIn: () => {
              window.history.pushState({}, '', '/login');
              navigateTo('login');
            },
            onSignUp: () => {
              window.history.pushState({}, '', '/register');
              navigateTo('register');
            },
          });

          leftNavInstances.add(leftNav);

          const sandboxOrigin = import.meta.env.VITE_SANDBOX_ORIGIN || 'https://flaxia.app';

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
          const rightPanel = createRightPanel({
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
        if (pageLoader) {
          const c = pageLoader.querySelector('.page-loader-content')!;
          c.innerHTML =
            '<div style="font-size:2rem;margin-bottom:1rem;">⚠</div><div>Failed to load page</div><button class="page-loader-reload-btn" style="margin-top:1rem;padding:0.6rem 1.5rem;border:1px solid var(--border);border-radius:8px;background:var(--accent);color:#000;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer">Reload</button>';
          c.className = 'page-loader-content';
          const btn = c.querySelector('.page-loader-reload-btn') as HTMLButtonElement;
          btn.onclick = () => {
            window.location.reload();
          };
        }
      }
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
            | 'whitepaper'
            | 'admin'
            | 'settings'
            | 'arcade'
            | 'messages'
            | 'groups',
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
        if (pageLoader && pageLoader.classList.contains('active')) {
          const c = pageLoader.querySelector('.page-loader-content')!;
          c.innerHTML =
            '<div style="font-size:2rem;margin-bottom:1rem;">⚠</div><div>Failed to load page</div><button class="page-loader-reload-btn" style="margin-top:1rem;padding:0.6rem 1.5rem;border:1px solid var(--border);border-radius:8px;background:var(--accent);color:#000;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer">Reload</button>';
          c.className = 'page-loader-content';
          const btn = c.querySelector('.page-loader-reload-btn') as HTMLButtonElement;
          btn.onclick = () => {
            window.location.reload();
          };
        } else {
          window.location.reload();
        }
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

    // ─── Call feature event handlers ───────────────────────────────────────────────

    const showIncomingCall = async (callId: string) => {
      try {
        const { createCallUI } = await import('./components/CallUI.js');
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${window.location.host}/api/ws/call?roomId=${callId}&token=`;

        const ui = createCallUI({
          roomId: callId,
          wsUrl,
          currentUser: currentUser || { id: '', username: '' },
          onEnded: () => {
            if (callUI) {
              callUI.destroy();
              callUI = null;
            }
          },
        });
        callUI = ui;
        document.body.appendChild(ui.element);
      } catch (e) {
        console.error('Failed to show incoming call:', e);
      }
    };

    window.addEventListener('startGroupCall', ((e: CustomEvent) => {
      const { groupId } = e.detail;
      if (!groupId) return;
      (async () => {
        try {
          const res = await fetch('/api/calls/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId, type: 'audio' }),
          });
          const data: any = await res.json();
          if (data.error) {
            console.error('Failed to start group call:', data.error);
            return;
          }
          const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const wsUrl = `${wsProtocol}//${window.location.host}/api/ws/call?roomId=${data.roomId}&token=`;
          const { createCallUI } = await import('./components/CallUI.js');
          const ui = createCallUI({
            roomId: data.roomId,
            wsUrl,
            currentUser: currentUser || { id: '', username: '' },
            onEnded: () => {
              if (callUI) {
                callUI.destroy();
                callUI = null;
              }
            },
          });
          callUI = ui;
          document.body.appendChild(ui.element);
        } catch (e) {
          console.error('Failed to start group call:', e);
        }
      })();
    }) as EventListener);

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
    initializeWebPush().catch(() => {});

    deferInit(async () => {
      // Defer platform-specific notification init (not critical for first paint)
      initTauriNotifications().catch(() => {});
      initTauriBadge().catch(() => {});
      initCapacitorNotifications().catch(() => {});
      initCapacitorPushRegistration().catch(() => {});

      // @ts-expect-error - dynamic import of local path
      const { initFlaxiaNode } = await import('/api/crowd/index.js');
      initFlaxiaNode({
        orchestratorUrl: 'https://crowd.flaxia.app',
        siteId: 'flaxia',
        consent: {
          brandName: 'Flaxia',
          position: 'bottom-right',
        },
        capabilities: ['ai-inference', 'vector-embed'],
        maxCpuLoad: 0.15,
      });
    });
  }
});
