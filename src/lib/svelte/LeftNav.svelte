<script lang="ts">
import { onMount } from 'svelte';
import { applyNameColor } from '../../../shared/name-color.ts';
import { recommendedAppPlatform } from '../app-download.ts';
import { attachPlusBadge } from '../avatar.ts';
import { detectDevicePlatform } from '../device-platform.ts';
import { formatCount } from '../format.ts';
import { getLocale, t } from '../i18n.ts';
import { closeLeftNav } from '../left-nav-drawer.ts';
import { setupLeftNavResize } from '../left-nav-resize.ts';
import { isModalOpen } from '../modal-state.ts';
import { isNativeApp, nativeApiHref } from '../native-api.ts';
import { navItemsFor } from '../nav-items.ts';
import { navigate } from '../navigation.ts';
import { iconHtml } from '../post/icon-html.ts';

interface LeftNavUser {
  id: string;
  username: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
  name_color?: string | null;
}

interface LeftNavProps {
  activeItem?: string;
  unreadCount?: number;
  mailUnreadCount?: number;
  onNavigate?: (item: string) => void;
  onSignIn?: () => void;
  onSignUp?: () => void;
  currentUser?: LeftNavUser | null;
}

interface TrendingTag {
  tag: string;
  count: number;
}

let { props = {} }: { props?: LeftNavProps } = $props();

let root: HTMLElement;
let avatarEl: HTMLDivElement;
let nameEl: HTMLSpanElement;

let popupOpen = $state(false);
let tags = $state<TrendingTag[]>([]);
let hiddenForModal = $state(false);
let showAppPromo = $state(false);

const user = $derived(props.currentUser ?? null);
const active = $derived(props.activeItem ?? 'home');
const unread = $derived(props.unreadCount ?? 0);
const mailUnread = $derived(props.mailUnreadCount ?? 0);
const navItems = $derived(navItemsFor(Boolean(user)));
const displayName = $derived(user?.display_name || user?.username || '');
const userInitial = $derived((user?.display_name || user?.username || '?').charAt(0).toUpperCase());
const avatarStyle = $derived(
  user?.avatar_key ? `background-image: url(${nativeApiHref(`/api/images/${user.avatar_key}`)})` : '',
);

function label(ja: string, en: string): string {
  return getLocale().startsWith('ja') ? ja : en;
}

function go(item: string): void {
  props.onNavigate?.(item);
}

function togglePopup(event: MouseEvent): void {
  event.stopPropagation();
  popupOpen = !popupOpen;
}

function onDocumentClick(event: MouseEvent): void {
  const area = root?.querySelector('.nav-user-area');
  if (area && !area.contains(event.target as Node)) popupOpen = false;
}

function updateModalVisibility(): void {
  hiddenForModal = window.innerWidth <= 768 && isModalOpen();
}

$effect(() => {
  if (!popupOpen) return;
  document.addEventListener('click', onDocumentClick);
  return () => document.removeEventListener('click', onDocumentClick);
});

$effect(() => {
  const badge = user?.badge_type ?? null;
  const color = user?.name_color ?? null;
  if (avatarEl) {
    avatarEl.querySelector(':scope > .avatar-plus-badge')?.remove();
    avatarEl.classList.remove('avatar-plus-host');
    attachPlusBadge(avatarEl, badge);
  }
  if (nameEl) {
    nameEl.style.color = '';
    applyNameColor(nameEl, color, badge);
  }
});

onMount(() => {
  const cleanupResize = setupLeftNavResize(root);
  // Drawer listeners live on the root; rebuilding is no longer needed when
  // auth props change, so one setup is enough.
  void import('../left-nav-drawer.ts').then(({ setupMobileLeftNav }) => setupMobileLeftNav(root));
  showAppPromo = !isNativeApp() && Boolean(recommendedAppPlatform(detectDevicePlatform()));
  updateModalVisibility();
  window.addEventListener('modalchange', updateModalVisibility);
  window.addEventListener('resize', updateModalVisibility);

  void (async () => {
    try {
      const response = await fetch('/api/tags/trending');
      if (!response.ok) return;
      const data = (await response.json()) as { tags?: TrendingTag[] };
      tags = (data.tags ?? []).slice(0, 5);
    } catch {
      // Tags are a progressive enhancement.
    }
  })();

  return () => {
    window.removeEventListener('modalchange', updateModalVisibility);
    window.removeEventListener('resize', updateModalVisibility);
    cleanupResize();
  };
});

const popupItems = [
  { id: 'profile', key: 'nav.profile', icon: 'profile' },
  { id: 'mail', key: 'nav.mail', icon: 'mail' },
  { id: 'maps', key: 'nav.maps', icon: 'maps' },
  { id: 'translate', key: 'nav.translate', icon: 'translate' },
  { id: 'settings', key: 'nav.settings', icon: 'settings' },
] as const;
</script>

<nav
  class="left-nav"
  aria-label="Primary"
  bind:this={root}
  style={hiddenForModal ? 'display: none;' : ''}
