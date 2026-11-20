<script lang="ts">
import { onMount } from 'svelte';
import { canUsePostColors } from '../../../shared/entitlements.ts';
import { applyNameColor } from '../../../shared/name-color.ts';
import { parsePostColors } from '../../../shared/post-colors.ts';
import { stripMediaCues } from '../../../shared/post-cues.ts';
import type { QuotedPost } from '../../../shared/types/post.ts';
import { attachPlusBadge } from '../avatar.ts';
import { t } from '../i18n.ts';
import { nativeApiHref } from '../native-api.ts';
import { mountTitleBadge } from '../post/header-badge.ts';
import { mountQuotedAttachment } from '../post/quoted-media.ts';
import { renderColorizedText } from '../post-colors-dom.ts';

interface Props {
  quoted: QuotedPost | null;
  disableNavigation?: boolean;
  onNavigateToThread: (postId: string) => void;
}

let props: Props = $props();

let card: HTMLDivElement;
let avatar: HTMLSpanElement;
let name: HTMLSpanElement;
let body: HTMLDivElement;
let badgeHost: HTMLSpanElement;
let attachmentHost: HTMLDivElement;

function navigate(): void {
  if (props.quoted) props.onNavigateToThread(props.quoted.id);
}

onMount(() => {
  const quoted = props.quoted;
  if (!quoted) return;
  const avatarImage = quoted.avatar_url
    ? quoted.avatar_url
    : quoted.avatar_key
      ? nativeApiHref(`/api/images/${quoted.avatar_key}`)
      : null;
  if (avatarImage && avatar) {
    avatar.style.backgroundImage = `url(${avatarImage})`;
    avatar.style.backgroundSize = 'cover';
    avatar.style.backgroundPosition = 'center';
    avatar.textContent = '';
  }
  if (avatar) attachPlusBadge(avatar, (quoted.badge_type as never) ?? null);
  if (name) applyNameColor(name, (quoted.name_color as never) ?? null, (quoted.badge_type as never) ?? null);
  if (badgeHost) mountTitleBadge(badgeHost, quoted as never);

  if (body) {
    const colored = canUsePostColors({ badge_type: quoted.badge_type })
      ? parsePostColors(stripMediaCues(quoted.text || ''))
      : null;
    if (colored) body.appendChild(renderColorizedText(colored.plain, colored.spans));
    else body.textContent = stripMediaCues(quoted.text || '').replace(/\\\{/g, '{');
  }
  if (attachmentHost) mountQuotedAttachment(attachmentHost, quoted);
});
</script>

<div
  bind:this={card}
  class="quoted-post-card"
  style="cursor: {props.disableNavigation ? 'default' : 'pointer'};"
  role={props.disableNavigation ? undefined : 'link'}
  tabindex={props.disableNavigation ? undefined : '0'}
  onclick={(e) => { e.stopPropagation(); navigate(); }}
  onkeydown={(e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    navigate();
  }}
>
  {#if !props.quoted}
    <div class="quoted-post-unavailable">{t('post.quote_unavailable')}</div>
  {:else}
    <div class="quoted-post-author">
      <span bind:this={avatar} class="quoted-post-avatar">{props.quoted.avatar_url || props.quoted.avatar_key ? '' : (props.quoted.display_name || props.quoted.username || '?').charAt(0).toUpperCase()}</span>
      <span bind:this={name} class="quoted-post-name">{props.quoted.display_name || props.quoted.username || ''}</span>
      <span class="quoted-post-username">{props.quoted.username ? `@${props.quoted.username}` : ''}</span>
      <span bind:this={badgeHost} class="post-title-badge-host"></span>
    </div>
    <div bind:this={body} class="quoted-post-text"></div>
    <div bind:this={attachmentHost} class="quoted-post-attachment-host"></div>
  {/if}
</div>
