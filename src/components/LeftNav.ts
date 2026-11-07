import { recommendedAppPlatform } from '../lib/app-download.js';
import { attachPlusBadge } from '../lib/avatar.js';
import { detectDevicePlatform } from '../lib/device-platform.js';
import { formatCount } from '../lib/format.js';
import { getLocale, t } from '../lib/i18n.js';
import { type IconName, icon } from '../lib/icons.js';
import { closeLeftNav } from '../lib/left-nav-drawer.js';
import { isModalOpen } from '../lib/modal-state';
import { applyNameColor } from '../lib/name-color.js';
import { isNativeApp, nativeApiHref } from '../lib/native-api.js';
import { commandShortcutLabel } from '../lib/shortcut-label.js';

function createAppDownloadPromo(): HTMLAnchorElement | null {
  if (isNativeApp() || !recommendedAppPlatform(detectDevicePlatform())) return null;

  const promo = document.createElement('a');
  promo.className = 'nav-app-promo';
  promo.href = '/download';
  promo.appendChild(icon('download', { width: '18', height: '18' }));

  const text = document.createElement('span');
  text.className = 'nav-app-promo-text';
  text.textContent = t('app_download.left_nav_promo');
  promo.setAttribute('aria-label', t('app_download.title'));
  promo.setAttribute('title', t('app_download.title'));
  promo.appendChild(text);

  promo.addEventListener('click', (e) => {
    e.preventDefault();
    window.history.pushState({}, '', '/download');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });

  return promo;
}

export interface LeftNavProps {
  activeItem?: string;
  unreadCount?: number;
  mailUnreadCount?: number;
  onNavigate?: (item: string) => void;
  onSignIn?: () => void;
  onSignUp?: () => void;
  /**
   * Optional override for the "Post" button. When omitted, LeftNav opens the
   * shared composer modal itself and broadcasts a `postCreated` window event so
   * the visible feed can prepend the new post.
   */
  onCompose?: () => void;
  currentUser?: {
    id: string;
    username: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
    name_color?: string | null;
  } | null;
}

type TrendingTag = { tag: string; count: number; percentage: number };

/** New sidebar labels are not in the locale files yet; keep them bilingual. */
const label = (ja: string, en: string): string => (getLocale().startsWith('ja') ? ja : en);

/**
 * v5 "quiet craft" sidebar (shadcn + Obsidian):
 * brand row → command trigger (⌘K) → primary post button → menu → tags →
 * pinned account footer.
 */
export class LeftNav {
  private element: HTMLElement;
  public readonly props: LeftNavProps;
  private activeItem: string;
  private popupOpen: boolean = false;
  private boundHandleResize: () => void;
  private boundHandleModalChange: (e: Event) => void;
  private boundHandleDocumentClick: (e: MouseEvent) => void;

  constructor(props: LeftNavProps = {}) {
    this.props = props;
    this.activeItem = props.activeItem || 'home';

    // Initialize bound event handler for proper cleanup
    this.boundHandleResize = this.handleWindowResize.bind(this);
    this.boundHandleModalChange = this.handleModalChange.bind(this);
    this.boundHandleDocumentClick = this.handleDocumentClick.bind(this);

    this.element = this.createElement();
    this.setupEventListeners();
    this.loadTags();
  }

  buildIconSpan(name: IconName): HTMLElement {
    const span = document.createElement('span');
    span.className = 'nav-item-icon';
    span.appendChild(icon(name));
    return span;
  }

  private createBrand(): HTMLElement {
    const brand = document.createElement('div');
    brand.className = 'nav-brand';

    const brandInner = document.createElement('button');
    brandInner.type = 'button';
    brandInner.className = 'nav-brand-inner';
    brandInner.setAttribute('aria-label', t('nav.logo'));

    const mark = document.createElement('img');
    mark.className = 'nav-brand-mark';
    mark.src = '/favicon.ico';
    mark.alt = '';

    const name = document.createElement('span');
    name.className = 'nav-brand-name';
    name.textContent = t('nav.logo');

    brandInner.appendChild(mark);
    brandInner.appendChild(name);
    brandInner.addEventListener('click', () => {
      this.props.onNavigate?.('home');
    });

    brand.appendChild(brandInner);
    return brand;
  }