>
  <div class="nav-brand">
    <button type="button" class="nav-brand-inner" aria-label={t('nav.logo')} onclick={() => go('home')}>
      <img class="nav-brand-mark" src="/favicon.ico" alt="" />
      <span class="nav-brand-name">{t('nav.logo')}</span>
    </button>
  </div>

  <section class="nav-section nav-section--menu">
    <div class="nav-items nav-items--menu">
      {#each navItems as item (item.id)}
        <button
          type="button"
          class="nav-item"
          class:nav-item--active={active === item.id}
          data-nav-id={item.id}
          aria-current={active === item.id ? 'page' : 'false'}
          onclick={() => go(item.id)}
        >
          <span class="nav-item-icon">{@html iconHtml(item.icon, 18)}</span>
          <span class="nav-item-label">{t(item.labelKey)}</span>
          {#if item.id === 'notifications' && unread > 0}
            <span class="nav-dm-badge">{unread >= 99 ? '99+' : unread}</span>
          {/if}
        </button>
      {/each}
    </div>
  </section>

  {#if tags.length > 0}
    <section class="nav-section nav-section--tags">
      <h2 class="nav-section-label fx-label">{label('タグ', 'Tags')}</h2>
      <div class="nav-tags">
        {#each tags as item (item.tag)}
          <a
            class="nav-tag"
            href={`/explore?tag=${encodeURIComponent(item.tag)}`}
            onclick={(event) => {
              event.preventDefault();
              void navigate(`/explore?tag=${encodeURIComponent(item.tag)}`);
            }}
          >
            <span class="nav-tag-hash">#</span>
            <span class="nav-tag-name">{item.tag}</span>
            <span class="nav-tag-count">{formatCount(item.count)}</span>
          </a>
        {/each}
      </div>
    </section>
  {/if}

  {#if !user}
    <div class="nav-promo">
      <div class="nav-promo-art" aria-hidden="true">🎮</div>
      <p class="nav-promo-title">{t('nav.promo_title')}</p>
      <ul class="nav-promo-list">
        {#each ['nav.promo_item_share', 'nav.promo_item_discover', 'nav.promo_item_community'] as key (key)}
          <li>
            <span class="nav-promo-check">{@html iconHtml('check', 12)}</span>
            <span>{t(key)}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <div class="nav-footer">
    {#if user}
      <div class="nav-user-area" onclick={togglePopup}>
        <div class="nav-user-avatar" bind:this={avatarEl} style={avatarStyle}>
          {#if !user.avatar_key}{userInitial}{/if}
        </div>
        <div class="nav-user-info">
          <div class="nav-user-name">
            <span class="nav-user-name-text" bind:this={nameEl}>{displayName}</span>
          </div>
          <div class="nav-user-handle">@{user.username}</div>
        </div>
        <span class="nav-user-caret nav-user-kebab" class:nav-user-caret--open={popupOpen}>⋯</span>

        <div class="nav-user-popup" class:nav-user-popup--open={popupOpen}>
          {#each popupItems as item (item.id)}
            <button
              type="button"
              class="nav-user-popup-item"
              class:nav-user-popup-item--active={active === item.id}
              data-nav-id={item.id}
              aria-current={active === item.id ? 'page' : undefined}
              onclick={(event) => {
                event.stopPropagation();
                popupOpen = false;
                go(item.id);
              }}
            >
              <span class="nav-popup-icon">{@html iconHtml(item.icon, 16)}</span>
              <span>{t(item.key)}</span>
              {#if item.id === 'mail' && mailUnread > 0}
                <span class="nav-dm-badge">{mailUnread >= 99 ? '99+' : mailUnread}</span>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {:else}
      <div class="nav-auth-buttons">
        <button
          type="button"
          class="nav-signin-button"
          aria-label={t('nav.register')}
          title={t('nav.register')}
          onclick={() => props.onSignUp?.()}
        >
          <span class="nav-auth-icon">{@html iconHtml('user', 16)}</span>
          <span class="nav-auth-label">{t('nav.register')}</span>
        </button>
        <button
          type="button"
          class="nav-signin-button"
          aria-label={t('nav.login')}
          title={t('nav.login')}
          onclick={() => props.onSignIn?.()}
        >
          <span class="nav-auth-icon">{@html iconHtml('key', 16)}</span>
          <span class="nav-auth-label">{t('nav.login')}</span>
        </button>
      </div>
    {/if}

    {#if showAppPromo}
      <a
        class="nav-app-promo"
        href="/download"
        aria-label={t('app_download.title')}
        title={t('app_download.title')}
        onclick={(event) => {
          event.preventDefault();
          void navigate('/download');
        }}
      >
        {@html iconHtml('download', 18)}
        <span class="nav-app-promo-text">{t('app_download.left_nav_promo')}</span>
      </a>
    {/if}

    <div class="nav-legal-links">
      {#each [
        { href: '/about', label: t('legal.footer_about') },
        { href: '/terms', label: t('legal.footer_terms') },
        { href: '/privacy', label: t('legal.footer_privacy') },
        { href: '/child-safety', label: t('legal.footer_child_safety') },
        { href: '/docs', label: t('legal.footer_docs') },
      ] as link (link.href)}
        <a
          href={link.href}
          onclick={(event) => {
            event.preventDefault();
            void navigate(link.href);
          }}>{link.label}</a
        >
      {/each}
    </div>
  </div>
</nav>
