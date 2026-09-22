import { t } from '../lib/i18n.js';
import { type IconName, icon } from '../lib/icons.js';

export interface BottomNavProps {
  activeItem?: string;
  currentUser?: {
    id: string;
    username: string;
    display_name?: string;
    avatar_key?: string;
  } | null;
  onNavigate?: (item: string) => void;
  onSignIn?: () => void;
  onSignUp?: () => void;
}

/**
 * Mobile-only bottom navigation bar. Rendered as a single global instance and
 * shown only on small screens via CSS. Contains Home / Explore / Arcade /
 * Notifications plus a contextual right-most item: the account avatar (logged in)
 * or a sign-in button (guest).
 */
export class BottomNav {
  private element: HTMLElement;
  private props: BottomNavProps;
  private activeItem: string;

  constructor(props: BottomNavProps = {}) {
    this.props = props;
    this.activeItem = props.activeItem || 'home';
    this.element = this.createElement();
  }

  private createElement(): HTMLElement {
    const nav = document.createElement('nav');
    nav.className = 'bottom-nav';
    nav.appendChild(this.buildItems());
    return nav;
  }

  private buildItems(): DocumentFragment {
    const frag = document.createDocumentFragment();

    const items = [
      { id: 'home', label: t('nav.home'), icon: 'home' as IconName },
      { id: 'explore', label: t('nav.explore'), icon: 'search' as IconName },
      { id: 'arcade', label: t('nav.arcade'), icon: 'game' as IconName },
      { id: 'notifications', label: t('nav.notifications'), icon: 'notifications' as IconName },
    ];

    items.forEach((item) => {
      frag.appendChild(this.createItem(item.id, item.label, item.icon, this.activeItem === item.id));
    });

    if (this.props.currentUser) {
      frag.appendChild(this.createAccountItem(this.activeItem === 'account'));
    } else {
      frag.appendChild(this.createLoginItem());
    }

    return frag;
  }

  private buildIconSpan(name: IconName): HTMLElement {
    const span = document.createElement('span');
    span.className = 'bottom-nav-icon';
    span.appendChild(icon(name));
    return span;
  }

  private createItem(id: string, label: string, iconName: IconName, active: boolean): HTMLElement {
    const btn = document.createElement('button');
    btn.className = `bottom-nav-item ${active ? 'bottom-nav-item--active' : ''}`;
    btn.setAttribute('data-nav-id', id);
    btn.appendChild(this.buildIconSpan(iconName));
    const labelSpan = document.createElement('span');
    labelSpan.className = 'bottom-nav-label';
    labelSpan.textContent = label;
    btn.appendChild(labelSpan);

    btn.addEventListener('click', () => {
      if (id === 'notifications' && !this.props.currentUser) {
        this.props.onSignIn?.();
        return;
      }
      this.setActiveItem(id);
      this.props.onNavigate?.(id);
    });

    return btn;
  }

  private createAccountItem(active: boolean): HTMLElement {
    const btn = document.createElement('button');
    btn.className = `bottom-nav-item ${active ? 'bottom-nav-item--active' : ''}`;
    btn.setAttribute('data-nav-id', 'account');

    const user = this.props.currentUser!;
    if (user.avatar_key) {
      btn.innerHTML = `<span class="bottom-nav-avatar" style="background-image:url(/api/images/${user.avatar_key})"></span>`;
    } else {
      const initial = (user.display_name || user.username || '?').charAt(0).toUpperCase();
      btn.innerHTML = `<span class="bottom-nav-avatar bottom-nav-avatar--initial">${initial}</span>`;
    }

    btn.addEventListener('click', () => {
      this.setActiveItem('account');
      this.props.onNavigate?.('account');
    });

    return btn;
  }

  private createLoginItem(): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'bottom-nav-item bottom-nav-login';
    btn.setAttribute('data-nav-id', 'login');
    btn.appendChild(this.buildIconSpan('key'));
    const labelSpan = document.createElement('span');
    labelSpan.className = 'bottom-nav-label';
    labelSpan.textContent = t('nav.login');
    btn.appendChild(labelSpan);
    btn.addEventListener('click', () => {
      this.props.onSignIn?.();
    });
    return btn;
  }

  private rebuild(): void {
    this.element.innerHTML = '';
    this.element.appendChild(this.buildItems());
  }

  public setActiveItem(item: string): void {
    this.activeItem = item;
    this.element.querySelectorAll('.bottom-nav-item').forEach((el) => {
      const navId = el.getAttribute('data-nav-id');
      el.classList.toggle('bottom-nav-item--active', navId === item);
    });
  }

  public updateUser(user: BottomNavProps['currentUser']): void {
    this.props.currentUser = user ?? null;
    this.rebuild();
  }

  public getActiveItem(): string {
    return this.activeItem;
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    this.element.remove();
  }
}

export function createBottomNav(props: BottomNavProps = {}): BottomNav {
  return new BottomNav(props);
}