  /** Fake input that opens the real command palette (⌘K / Ctrl-K). */
  private createCommandTrigger(): HTMLElement {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'nav-command';
    trigger.setAttribute('aria-label', label('検索・コマンドを開く', 'Open search or command'));

    const text = document.createElement('span');
    text.className = 'nav-command-text';
    text.textContent = label('検索・コマンド…', 'Search or command…');

    const kbd = document.createElement('kbd');
    kbd.className = 'nav-kbd';
    kbd.textContent = commandShortcutLabel();

    trigger.appendChild(icon('search', { width: '15', height: '15' }));
    trigger.appendChild(text);
    trigger.appendChild(kbd);
    trigger.addEventListener('click', () => {
      // Close the mobile drawer first so the palette owns the scroll lock.
      closeLeftNav();
      window.dispatchEvent(new CustomEvent('flaxia:command'));
    });

    return trigger;
  }

  private createSectionLabel(text: string, options: { heading?: boolean } = {}): HTMLElement {
    // Headings get a real h2 so the rail has an outline; chrome captions stay
    // plain text because they label a region, not content.
    const el = document.createElement(options.heading ? 'h2' : 'div');
    el.className = 'nav-section-label fx-label';
    el.textContent = text;
    return el;
  }

  private createNavItem(id: string, text: string, iconName: IconName, unreadCount = 0): HTMLElement {
    const navItem = document.createElement('button');
    navItem.type = 'button';
    navItem.className = `nav-item${this.activeItem === id ? ' nav-item--active' : ''}`;
    navItem.setAttribute('data-nav-id', id);
    navItem.setAttribute('aria-current', this.activeItem === id ? 'page' : 'false');

    navItem.appendChild(this.buildIconSpan(iconName));

    const labelSpan = document.createElement('span');
    labelSpan.className = 'nav-item-label';
    labelSpan.textContent = text;
    navItem.appendChild(labelSpan);

    // Unread badge for notifications and Mail.
    if ((id === 'notifications' || id === 'mail') && unreadCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'nav-dm-badge';
      badge.textContent = unreadCount >= 99 ? '99+' : String(unreadCount);
      navItem.appendChild(badge);
    }

    return navItem;
  }

  private createNavItems(): HTMLElement {
    const navItems = document.createElement('div');
    navItems.className = 'nav-items nav-items--menu';

    if (this.props.currentUser) {
      const items = [
        { id: 'home', text: t('nav.home'), icon: 'home' },
        { id: 'explore', text: t('nav.explore'), icon: 'explore' },
        { id: 'arcade', text: t('nav.arcade'), icon: 'arcade' },
        { id: 'translate', text: t('nav.translate'), icon: 'translate' },
        { id: 'notifications', text: t('nav.notifications'), icon: 'notifications' },
        { id: 'mail', text: t('nav.mail'), icon: 'mail' },
        { id: 'bookmarks', text: t('nav.bookmarks'), icon: 'bookmark' },
      ] as const;
      items.forEach((item) => {
        const unread =
          item.id === 'notifications'
            ? this.props.unreadCount || 0
            : item.id === 'mail'
              ? this.props.mailUnreadCount || 0
              : 0;
        navItems.appendChild(this.createNavItem(item.id, item.text, item.icon as IconName, unread));
      });
    } else {
      const items = [
        { id: 'home', text: t('nav.home'), icon: 'home' },
        { id: 'explore', text: t('nav.explore'), icon: 'explore' },
        { id: 'arcade', text: t('nav.arcade'), icon: 'arcade' },
        { id: 'translate', text: t('nav.translate'), icon: 'translate' },
      ];
      items.forEach((item) => {
        navItems.appendChild(this.createNavItem(item.id, item.text, item.icon as IconName));
      });
    }

    return navItems;
  }

  private createTagsSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'nav-section nav-section--tags';

    const list = document.createElement('div');
    list.className = 'nav-tags';

