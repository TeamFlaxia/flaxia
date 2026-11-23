<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// Mobile-only bottom navigation bar. Rendered once for the app and shown only
// on small screens via CSS. The legacy class exposes the same imperative API.
import { attachPlusBadge } from '../avatar.ts';
import { t } from '../i18n.ts';
import { nativeApiHref } from '../native-api.ts';
import { iconHtml } from '../post/icon-html.ts';
import { BOTTOM_NAV_ITEMS, bottomNavAvatarKey, bottomNavInitial } from './bottom-nav-model.ts';

export interface BottomNavUser {
  id: string;
  username: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
}

interface Props {
  activeItem?: string;
  currentUser?: BottomNavUser | null;
  onNavigate?: (item: string) => void;
  onSignIn?: () => void;
}

let { activeItem = 'home', currentUser = null, onNavigate, onSignIn }: Props = $props();

// Props seed the imperative API; later changes arrive through
// setActiveItem()/updateUser(), matching the legacy class semantics.
// svelte-ignore state_referenced_locally
let active = $state(activeItem);
// svelte-ignore state_referenced_locally
let user = $state<BottomNavUser | null>(currentUser);
let avatarEl = $state<HTMLSpanElement>();

const avatarKey = $derived(bottomNavAvatarKey(user?.avatar_key));
const avatarStyle = $derived(avatarKey ? `background-image: url(${nativeApiHref(`/api/images/${avatarKey}`)})` : '');

export function setActiveItem(item: string): void {
  active = item;
}

export function updateUser(next: BottomNavUser | null | undefined): void {
  user = next ?? null;
}

export function getActiveItem(): string {
  return active;
}

function go(item: string): void {
  if (item === 'notifications' && !user) {
    onSignIn?.();
    return;
  }
  active = item;
  onNavigate?.(item);
}

// The badge markup comes from the shared avatar helper; clear it first so an
// account switch cannot leave a stale badge behind.
$effect(() => {
  if (!avatarEl) return;
  avatarEl.querySelector(':scope > .avatar-plus-badge')?.remove();
  avatarEl.classList.remove('avatar-plus-host');
  attachPlusBadge(avatarEl, user?.badge_type);
});
</script>

<nav class="bottom-nav">
  {#each BOTTOM_NAV_ITEMS as item (item.id)}
    <button
      type="button"
      class="bottom-nav-item"
      class:bottom-nav-item--active={active === item.id}
      data-nav-id={item.id}
      aria-current={active === item.id ? 'page' : 'false'}
      onclick={() => go(item.id)}
    >
      <span class="bottom-nav-icon">{@html iconHtml(item.iconName, 16)}</span>
      <span class="bottom-nav-label">{t(item.labelKey)}</span>
    </button>
  {/each}

  {#if user}
    <button
      type="button"
      class="bottom-nav-item"
      class:bottom-nav-item--active={active === 'account'}
      data-nav-id="account"
      aria-current={active === 'account' ? 'page' : 'false'}
      onclick={() => go('account')}
    >
      {#if avatarKey}
        <span class="bottom-nav-avatar" bind:this={avatarEl} style={avatarStyle}></span>
      {:else}
        <span class="bottom-nav-avatar bottom-nav-avatar--initial" bind:this={avatarEl}>
          {bottomNavInitial(user.display_name || user.username)}
        </span>
      {/if}
    </button>
  {:else}
    <button type="button" class="bottom-nav-item bottom-nav-login" data-nav-id="login" onclick={() => onSignIn?.()}>
      <span class="bottom-nav-icon">{@html iconHtml('key', 16)}</span>
      <span class="bottom-nav-label">{t('nav.login')}</span>
    </button>
  {/if}
</nav>
