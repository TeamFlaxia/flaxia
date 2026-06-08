import { formatCount } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { isModalOpen } from '../lib/modal-state';

export interface LeftNavProps {
  activeItem?: string;
  unreadCount?: number;
  onNavigate?: (item: string) => void;
  onSignIn?: () => void;
  onSignUp?: () => void;
  currentUser?: {
    id: string;
    username: string;
    display_name?: string;
    avatar_key?: string;
  } | null;
}

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
  }

  private createElement(): HTMLElement {
    const nav = document.createElement('nav');
    nav.className = 'left-nav';

    // Logo section
    const logo = document.createElement('div');
    logo.className = 'nav-logo';
    const logoInner = document.createElement('div');
    logoInner.style.cssText = 'display: flex; align-items: center; gap: 0.5rem; margin-bottom: 2rem; cursor: pointer;';

    const logoIcon = document.createElement('span');
    logoIcon.style.fontSize = '1.5rem';
    logoIcon.textContent = '🌿';

    const logoText = document.createElement('span');
    logoText.style.cssText = 'font-size: 1.25rem; font-weight: 600; color: var(--accent);';
    logoText.textContent = t('nav.logo');

    logoInner.appendChild(logoIcon);
    logoInner.appendChild(logoText);
    logo.appendChild(logoInner);
    logo.addEventListener('click', () => {
      this.props.onNavigate?.('home');
    });

    // Navigation items - different for guests vs logged-in users
    const navItems = document.createElement('div');
    navItems.className = 'nav-items';

    if (this.props.currentUser) {
      // Full navigation for logged-in users
      const items = [
        { id: 'home', label: t('nav.home'), icon: '🏠' },
        { id: 'explore', label: t('nav.explore'), icon: '🔍' },
        { id: 'arcade', label: t('nav.arcade'), icon: '🕹️' },
        { id: 'profile', label: t('nav.profile'), icon: '👤' },
      ];

      items.forEach((item) => {
        const navItem = document.createElement('button');
        navItem.className = `nav-item ${this.activeItem === item.id ? 'nav-item--active' : ''}`;
        navItem.setAttribute('data-nav-id', item.id);

        const iconSpan = document.createElement('span');
        iconSpan.style.marginRight = '0.75rem';
        iconSpan.textContent = item.icon;

        const labelSpan = document.createElement('span');
        labelSpan.textContent = item.label;

        navItem.appendChild(iconSpan);
        navItem.appendChild(labelSpan);

        navItems.appendChild(navItem);
      });
    } else {
      // Simplified navigation for guests
      const items = [
        { id: 'home', label: t('nav.home'), icon: '🏠' },
        { id: 'explore', label: t('nav.explore'), icon: '🔍' },
        { id: 'arcade', label: t('nav.arcade'), icon: '🕹️' },
        { id: 'settings', label: t('nav.settings'), icon: '⚙️' },
      ];

      items.forEach((item) => {
        const navItem = document.createElement('button');
        navItem.className = `nav-item ${this.activeItem === item.id ? 'nav-item--active' : ''}`;
        navItem.setAttribute('data-nav-id', item.id);

        const iconSpan = document.createElement('span');
        iconSpan.style.marginRight = '0.75rem';
        iconSpan.textContent = item.icon;

        const labelSpan = document.createElement('span');
        labelSpan.textContent = item.label;

        navItem.appendChild(iconSpan);
        navItem.appendChild(labelSpan);
        navItems.appendChild(navItem);
      });
    }

    nav.appendChild(logo);
    nav.appendChild(navItems);

    // User account area (logged-in users only)
    if (this.props.currentUser) {
      const userArea = document.createElement('div');
      userArea.className = 'nav-user-area';

      const avatar = document.createElement('div');
      avatar.className = 'nav-user-avatar';
      if (this.props.currentUser.avatar_key) {
        avatar.style.backgroundImage = `url(/api/images/${this.props.currentUser.avatar_key})`;
      } else {
        avatar.textContent = (this.props.currentUser.display_name || this.props.currentUser.username)
          .charAt(0)
          .toUpperCase();
        avatar.style.background = 'var(--accent)';
      }

      const info = document.createElement('div');
      info.className = 'nav-user-info';

      const name = document.createElement('div');
      name.className = 'nav-user-name';

      const nameText = document.createElement('span');
      nameText.className = 'nav-user-name-text';
      nameText.textContent = this.props.currentUser.display_name || this.props.currentUser.username;

      const badge = document.createElement('span');
      badge.className = 'nav-user-badge';
      badge.style.display = 'none';

      name.appendChild(nameText);
      name.appendChild(badge);

      const handle = document.createElement('div');
      handle.className = 'nav-user-handle';
      handle.textContent = `@${this.props.currentUser.username}`;

      info.appendChild(name);
      info.appendChild(handle);

      const caret = document.createElement('span');
      caret.className = 'nav-user-caret';
      caret.textContent = '▼';

      userArea.appendChild(avatar);
      userArea.appendChild(info);
      userArea.appendChild(caret);

      // Init badge count
      if (this.props.unreadCount && this.props.unreadCount > 0) {
        const count = this.props.unreadCount >= 99 ? '99+' : String(this.props.unreadCount);
        badge.textContent = count;
        badge.style.display = '';
      }

      // Popup menu
      const popup = document.createElement('div');
      popup.className = 'nav-user-popup';

      const menuItems = [
        { id: 'profile', label: t('nav.profile'), icon: '👤' },
        { id: 'notifications', label: t('nav.notifications'), icon: '🔔' },
        { id: 'bookmarks', label: t('nav.bookmarks'), icon: '🔖' },
        { id: 'settings', label: t('nav.settings'), icon: '⚙️' },
      ];

      menuItems.forEach((item) => {
        const popupItem = document.createElement('button');
        popupItem.className = 'nav-user-popup-item';
        popupItem.setAttribute('data-nav-id', item.id);
        popupItem.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;

        // Unread badge for notifications in popup
        if (item.id === 'notifications' && this.props.unreadCount && this.props.unreadCount > 0) {
          const notifBadge = document.createElement('span');
          notifBadge.className = 'nav-badge';
          notifBadge.style.cssText = `
            margin-left: auto;
            background: var(--accent);
            font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 0.75rem;
            padding: 2px 8px;
            border-radius: 9999px;
            min-width: 20px;
            text-align: center;
          `;
          notifBadge.textContent = this.props.unreadCount >= 99 ? '99+' : String(this.props.unreadCount);
          popupItem.appendChild(notifBadge);
        }

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

      nav.appendChild(userArea);
    }

    // Add legal links (privacy policy and terms)
    const legalLinks = document.createElement('div');
    legalLinks.className = 'nav-legal-links';
    legalLinks.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin-top: 1.5rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border);
    `;

    // Create About flaxia link
    const aboutLink = document.createElement('a');
    aboutLink.href = '/about';
    aboutLink.textContent = t('legal.footer_about');
    aboutLink.style.cssText = `
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.875rem;
      font-family: monospace;
      transition: color 0.2s;
    `;
    aboutLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = '/about';
    });
    aboutLink.addEventListener('mouseenter', () => {
      aboutLink.style.color = 'var(--text-primary)';
    });
    aboutLink.addEventListener('mouseleave', () => {
      aboutLink.style.color = 'var(--text-muted)';
    });

    const termsLink = document.createElement('a');
    termsLink.href = '/terms';
    termsLink.textContent = t('legal.footer_terms');
    termsLink.style.cssText = `
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.875rem;
      transition: color 0.2s;
    `;
    termsLink.addEventListener('mouseenter', () => {
      termsLink.style.color = 'var(--text-primary)';
    });
    termsLink.addEventListener('mouseleave', () => {
      termsLink.style.color = 'var(--text-muted)';
    });

    const privacyLink = document.createElement('a');
    privacyLink.href = '/privacy';
    privacyLink.textContent = t('legal.footer_privacy');
    privacyLink.style.cssText = `
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.875rem;
      transition: color 0.2s;
    `;
    privacyLink.addEventListener('mouseenter', () => {
      privacyLink.style.color = 'var(--text-primary)';
    });
    privacyLink.addEventListener('mouseleave', () => {
      privacyLink.style.color = 'var(--text-muted)';
    });

    legalLinks.appendChild(aboutLink);
    legalLinks.appendChild(termsLink);
    legalLinks.appendChild(privacyLink);

    // Create White Paper link
    const whitepaperLink = document.createElement('a');
    whitepaperLink.href = '/whitepaper';
    whitepaperLink.textContent = t('legal.footer_whitepaper');
    whitepaperLink.style.cssText = `
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.875rem;
      font-family: monospace;
      transition: color 0.2s;
    `;
    whitepaperLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = '/whitepaper';
    });
    whitepaperLink.addEventListener('mouseenter', () => {
      whitepaperLink.style.color = 'var(--text-primary)';
    });
    whitepaperLink.addEventListener('mouseleave', () => {
      whitepaperLink.style.color = 'var(--text-muted)';
    });

    legalLinks.appendChild(whitepaperLink);
    nav.appendChild(legalLinks);

    if (!this.props.currentUser) {
      // Sign in and Sign up buttons for guests
      const authButtons = document.createElement('div');
      authButtons.className = 'nav-auth-buttons';
      authButtons.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        margin-top: 1rem;
      `;

      // Sign up button
      const signUpButton = document.createElement('button');
      signUpButton.className = 'nav-signin-button';
      signUpButton.textContent = 'Sign up';
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
      `;
      signUpButton.addEventListener('mouseenter', () => {
        signUpButton.style.opacity = '0.8';
      });
      signUpButton.addEventListener('mouseleave', () => {
        signUpButton.style.opacity = '1';
      });
      signUpButton.addEventListener('click', () => {
        this.props.onSignUp?.();
      });

      // Sign in button
      const signInButton = document.createElement('button');
      signInButton.className = 'nav-signin-button';
      signInButton.textContent = 'Sign in';
      signInButton.style.cssText = `
        padding: 0.75rem 1.5rem;
        background: transparent;
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: 9999px;
        cursor: pointer;
        font-size: 0.875rem;
        font-weight: 600;
        transition: background 0.2s;
      `;
      signInButton.addEventListener('mouseenter', () => {
        signInButton.style.background = 'var(--bg-secondary)';
      });
      signInButton.addEventListener('mouseleave', () => {
        signInButton.style.background = 'transparent';
      });
      signInButton.addEventListener('click', () => {
        this.props.onSignIn?.();
      });

      authButtons.appendChild(signUpButton);
      authButtons.appendChild(signInButton);
      nav.appendChild(authButtons);
    }

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

    // Update active state
    this.element.querySelectorAll('.nav-item').forEach((navItem) => {
      const navId = navItem.getAttribute('data-nav-id');
      if (navId === item) {
        navItem.classList.add('nav-item--active');
      } else {
        navItem.classList.remove('nav-item--active');
      }
    });
  }

  public getActiveItem(): string {
    return this.activeItem;
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public setUnreadCount(count: number): void {
    this.props.unreadCount = count;

    // Update user chip badge
    const userBadge = this.element.querySelector('.nav-user-area .nav-user-badge') as HTMLElement | null;
    if (userBadge) {
      if (count > 0) {
        userBadge.textContent = count >= 99 ? '99+' : formatCount(count);
        userBadge.style.display = '';
      } else {
        userBadge.style.display = 'none';
      }
    }

    // Update popup notifications item badge
    const notifItem = this.element.querySelector(
      '.nav-user-popup-item[data-nav-id="notifications"]',
    ) as HTMLElement | null;
    if (!notifItem) return;

    const existingBadge = notifItem.querySelector('.nav-badge') as HTMLElement | null;
    if (count > 0) {
      if (existingBadge) {
        existingBadge.textContent = count >= 99 ? '99+' : formatCount(count);
      } else {
        const badge = document.createElement('span');
        badge.className = 'nav-badge';
        badge.style.cssText = `
          margin-left: auto;
          background: var(--accent);
          font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 0.75rem;
          padding: 2px 8px;
          border-radius: 9999px;
          min-width: 20px;
          text-align: center;
        `;
        badge.textContent = count >= 99 ? '99+' : formatCount(count);
        notifItem.appendChild(badge);
      }
    } else if (existingBadge) {
      existingBadge.textContent = '';
      existingBadge.style.display = 'none';
      existingBadge.remove();
    }
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
    // Clean up window event listeners
    window.removeEventListener('resize', this.boundHandleResize);
    window.removeEventListener('modalchange', this.boundHandleModalChange);

    // Clean up popup document listener
    this.closePopup();

    // Clean up event listeners and remove element
    this.element.remove();
  }
}

// Factory function for easier usage
export function createLeftNav(props: LeftNavProps = {}): LeftNav {
  return new LeftNav(props);
}

// Update function to handle user changes
export function updateLeftNavUser(
  leftNav: LeftNav,
  currentUser: {
    id: string;
    username: string;
    display_name?: string;
    avatar_key?: string;
  } | null,
): void {
  // Update the props
  leftNav.props.currentUser = currentUser;

  // Remove existing user area if present
  const existingUserArea = leftNav.getElement().querySelector('.nav-user-area');
  if (existingUserArea) {
    existingUserArea.remove();
  }

  // Remove existing auth buttons if present (guest state)
  const existingAuthButtons = leftNav.getElement().querySelector('.nav-auth-buttons');
  if (existingAuthButtons) {
    existingAuthButtons.remove();
  }

  // Remove existing legal links if present
  const existingLegalLinks = leftNav.getElement().querySelector('.nav-legal-links');
  if (existingLegalLinks) {
    existingLegalLinks.remove();
  }

  // Rebuild navigation items
  const navItems = leftNav.getElement().querySelector('.nav-items');
  if (navItems) {
    navItems.innerHTML = '';

    if (currentUser) {
      // Full navigation for logged-in users
      const items = [
        { id: 'home', label: t('nav.home'), icon: '🏠' },
        { id: 'explore', label: t('nav.explore'), icon: '🔍' },
        { id: 'arcade', label: t('nav.arcade'), icon: '🕹️' },
        { id: 'profile', label: t('nav.profile'), icon: '👤' },
      ];

      items.forEach((item) => {
        const navItem = document.createElement('button');
        navItem.className = `nav-item ${leftNav.getActiveItem() === item.id ? 'nav-item--active' : ''}`;
        navItem.setAttribute('data-nav-id', item.id);
        navItem.innerHTML = `<span style="margin-right: 0.75rem;">${item.icon}</span><span>${item.label}</span>`;

        navItem.addEventListener('click', () => {
          leftNav.setActiveItem(item.id);
          leftNav.props.onNavigate?.(item.id);
        });
        navItems.appendChild(navItem);
      });
    } else {
      // Simplified navigation for guests
      const items = [
        { id: 'home', label: t('nav.home'), icon: '🏠' },
        { id: 'explore', label: t('nav.explore'), icon: '🔍' },
        { id: 'arcade', label: t('nav.arcade'), icon: '🕹️' },
        { id: 'settings', label: t('nav.settings'), icon: '⚙️' },
      ];

      items.forEach((item) => {
        const navItem = document.createElement('button');
        navItem.className = `nav-item ${leftNav.getActiveItem() === item.id ? 'nav-item--active' : ''}`;
        navItem.setAttribute('data-nav-id', item.id);
        navItem.innerHTML = `<span style="margin-right: 0.75rem;">${item.icon}</span><span>${item.label}</span>`;
        navItem.addEventListener('click', () => {
          leftNav.setActiveItem(item.id);
          leftNav.props.onNavigate?.(item.id);
        });
        navItems.appendChild(navItem);
      });
    }
  }

  // Add legal links (privacy policy and terms)
  const legalLinks = document.createElement('div');
  legalLinks.className = 'nav-legal-links';
  legalLinks.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  `;

  // Create About flaxia link
  const aboutLink = document.createElement('a');
  aboutLink.href = '/about';
  aboutLink.textContent = t('legal.footer_about');
  aboutLink.style.cssText = `
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.875rem;
    font-family: monospace;
    transition: color 0.2s;
  `;
  aboutLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.location.href = '/about';
  });
  aboutLink.addEventListener('mouseenter', () => {
    aboutLink.style.color = 'var(--text-primary)';
  });
  aboutLink.addEventListener('mouseleave', () => {
    aboutLink.style.color = 'var(--text-muted)';
  });

  const termsLink = document.createElement('a');
  termsLink.href = '/terms';
  termsLink.textContent = t('legal.footer_terms');
  termsLink.style.cssText = `
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.875rem;
    transition: color 0.2s;
  `;
  termsLink.addEventListener('mouseenter', () => {
    termsLink.style.color = 'var(--text-primary)';
  });
  termsLink.addEventListener('mouseleave', () => {
    termsLink.style.color = 'var(--text-muted)';
  });

  const privacyLink = document.createElement('a');
  privacyLink.href = '/privacy';
  privacyLink.textContent = t('legal.footer_privacy');
  privacyLink.style.cssText = `
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.875rem;
    transition: color 0.2s;
  `;
  privacyLink.addEventListener('mouseenter', () => {
    privacyLink.style.color = 'var(--text-primary)';
  });
  privacyLink.addEventListener('mouseleave', () => {
    privacyLink.style.color = 'var(--text-muted)';
  });

  legalLinks.appendChild(aboutLink);
  legalLinks.appendChild(termsLink);
  legalLinks.appendChild(privacyLink);

  // Create White Paper link
  const whitepaperLink = document.createElement('a');
  whitepaperLink.href = '/whitepaper';
  whitepaperLink.textContent = t('legal.footer_whitepaper');
  whitepaperLink.style.cssText = `
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.875rem;
    font-family: monospace;
    transition: color 0.2s;
  `;
  whitepaperLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.location.href = '/whitepaper';
  });
  whitepaperLink.addEventListener('mouseenter', () => {
    whitepaperLink.style.color = 'var(--text-primary)';
  });
  whitepaperLink.addEventListener('mouseleave', () => {
    whitepaperLink.style.color = 'var(--text-muted)';
  });

  legalLinks.appendChild(whitepaperLink);
  leftNav.getElement().appendChild(legalLinks);

  // User account area (logged-in users only)
  if (currentUser) {
    const userArea = document.createElement('div');
    userArea.className = 'nav-user-area';

    const avatar = document.createElement('div');
    avatar.className = 'nav-user-avatar';
    if (currentUser.avatar_key) {
      avatar.style.backgroundImage = `url(/api/images/${currentUser.avatar_key})`;
    } else {
      avatar.textContent = (currentUser.display_name || currentUser.username).charAt(0).toUpperCase();
      avatar.style.background = 'var(--accent)';
    }

    const info = document.createElement('div');
    info.className = 'nav-user-info';

    const name = document.createElement('div');
    name.className = 'nav-user-name';

    const nameText = document.createElement('span');
    nameText.className = 'nav-user-name-text';
    nameText.textContent = currentUser.display_name || currentUser.username;

    const badge = document.createElement('span');
    badge.className = 'nav-user-badge';
    badge.style.display = 'none';

    name.appendChild(nameText);
    name.appendChild(badge);

    const handle = document.createElement('div');
    handle.className = 'nav-user-handle';
    handle.textContent = `@${currentUser.username}`;

    info.appendChild(name);
    info.appendChild(handle);

    const caret = document.createElement('span');
    caret.className = 'nav-user-caret';
    caret.textContent = '▼';

    userArea.appendChild(avatar);
    userArea.appendChild(info);
    userArea.appendChild(caret);

    // Init badge count
    if (leftNav.props.unreadCount && leftNav.props.unreadCount > 0) {
      const count = leftNav.props.unreadCount >= 99 ? '99+' : String(leftNav.props.unreadCount);
      badge.textContent = count;
      badge.style.display = '';
    }

    // Popup menu
    const popup = document.createElement('div');
    popup.className = 'nav-user-popup';

    const menuItems = [
      { id: 'profile', label: t('nav.profile'), icon: '👤' },
      { id: 'notifications', label: t('nav.notifications'), icon: '🔔' },
      { id: 'bookmarks', label: t('nav.bookmarks'), icon: '🔖' },
      { id: 'settings', label: t('nav.settings'), icon: '⚙️' },
    ];

    menuItems.forEach((item) => {
      const popupItem = document.createElement('button');
      popupItem.className = 'nav-user-popup-item';
      popupItem.setAttribute('data-nav-id', item.id);
      popupItem.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;

      // Unread badge for notifications in popup
      if (item.id === 'notifications' && (leftNav.props.unreadCount ?? 0) > 0) {
        const notifBadge = document.createElement('span');
        notifBadge.className = 'nav-badge';
        notifBadge.style.cssText = `
          margin-left: auto;
          background: var(--accent);
          font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 0.75rem;
          padding: 2px 8px;
          border-radius: 9999px;
          min-width: 20px;
          text-align: center;
        `;
        const count = leftNav.props.unreadCount ?? 0;
        notifBadge.textContent = count >= 99 ? '99+' : String(count);
        popupItem.appendChild(notifBadge);
      }

      popupItem.addEventListener('click', (e) => {
        e.stopPropagation();
        leftNav.closePopup();
        leftNav.props.onNavigate?.(item.id);
      });
      popup.appendChild(popupItem);
    });

    userArea.appendChild(popup);

    userArea.addEventListener('click', (e) => {
      e.stopPropagation();
      leftNav.togglePopup();
    });

    leftNav.getElement().insertBefore(userArea, legalLinks);
  }

  if (!currentUser) {
    // Add auth buttons for guests
    const authButtons = document.createElement('div');
    authButtons.className = 'nav-auth-buttons';
    authButtons.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-top: 1rem;
    `;

    const signUpButton = document.createElement('button');
    signUpButton.className = 'nav-signin-button';
    signUpButton.textContent = 'Sign up';
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
    `;
    signUpButton.addEventListener('mouseenter', () => {
      signUpButton.style.opacity = '0.8';
    });
    signUpButton.addEventListener('mouseleave', () => {
      signUpButton.style.opacity = '1';
    });
    signUpButton.addEventListener('click', () => {
      leftNav.props.onSignUp?.();
    });

    authButtons.appendChild(signUpButton);
    leftNav.getElement().appendChild(authButtons);
  }
}