    section.appendChild(this.createSectionLabel(label('タグ', 'Tags'), { heading: true }));
    section.appendChild(list);
    return section;
  }

  private async loadTags(): Promise<void> {
    try {
      const response = await fetch('/api/tags/trending');
      if (!response.ok) return;
      const data = (await response.json()) as { tags?: TrendingTag[] };
      const tags = (data.tags ?? []).slice(0, 5);

      const section = this.element.querySelector('.nav-section--tags') as HTMLElement | null;
      const list = this.element.querySelector('.nav-tags');
      if (!section || !list) return;
      if (tags.length === 0) {
        section.remove();
        return;
      }

      list.innerHTML = '';
      for (const { tag, count } of tags) {
        const row = document.createElement('a');
        row.className = 'nav-tag';
        row.href = `/explore?tag=${encodeURIComponent(tag)}`;
        row.addEventListener('click', (e) => {
          e.preventDefault();
          window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(tag)}`);
          window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'explore', tag } }));
        });

        const hash = document.createElement('span');
        hash.className = 'nav-tag-hash';
        hash.textContent = '#';

        const name = document.createElement('span');
        name.className = 'nav-tag-name';
        name.textContent = tag;

        const countEl = document.createElement('span');
        countEl.className = 'nav-tag-count';
        countEl.textContent = formatCount(count);

        row.appendChild(hash);
        row.appendChild(name);
        row.appendChild(countEl);
        list.appendChild(row);
      }
    } catch {
      // Tags are a progressive enhancement; a failed request just hides them.
      this.element.querySelector('.nav-section--tags')?.remove();
    }
  }

  public createPostButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-post-button';
    btn.setAttribute('data-nav-id', 'compose');

    const iconWrap = document.createElement('span');
    iconWrap.className = 'nav-post-icon';
    iconWrap.appendChild(icon('edit', { width: '16', height: '16' }));

    const labelEl = document.createElement('span');
    labelEl.className = 'nav-post-label';
    labelEl.textContent = t('composer.post_button');

    btn.appendChild(iconWrap);
    btn.appendChild(labelEl);
    btn.addEventListener('click', () => this.openComposer());
    return btn;
  }

  public openComposer(): void {
    if (this.props.onCompose) {
      this.props.onCompose();
      return;
    }
    const currentUser = this.props.currentUser;
    if (!currentUser) {
      this.props.onSignIn?.();
      return;
    }

    // Close the mobile drawer before the composer registers as a modal, so the
    // drawer's scroll-lock cleanup cannot fight the modal's own scroll lock.
    closeLeftNav();

    void import('../lib/post-modal.js').then(({ openPostModal }) => {
      openPostModal({
        currentUser,
        onPostCreated: (post) => {
          window.dispatchEvent(new CustomEvent('postCreated', { detail: post }));
        },
      });
    });
  }

  public createUserArea(): HTMLElement {
    const user = this.props.currentUser;
    const userArea = document.createElement('div');
    userArea.className = 'nav-user-area';

    const avatar = document.createElement('div');
    avatar.className = 'nav-user-avatar';
    if (user?.avatar_key) {
      avatar.style.backgroundImage = `url(${nativeApiHref(`/api/images/${user.avatar_key}`)})`;
    } else if (user) {
      avatar.textContent = (user.display_name || user.username).charAt(0).toUpperCase();
    }
    attachPlusBadge(avatar, user?.badge_type);

    const info = document.createElement('div');
    info.className = 'nav-user-info';

    const name = document.createElement('div');
    name.className = 'nav-user-name';

    const nameText = document.createElement('span');
    nameText.className = 'nav-user-name-text';
    nameText.textContent = user?.display_name || user?.username || '';
    applyNameColor(nameText, user?.name_color, user?.badge_type);

    name.appendChild(nameText);

    const handle = document.createElement('div');
    handle.className = 'nav-user-handle';
    handle.textContent = `@${user?.username ?? ''}`;

    info.appendChild(name);
    info.appendChild(handle);

    // Kebab affordance; the row itself opens the account popup.
    const kebab = document.createElement('span');
    kebab.className = 'nav-user-caret nav-user-kebab';
    kebab.textContent = '⋯';

    userArea.appendChild(avatar);
    userArea.appendChild(info);
    userArea.appendChild(kebab);

    // Popup menu
    const popup = document.createElement('div');
    popup.className = 'nav-user-popup';

    const menuItems = [
      { id: 'profile', text: t('nav.profile'), icon: 'profile' },
      { id: 'settings', text: t('nav.settings'), icon: 'settings' },
    ];

    menuItems.forEach((item) => {
      const popupItem = document.createElement('button');
      popupItem.type = 'button';
      popupItem.className = 'nav-user-popup-item';
      popupItem.setAttribute('data-nav-id', item.id);
      const iconWrap = document.createElement('span');
      iconWrap.className = 'nav-popup-icon';
      iconWrap.appendChild(icon(item.icon as IconName, { width: '16', height: '16' }));
      const labelWrap = document.createElement('span');
      labelWrap.textContent = item.text;
      popupItem.appendChild(iconWrap);
      popupItem.appendChild(labelWrap);

      popupItem.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closePopup();
        this.props.onNavigate?.(item.id);
      });
      popup.appendChild(popupItem);
    });

    userArea.appendChild(popup);

    userArea.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePopup();
    });

    return userArea;
  }

  public createLegalLinks(): HTMLElement {
    const legalLinks = document.createElement('div');
    legalLinks.className = 'nav-legal-links';

    const aboutLink = document.createElement('a');
    aboutLink.href = '/about';
    aboutLink.textContent = t('legal.footer_about');
    aboutLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = '/about';
    });

    const termsLink = document.createElement('a');
    termsLink.href = '/terms';
    termsLink.textContent = t('legal.footer_terms');

    const privacyLink = document.createElement('a');
    privacyLink.href = '/privacy';
    privacyLink.textContent = t('legal.footer_privacy');

    const childSafetyLink = document.createElement('a');
    childSafetyLink.href = '/child-safety';
    childSafetyLink.textContent = t('legal.footer_child_safety');

    const docsLink = document.createElement('a');
    docsLink.href = '/docs';
    docsLink.textContent = t('legal.footer_docs');
    docsLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.history.pushState({}, '', '/docs');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    legalLinks.appendChild(aboutLink);
    legalLinks.appendChild(termsLink);
    legalLinks.appendChild(privacyLink);
    legalLinks.appendChild(childSafetyLink);
    legalLinks.appendChild(docsLink);

    return legalLinks;
  }

  public createAuthButtons(): HTMLElement {
    const authButtons = document.createElement('div');
    authButtons.className = 'nav-auth-buttons';

    const signUpButton = document.createElement('button');
    signUpButton.type = 'button';
    signUpButton.className = 'nav-signin-button';
    signUpButton.setAttribute('aria-label', t('nav.register'));
    signUpButton.setAttribute('title', t('nav.register'));
    const signUpIcon = document.createElement('span');
    signUpIcon.className = 'nav-auth-icon';
    signUpIcon.appendChild(icon('user', { width: '16', height: '16' }));
    const signUpLabel = document.createElement('span');
    signUpLabel.className = 'nav-auth-label';
    signUpLabel.textContent = t('nav.register');
    signUpButton.appendChild(signUpIcon);
    signUpButton.appendChild(signUpLabel);
    signUpButton.addEventListener('click', () => {
      this.props.onSignUp?.();
    });

    const signInButton = document.createElement('button');
    signInButton.type = 'button';
    signInButton.className = 'nav-signin-button';
    signInButton.setAttribute('aria-label', t('nav.login'));
    signInButton.setAttribute('title', t('nav.login'));
    const signInIcon = document.createElement('span');
    signInIcon.className = 'nav-auth-icon';
    signInIcon.appendChild(icon('key', { width: '16', height: '16' }));
    const signInLabel = document.createElement('span');
    signInLabel.className = 'nav-auth-label';
    signInLabel.textContent = t('nav.login');
    signInButton.appendChild(signInIcon);
    signInButton.appendChild(signInLabel);
    signInButton.addEventListener('click', () => {
      this.props.onSignIn?.();
    });

    authButtons.appendChild(signUpButton);
    authButtons.appendChild(signInButton);

    return authButtons;
  }

  private createFooter(): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'nav-footer';

    if (this.props.currentUser) {
      footer.appendChild(this.createUserArea());
    } else {
      footer.appendChild(this.createAuthButtons());
    }
    const appPromo = createAppDownloadPromo();
    if (appPromo) footer.appendChild(appPromo);
    footer.appendChild(this.createLegalLinks());

    return footer;
  }

  private createElement(): HTMLElement {
    const nav = document.createElement('nav');
    nav.className = 'left-nav';
    nav.setAttribute('aria-label', 'Primary');

    nav.appendChild(this.createBrand());
    nav.appendChild(this.createCommandTrigger());

    if (this.props.currentUser) {
      nav.appendChild(this.createPostButton());
    }

    const menu = document.createElement('section');
    menu.className = 'nav-section nav-section--menu';
    // The nav items are the rail's body; a "Menu" caption above five obvious
    // links only adds a label to something already labelled by its icons.

    menu.appendChild(this.createNavItems());
    nav.appendChild(menu);

    nav.appendChild(this.createTagsSection());
    nav.appendChild(this.createFooter());

    return nav;
  }

  private setupEventListeners(): void {
    // Navigation items
    this.element.querySelectorAll('.nav-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const navId = target.getAttribute('data-nav-id');
        if (navId) {
          this.setActiveItem(navId);
          this.props.onNavigate?.(navId);
        }
      });
    });

    // Handle window resize for mobile detection
    window.addEventListener('resize', this.boundHandleResize);

    // Hide nav when modal is open
    window.addEventListener('modalchange', this.boundHandleModalChange);
    this.updateModalVisibility();
  }

  private handleWindowResize(): void {}

  private handleModalChange(): void {
    this.updateModalVisibility();
  }

  private updateModalVisibility(): void {
    if (window.innerWidth > 768) return;
    this.element.style.display = isModalOpen() ? 'none' : '';
  }

  public setActiveItem(item: string): void {
    this.activeItem = item;

    this.element.querySelectorAll('.nav-item').forEach((navItem) => {
      const navId = navItem.getAttribute('data-nav-id');
      const isActive = navId === item;
      navItem.classList.toggle('nav-item--active', isActive);
      navItem.setAttribute('aria-current', isActive ? 'page' : 'false');
    });
  }

  public getActiveItem(): string {
    return this.activeItem;
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  private setNavBadge(navId: string, count: number): void {
    const item = this.element.querySelector(`.nav-item[data-nav-id="${navId}"]`) as HTMLElement | null;
    if (!item) return;

    const existingBadge = item.querySelector('.nav-dm-badge') as HTMLElement | null;
    if (count > 0) {
      if (existingBadge) {
        existingBadge.textContent = count >= 99 ? '99+' : formatCount(count);
      } else {
        const badge = document.createElement('span');
        badge.className = 'nav-dm-badge';
        badge.textContent = count >= 99 ? '99+' : formatCount(count);
        item.appendChild(badge);
      }
    } else if (existingBadge) {
      existingBadge.remove();
    }
  }

  public setUnreadCount(count: number): void {
    this.props.unreadCount = count;
    this.setNavBadge('notifications', count);
  }

  public setMailUnreadCount(count: number): void {
    this.props.mailUnreadCount = count;
    this.setNavBadge('mail', count);
  }

  public togglePopup(): void {
    this.popupOpen = !this.popupOpen;
    const popup = this.element.querySelector('.nav-user-popup') as HTMLElement | null;
    const caret = this.element.querySelector('.nav-user-caret') as HTMLElement | null;
    if (popup) {
      popup.classList.toggle('nav-user-popup--open', this.popupOpen);
    }
    if (caret) {
      caret.classList.toggle('nav-user-caret--open', this.popupOpen);
    }
    if (this.popupOpen) {
      document.addEventListener('click', this.boundHandleDocumentClick);
    } else {
      document.removeEventListener('click', this.boundHandleDocumentClick);
    }
  }

  private handleDocumentClick(e: MouseEvent): void {
    const userArea = this.element.querySelector('.nav-user-area');
    if (userArea && !userArea.contains(e.target as Node)) {
      this.closePopup();
    }
  }

  public closePopup(): void {
    this.popupOpen = false;
    const popup = this.element.querySelector('.nav-user-popup') as HTMLElement | null;
    const caret = this.element.querySelector('.nav-user-caret') as HTMLElement | null;
    if (popup) popup.classList.remove('nav-user-popup--open');
    if (caret) caret.classList.remove('nav-user-caret--open');
    document.removeEventListener('click', this.boundHandleDocumentClick);
  }

  public destroy(): void {
    window.removeEventListener('resize', this.boundHandleResize);
    window.removeEventListener('modalchange', this.boundHandleModalChange);
    this.closePopup();
    this.element.remove();
  }
}

// Factory function for easier usage
export function createLeftNav(props: LeftNavProps = {}): LeftNav {
  return new LeftNav(props);
}

/**
 * Keep the post button in sync with the auth state (guests get no composer).
 */
function syncPostButton(leftNav: LeftNav): void {
  const element = leftNav.getElement();
  const existing = element.querySelector('.nav-post-button');
  if (leftNav.props.currentUser && !existing) {
    const postButton = leftNav.createPostButton();
    const trigger = element.querySelector('.nav-command');
    if (trigger) trigger.insertAdjacentElement('afterend', postButton);
    else element.appendChild(postButton);
  } else if (!leftNav.props.currentUser && existing) {
    existing.remove();
  }
}

// Update function to handle user changes
export function updateLeftNavUser(
  leftNav: LeftNav,
  currentUser: {
    id: string;
    username: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
    name_color?: string | null;
  } | null,
): void {
  leftNav.props.currentUser = currentUser;

  // Remove existing account / auth / legal blocks before rebuilding the footer.
  leftNav.getElement().querySelector('.nav-user-area')?.remove();
  leftNav.getElement().querySelector('.nav-auth-buttons')?.remove();
  leftNav.getElement().querySelector('.nav-app-promo')?.remove();
  leftNav.getElement().querySelector('.nav-legal-links')?.remove();

  // Rebuild navigation items (menu only; tags stay static).
  const navItems = leftNav.getElement().querySelector('.nav-items');
  if (navItems) {
    navItems.innerHTML = '';

    if (currentUser) {
      const items = [
        { id: 'home', text: t('nav.home'), icon: 'home' },
        { id: 'explore', text: t('nav.explore'), icon: 'explore' },
        { id: 'arcade', text: t('nav.arcade'), icon: 'arcade' },
        { id: 'translate', text: t('nav.translate'), icon: 'translate' },
        { id: 'notifications', text: t('nav.notifications'), icon: 'notifications' },
        { id: 'mail', text: t('nav.mail'), icon: 'mail' },
        { id: 'bookmarks', text: t('nav.bookmarks'), icon: 'bookmark' },
      ] as const;

      items.forEach((item) => {
        const count =
          item.id === 'notifications'
            ? (leftNav.props.unreadCount ?? 0)
            : item.id === 'mail'
              ? (leftNav.props.mailUnreadCount ?? 0)
              : 0;
        const navItem = document.createElement('button');
        navItem.type = 'button';
        navItem.className = `nav-item${leftNav.getActiveItem() === item.id ? ' nav-item--active' : ''}`;
        navItem.setAttribute('data-nav-id', item.id);

        const iconSpan = document.createElement('span');
        iconSpan.className = 'nav-item-icon';
        iconSpan.appendChild(icon(item.icon as IconName, { width: '18', height: '18' }));
        const labelSpan = document.createElement('span');
        labelSpan.className = 'nav-item-label';
        labelSpan.textContent = item.text;
        navItem.appendChild(iconSpan);
        navItem.appendChild(labelSpan);

        if (count > 0) {
          const badge = document.createElement('span');
          badge.className = 'nav-dm-badge';
          badge.textContent = count >= 99 ? '99+' : String(count);
          navItem.appendChild(badge);
        }

        navItem.addEventListener('click', () => {
          leftNav.setActiveItem(item.id);
          leftNav.props.onNavigate?.(item.id);
        });
        navItems.appendChild(navItem);
      });
    } else {
      const items = [
        { id: 'home', text: t('nav.home'), icon: 'home' },
        { id: 'explore', text: t('nav.explore'), icon: 'explore' },
        { id: 'arcade', text: t('nav.arcade'), icon: 'arcade' },
        { id: 'translate', text: t('nav.translate'), icon: 'translate' },
      ];

      items.forEach((item) => {
        const navItem = document.createElement('button');
        navItem.type = 'button';
        navItem.className = `nav-item${leftNav.getActiveItem() === item.id ? ' nav-item--active' : ''}`;
        navItem.setAttribute('data-nav-id', item.id);
        const iconSpan = document.createElement('span');
        iconSpan.className = 'nav-item-icon';
        iconSpan.appendChild(icon(item.icon as IconName, { width: '18', height: '18' }));
        const labelSpan = document.createElement('span');
        labelSpan.className = 'nav-item-label';
        labelSpan.textContent = item.text;
        navItem.appendChild(iconSpan);
        navItem.appendChild(labelSpan);
        navItem.addEventListener('click', () => {
          leftNav.setActiveItem(item.id);
          leftNav.props.onNavigate?.(item.id);
        });
        navItems.appendChild(navItem);
      });
    }
  }

  syncPostButton(leftNav);

  // Rebuild the pinned footer: account (or guest auth), then the colophon.
  let footer = leftNav.getElement().querySelector('.nav-footer') as HTMLElement | null;
  if (!footer) {
    footer = document.createElement('div');
    footer.className = 'nav-footer';
    leftNav.getElement().appendChild(footer);
  }

  if (currentUser) {
    footer.appendChild(leftNav.createUserArea());
  } else {
    footer.appendChild(leftNav.createAuthButtons());
  }
  const appPromo = createAppDownloadPromo();
  if (appPromo) footer.appendChild(appPromo);
  footer.appendChild(leftNav.createLegalLinks());
}
