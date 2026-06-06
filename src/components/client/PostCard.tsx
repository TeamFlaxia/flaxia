'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCount } from '@/lib/format';
import { getLocale, t } from '@/lib/i18n';
import { impressionTracker } from '@/lib/impression-tracker';
import { registerModal } from '@/lib/modal-state';
import { SandboxBridge } from '@/lib/sandbox-bridge';
import type { Post, PostCardMode, PostCardProps } from '@/types/post';

function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return t('post_header.now');
  if (diffMins < 60) return t('post_header.minutes', { n: diffMins });
  if (diffHours < 24) return t('post_header.hours', { n: diffHours });
  if (diffDays < 7) return t('post_header.days', { n: diffDays });
  return date.toLocaleDateString();
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function unescapeHtml(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || '';
}

function parseMentions(mentions?: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!mentions) return map;
  try {
    const data = JSON.parse(mentions) as Array<{ username: string; user_id: string }>;
    for (const m of data) {
      map.set(m.username.toLowerCase(), m.user_id);
    }
  } catch {}
  return map;
}

interface MathPlaceholder {
  id: string;
  content: string;
  displayMode: boolean;
}

async function getMarkdownIt() {
  const MarkdownItModule = await import('markdown-it');
  const md = new MarkdownItModule.default({
    html: false,
    xhtmlOut: false,
    breaks: true,
    linkify: false,
    typographer: true,
  });
  md.block.ruler.disable(['heading', 'lheading']);
  return md;
}

function escapeMathNotation(text: string): { textWithPlaceholders: string; mathPlaceholders: MathPlaceholder[] } {
  const mathPlaceholders: MathPlaceholder[] = [];
  let placeholderId = 0;
  const mathRegex = /\$\$([^$]+)\$\$|\$([^$]+?)\$/g;
  const textWithPlaceholders = text.replace(mathRegex, (match, displayContent, inlineContent) => {
    const content = displayContent || inlineContent;
    const displayMode = !!displayContent;
    const id = `math-${placeholderId++}`;
    mathPlaceholders.push({ id, content: content.trim(), displayMode });
    return `\u26a1${id}\u26a1`;
  });
  return { textWithPlaceholders, mathPlaceholders };
}

function restoreMathPlaceholders(html: string, mathPlaceholders: MathPlaceholder[]): string {
  let restoredHtml = html;
  for (const placeholder of mathPlaceholders) {
    const placeholderRegex = new RegExp(`\u26a1${placeholder.id}\u26a1`, 'g');
    restoredHtml = restoredHtml.replace(
      placeholderRegex,
      `<span class="math-placeholder" data-math-content="${escapeHtml(placeholder.content)}" data-math-display="${placeholder.displayMode}"></span>`,
    );
  }
  return restoredHtml;
}

function renderMathElements(container: HTMLElement) {
  const mathElements = container.querySelectorAll('.math-placeholder');
  if (mathElements.length === 0) return;

  const w = window as unknown as Record<string, unknown>;
  if (!w.__katex) {
    import('katex').then((katexModule) => {
      w.__katex = katexModule.default;
      mathElements.forEach((el) => {
        const element = el as HTMLElement;
        const content = element.getAttribute('data-math-content') || '';
        const displayMode = element.getAttribute('data-math-display') === 'true';
        try {
          element.textContent = '';
          const katex = w.__katex as {
            render: (text: string, el: HTMLElement, opts: Record<string, unknown>) => void;
          };
          katex.render(unescapeHtml(content), element, {
            throwOnError: false,
            displayMode,
            output: 'mathml',
          });
          element.classList.remove('math-placeholder');
          element.classList.add(displayMode ? 'math-display' : 'math-inline');
        } catch {
          element.textContent = content;
          element.classList.add('math-error');
        }
      });
    });
  } else {
    mathElements.forEach((el) => {
      const element = el as HTMLElement;
      const content = element.getAttribute('data-math-content') || '';
      const displayMode = element.getAttribute('data-math-display') === 'true';
      try {
        element.textContent = '';
        const katex = w.__katex as {
          render: (text: string, el: HTMLElement, opts: Record<string, unknown>) => void;
        };
        katex.render(unescapeHtml(content), element, {
          throwOnError: false,
          displayMode,
          output: 'mathml',
        });
        element.classList.remove('math-placeholder');
        element.classList.add(displayMode ? 'math-display' : 'math-inline');
      } catch {
        element.textContent = content;
        element.classList.add('math-error');
      }
    });
  }
}

function linkifyHashtags(container: HTMLElement) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }
  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    const hashtagRegex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\u30fc]+)/gu;
    if (!hashtagRegex.test(text)) continue;
    hashtagRegex.lastIndex = 0;
    const parent = textNode.parentNode;
    if (!parent) continue;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = hashtagRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const hashtag = match[1];
      const span = document.createElement('span');
      span.className = 'hashtag-link';
      span.textContent = `#${hashtag}`;
      span.style.cursor = 'pointer';
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(hashtag)}`);
        window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'explore', tag: hashtag } }));
      });
      fragment.appendChild(span);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    parent.replaceChild(fragment, textNode);
  }
}

function linkifyUrls(container: HTMLElement) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }
  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    const urlRegex = /(?:https?:\/\/|www\.)[^\s<>()]+/g;
    if (!urlRegex.test(text)) continue;
    urlRegex.lastIndex = 0;
    const parent = textNode.parentNode;
    if (!parent) continue;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      let url = match[0];
      const displayUrl = url;
      if (url.startsWith('www.')) {
        url = 'https://' + url;
      }
      const link = document.createElement('a');
      link.href = url;
      link.className = 'url-link';
      link.textContent = displayUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      fragment.appendChild(link);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    parent.replaceChild(fragment, textNode);
  }
}

function linkifyMentions(container: HTMLElement, mentions?: string) {
  const mentionMap = parseMentions(mentions);
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }
  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    const mentionRegex = /@([a-zA-Z0-9_]{1,20})/g;
    if (!mentionRegex.test(text)) continue;
    mentionRegex.lastIndex = 0;
    const parent = textNode.parentNode;
    if (!parent) continue;
    if (parent.nodeName === 'A') continue;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const username = match[1];
      const userExists = mentionMap.has(username.toLowerCase());
      if (userExists) {
        const span = document.createElement('span');
        span.className = 'mention-link';
        span.textContent = `@${username}`;
        span.style.cursor = 'pointer';
        span.addEventListener('click', (e) => {
          e.stopPropagation();
          window.history.pushState({}, '', `/profile/${encodeURIComponent(username)}`);
          window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'profile', username } }));
        });
        fragment.appendChild(span);
      } else {
        fragment.appendChild(document.createTextNode(`@${username}`));
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    parent.replaceChild(fragment, textNode);
  }
}

function linkifyPostRefs(container: HTMLElement) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }
  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    const postRefRegex = />>(\d+)/g;
    if (!postRefRegex.test(text)) continue;
    postRefRegex.lastIndex = 0;
    const parent = textNode.parentNode;
    if (!parent) continue;
    if (parent.nodeName === 'A') continue;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = postRefRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const link = document.createElement('a');
      link.href = `#post-${match[1]}`;
      link.className = 'post-ref-link';
      link.textContent = `>>${match[1]}`;
      link.dataset.postIndex = match[1];
      fragment.appendChild(link);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    parent.replaceChild(fragment, textNode);
  }
}

function PollElement({ poll, postId }: { poll: NonNullable<Post['poll']>; postId: string }) {
  const [pollState, setPollState] = useState({ ...poll, expired: false });

  const totalVotes = pollState.options.reduce((sum, opt) => sum + Number(opt.votes_count || 0), 0);
  const hasVoted = !!pollState.userVote;
  const isExpired = pollState.expired;
  const showResults = hasVoted || isExpired;

  const handleVote = useCallback(
    async (optionId: string) => {
      try {
        const response = await fetch(`/api/polls/${pollState.id}/vote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ optionId }),
        });
        if (response.status === 409) return;
        if (!response.ok) {
          const errBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          if (errBody?.error) console.error(t('poll.vote_error'), errBody.error);
          return;
        }
        const data = (await response.json()) as {
          options: Array<{ id: string; label: string; votes_count: number }>;
          userVote: string | null;
        };
        setPollState((prev) => ({ ...prev, options: data.options, userVote: data.userVote }));
      } catch (e) {
        console.error('Vote failed:', e);
      }
    },
    [pollState.id],
  );

  const formatRemainingTime = (endsAt: string): string => {
    const diff = new Date(endsAt).getTime() - Date.now();
    if (diff <= 0) return t('poll.ended');
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(hours / 24);
    const minutes = Math.floor((diff % 3600000) / 60000);
    if (days > 0) return t('poll.remaining_days', { count: days });
    if (hours > 0) return t('poll.remaining_hours', { count: hours });
    if (minutes > 0) return t('poll.remaining_minutes', { count: minutes });
    return t('poll.remaining_less_minute');
  };

  const voteText =
    totalVotes === 1
      ? t('poll.votes', { count: formatCount(totalVotes) })
      : t('poll.votes_plural', { count: formatCount(totalVotes) });
  const votedText = hasVoted ? ` \u00b7 ${t('poll.voted')}` : '';
  const changeHint = hasVoted && !isExpired ? ` \u00b7 ${t('poll.click_to_change')}` : '';
  let timeText = '';
  if (pollState.endsAt && !isExpired) {
    const remaining = formatRemainingTime(pollState.endsAt);
    timeText = ` \u00b7 ${t('poll.remaining', { time: remaining })}`;
  }

  return (
    <div
      className="post-poll"
      style={{ margin: '12px 0', padding: '12px', background: 'var(--bg-secondary)', borderRadius: '8px' }}
    >
      <div className="poll-question" style={{ fontWeight: 600, marginBottom: '8px', color: 'var(--text-primary)' }}>
        {pollState.question}
      </div>
      {isExpired && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '6px' }}>{t('poll.ended')}</div>
      )}
      {pollState.options.map((opt) => {
        const pct = totalVotes > 0 ? Math.round((opt.votes_count / totalVotes) * 100) : 0;
        const isOwnVote = opt.id === pollState.userVote;
        const clickable = !isExpired && !isOwnVote;
        return (
          <div
            key={opt.id}
            className="poll-option"
            onClick={(e) => {
              e.stopPropagation();
              if (clickable) handleVote(opt.id);
            }}
            style={{
              position: 'relative',
              padding: '8px 12px',
              marginBottom: '6px',
              borderRadius: '6px',
              cursor: clickable ? 'pointer' : 'default',
              background: 'var(--bg-primary)',
              overflow: 'hidden',
              transition: 'opacity 0.2s',
              border: `1px solid ${isOwnVote ? 'var(--accent)' : 'var(--border)'}`,
              opacity: showResults || opt.votes_count > 0 ? 1 : 0.9,
            }}
            onMouseEnter={(e) => {
              if (clickable) (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)';
            }}
            onMouseLeave={(e) => {
              if (clickable) (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
            }}
          >
            <div
              className="poll-bar"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                height: '100%',
                background: 'var(--accent)',
                width: showResults ? `${pct}%` : 0,
                transition: 'width 0.5s ease',
                borderRadius: '5px',
                opacity: 0.25,
              }}
            />
            <span
              className="poll-option-label"
              style={{
                position: 'relative',
                zIndex: 1,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span>{opt.label}</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginLeft: '8px' }}>
                {showResults ? `${pct}%` : ''}
              </span>
            </span>
          </div>
        );
      })}
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
        {voteText}
        {votedText}
        {changeHint}
        {timeText}
      </div>
    </div>
  );
}

function TagChips({ hashtags }: { hashtags: string[] }) {
  if (hashtags.length === 0) return null;
  return (
    <div className="post-tag-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '12px 0' }}>
      {hashtags.map((tag) => (
        <span
          key={tag}
          className="post-tag-chip"
          style={{
            background: 'var(--bg-secondary)',
            color: 'var(--accent)',
            padding: '4px 12px',
            fontSize: '13px',
            borderRadius: '9999px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(tag)}`);
            window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'explore', tag } }));
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'var(--accent)';
            (e.currentTarget as HTMLElement).style.color = '#000';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'var(--bg-secondary)';
            (e.currentTarget as HTMLElement).style.color = 'var(--accent)';
          }}
        >
          #{tag}
        </span>
      ))}
    </div>
  );
}

function PostHeader({
  username,
  display_name,
  avatar_key,
  createdAt,
}: {
  username: string;
  display_name?: string;
  avatar_key?: string;
  createdAt: string;
}) {
  const avatarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!avatar_key || !avatarRef.current) return;
    const loadAvatar = () => {
      const img = new Image();
      img.onload = () => {
        if (avatarRef.current) {
          avatarRef.current.style.backgroundImage = `url(/api/images/${avatar_key})`;
          avatarRef.current.style.backgroundSize = 'cover';
          avatarRef.current.style.backgroundPosition = 'center';
          avatarRef.current.textContent = '';
        }
      };
      img.onerror = () => console.warn(`Failed to load avatar: ${avatar_key}`);
      img.src = `/api/images/${avatar_key}`;
    };
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback?.(loadAvatar, { timeout: 1000 });
    } else {
      setTimeout(loadAvatar, 100);
    }
  }, [avatar_key]);

  const navigateToProfile = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      window.history.pushState({}, '', `/profile/${username}`);
      window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'profile', username } }));
    },
    [username],
  );

  return (
    <div className="post-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <div
        ref={avatarRef}
        className="post-avatar"
        onClick={navigateToProfile}
        style={{
          cursor: 'pointer',
          width: '40px',
          height: '40px',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '1.2rem',
          color: 'white',
          background: 'var(--accent)',
          flexShrink: 0,
        }}
      >
        {username.charAt(0).toUpperCase()}
      </div>
      <span className="post-display-name" onClick={navigateToProfile} style={{ cursor: 'pointer', fontWeight: 'bold' }}>
        {display_name || username}
      </span>
      <span
        className="post-username"
        onClick={navigateToProfile}
        style={{ cursor: 'pointer', color: 'var(--text-muted)', marginLeft: '0.5rem' }}
      >
        @{username}
      </span>
      <span className="post-timestamp" style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
        {formatTimestamp(createdAt)}
      </span>
    </div>
  );
}

function getYouTubeId(url: string): string | null {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|&v=)([^#&?]*).*/i;
  const match = url.match(regExp);
  return match && match[2].length >= 11 ? match[2] : null;
}

function LinkPreview({ text }: { text: string }) {
  const [previewData, setPreviewData] = useState<{
    title: string;
    description: string;
    image: string;
    siteName: string;
    url: string;
    type?: string;
    video?: { url?: string; secureUrl?: string; type?: string; width?: number; height?: number };
  } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!text) return;
    const urlRegex = /(https?:\/\/[^\s<>()]+|www\.[^\s<>()]+)/i;
    const match = text.match(urlRegex);
    if (!match) return;
    let url = match[1];
    if (url.toLowerCase().startsWith('www.')) {
      url = 'https://' + url;
    }
    if (
      url.includes('/api/images/') ||
      url.includes('/api/audio/') ||
      url.includes('/api/zip/') ||
      url.includes('/api/swf/') ||
      url.includes('/api/thumbnail/') ||
      url.includes('/api/wvfs-zip/')
    ) {
      return;
    }
    setLoading(true);
    fetch(`/api/link-preview?url=${encodeURIComponent(url)}`)
      .then((res) => {
        if (!res.ok) throw new Error('Preview fetch failed');
        return res.json();
      })
      .then((data: unknown) => {
        const d = data as {
          title: string;
          description: string;
          image: string;
          siteName: string;
          url: string;
          type?: string;
          video?: { url?: string; secureUrl?: string; type?: string; width?: number; height?: number };
        };
        if (d && d.url) {
          setPreviewData(d);
        }
      })
      .catch((err) => console.warn('Failed to load link preview:', err))
      .finally(() => setLoading(false));
  }, [text]);

  if (loading || !previewData) return null;

  const youtubeId = getYouTubeId(previewData.url);
  const thumbnailSrc =
    youtubeId && !previewData.image ? `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg` : previewData.image;

  return (
    <a
      href={previewData.url}
      target="_blank"
      rel="noopener noreferrer"
      className="link-preview-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        border: '1px solid var(--border)',
        borderRadius: '12px',
        overflow: 'hidden',
        marginTop: '0.75rem',
        marginBottom: '1rem',
        textDecoration: 'none',
        color: 'inherit',
        background: 'var(--bg-secondary)',
        transition: 'background 0.2s, border-color 0.2s',
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'var(--bg-input)';
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'var(--bg-secondary)';
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
      }}
    >
      <div
        className="link-preview-image-container"
        style={{
          position: 'relative',
          minWidth: 0,
          paddingBottom: thumbnailSrc ? '52.25%' : '25%',
          background: thumbnailSrc
            ? 'var(--bg-input)'
            : 'linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(168, 85, 247, 0.15) 50%, rgba(236, 72, 153, 0.15) 100%), var(--bg-input)',
          overflow: 'hidden',
          borderBottom: '1px solid var(--border)',
        }}
      >
        {thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt=""
            loading="lazy"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
            onError={(e) => {
              const img = e.currentTarget;
              const container = img.parentElement;
              if (!container) return;
              img.style.display = 'none';
              container.style.paddingBottom = '25%';
              container.style.background =
                'linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(168, 85, 247, 0.15) 50%, rgba(236, 72, 153, 0.15) 100%), var(--bg-input)';
              const fallback = document.createElement('div');
              fallback.style.cssText =
                'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 2rem; opacity: 0.65; filter: drop-shadow(0 0 12px rgba(168, 85, 247, 0.4)); user-select: none;';
              fallback.textContent = '\ud83c\udf10';
              container.appendChild(fallback);
            }}
          />
        ) : (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              fontSize: '2rem',
              opacity: 0.65,
              filter: 'drop-shadow(0 0 12px rgba(168, 85, 247, 0.4))',
              userSelect: 'none',
            }}
          >
            {'\ud83c\udf10'}
          </div>
        )}
        {youtubeId && youtubeId && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '56px',
              height: '56px',
              borderRadius: '50%',
              background: 'rgba(239, 68, 68, 0.9)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'white',
              fontSize: '1.4rem',
              boxShadow: '0 0 16px rgba(239, 68, 68, 0.5)',
              pointerEvents: 'none',
              transition: 'transform 0.2s, background 0.2s',
            }}
          >
            <span style={{ marginLeft: '3px' }}>{'\u25b6'}</span>
          </div>
        )}
      </div>
      <div
        className="link-preview-text"
        style={{
          padding: '0.75rem 1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.25rem',
          minWidth: 0,
          wordBreak: 'break-word',
        }}
      >
        <div
          className="link-preview-site-name"
          style={{
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            fontFamily: 'monospace',
            textTransform: 'lowercase',
          }}
        >
          {previewData.siteName}
        </div>
        {previewData.title && (
          <div
            className="link-preview-title"
            style={{
              fontSize: '0.95rem',
              fontWeight: 600,
              color: 'var(--text-primary)',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {previewData.title}
          </div>
        )}
        {previewData.description && (
          <div
            className="link-preview-description"
            style={{
              fontSize: '0.825rem',
              color: 'var(--text-muted)',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              lineHeight: 1.4,
            }}
          >
            {previewData.description}
          </div>
        )}
      </div>
    </a>
  );
}

function ActionButton({
  type,
  count,
  isActive,
  onClick,
}: {
  type: 'fresh' | 'bookmark' | 'reply' | 'share' | 'impressions';
  count: string;
  isActive?: boolean;
  onClick?: () => void;
}) {
  const getIcon = () => {
    switch (type) {
      case 'fresh':
        return '\ud83c\udf42';
      case 'bookmark':
        return '\ud83d\udd16';
      case 'reply':
        return '\ud83d\udcac';
      case 'share':
        return '\ud83d\udd17';
      case 'impressions':
        return '\ud83d\udc40';
    }
  };

  return (
    <button
      className={`action-button action-button--${type}${isActive ? ' action-button--active' : ''}`}
      aria-label={t('post_actions.aria_label', { type })}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        background: 'none',
        border: 'none',
        cursor: type === 'impressions' ? 'default' : 'pointer',
        color: 'var(--text-muted)',
        fontSize: '0.875rem',
        padding: '4px 8px',
        borderRadius: '4px',
        transition: 'color 0.2s ease',
      }}
    >
      <span
        className="action-icon"
        style={{
          fontSize: type === 'impressions' ? '0.75rem' : undefined,
          opacity: type === 'impressions' ? 0.5 : undefined,
        }}
      >
        {getIcon()}
      </span>
      {type !== 'share' && <span className="action-count">{count}</span>}
    </button>
  );
}

export default function PostCard({
  post: initialPost,
  sandboxOrigin,
  initialMode,
  currentUser,
  onDelete,
  disableReply,
  disableReplyComposer,
  onReplyToggle,
  depth: depthProp,
  postIndex,
  enablePostRefs,
  disableNavigation,
  stripLeadingPostRef,
}: PostCardProps) {
  const [post] = useState(initialPost);
  const [mode, setMode] = useState<PostCardMode>(initialMode || ('preview' as PostCardMode));
  const [isFreshed, setIsFreshed] = useState(post.is_freshed || false);
  const [isBookmarked, setIsBookmarked] = useState(post.is_bookmarked || false);
  const [freshCount, setFreshCount] = useState(post.fresh_count);
  const [bookmarkCount, setBookmarkCount] = useState(post.bookmark_count);
  const [replyCount, setReplyCount] = useState(post.reply_count || 0);
  const [impressions, setImpressions] = useState(post.impressions || 0);
  const [isReplyComposerOpen, setIsReplyComposerOpen] = useState(false);
  const [translatedText, setTranslatedText] = useState<string | null>(null);
  const [showingOriginal, setShowingOriginal] = useState(true);
  const [richTextHtml, setRichTextHtml] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [freshLoading, setFreshLoading] = useState(false);
  const [bookmarkLoading, setBookmarkLoading] = useState(false);

  const cardRef = useRef<HTMLElement>(null);
  const richTextRef = useRef<HTMLDivElement>(null);
  const impressionTrackedRef = useRef(false);

  const displayText = useMemo(() => {
    return stripLeadingPostRef ? post.text.replace(/^\s*>>\d+\s*/g, '').trimStart() : post.text;
  }, [post.text, stripLeadingPostRef]);

  const hashtags = useMemo(() => {
    try {
      const parsed = JSON.parse(post.hashtags);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [post.hashtags]);

  // ---- Impression tracking ----
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !impressionTrackedRef.current) {
            impressionTrackedRef.current = true;
            impressionTracker.trackImpression(post.id);
            setImpressions((prev) => prev + 1);
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.5 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [post.id]);

  // ---- Rich text async rendering ----
  useEffect(() => {
    let cancelled = false;

    const renderRichText = async () => {
      try {
        const DOMPurify = await import('dompurify');

        const { textWithPlaceholders, mathPlaceholders } = escapeMathNotation(displayText);

        const refPlaceholders: { id: string; index: string }[] = [];
        const textWithRefPlaceholders = textWithPlaceholders.replace(/>>(\d+)/g, (_match, index) => {
          const id = `ref-${refPlaceholders.length}`;
          refPlaceholders.push({ id, index });
          return `\u26a1${id}\u26a1`;
        });

        const md = await getMarkdownIt();
        let html = md.render(textWithRefPlaceholders);

        html = restoreMathPlaceholders(html, mathPlaceholders);

        html = DOMPurify.default.sanitize(html, {
          ALLOWED_TAGS: [
            'p',
            'br',
            'strong',
            'em',
            'code',
            'pre',
            'blockquote',
            'hr',
            'ul',
            'ol',
            'li',
            'a',
            'span',
            'table',
            'thead',
            'tbody',
            'tr',
            'td',
            'th',
            's',
            'del',
            'img',
          ],
          ALLOWED_ATTR: [
            'href',
            'target',
            'rel',
            'class',
            'data-math-content',
            'data-math-display',
            'data-post-index',
            'colspan',
            'rowspan',
            'src',
            'alt',
            'title',
          ],
          ALLOW_DATA_ATTR: true,
        });

        for (const ref of refPlaceholders) {
          const placeholderRegex = new RegExp(`\u26a1${ref.id}\u26a1`, 'g');
          const replacement = enablePostRefs
            ? `<a class="post-ref-link" href="#post-${ref.index}" data-post-index="${ref.index}">>>${ref.index}</a>`
            : `>>${ref.index}`;
          html = html.replace(placeholderRegex, replacement);
        }

        if (!cancelled) {
          setRichTextHtml(html);
        }
      } catch (error) {
        console.error('Failed to create rich post text:', error);
        if (!cancelled) {
          setRichTextHtml(null);
        }
      }
    };

    const idleCallback = () => {
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback?.(renderRichText, { timeout: 2000 });
      } else {
        setTimeout(renderRichText, 500);
      }
    };

    idleCallback();
    return () => {
      cancelled = true;
    };
  }, [displayText, enablePostRefs]);

  // ---- Post-render: linkify and math in rich text container ----
  useEffect(() => {
    if (!richTextHtml || !richTextRef.current) return;
    const container = richTextRef.current;

    renderMathElements(container);
    linkifyHashtags(container);
    linkifyUrls(container);
    linkifyMentions(container, post.mentions);
    if (enablePostRefs) {
      linkifyPostRefs(container);
    }
  }, [richTextHtml, post.mentions, enablePostRefs]);

  // ---- Translation ----
  const authorLang = post.author_language;
  const currentLocale = getLocale();
  const showTranslate = authorLang && authorLang !== currentLocale;

  const handleTranslate = useCallback(async () => {
    if (!authorLang) return;
    try {
      const res = await fetch(`/api/posts/${post.id}/translate?target=${currentLocale}`, { method: 'POST' });
      if (!res.ok) return;

      const poll = async (): Promise<void> => {
        const pollRes = await fetch(`/api/posts/${post.id}/translate?target=${currentLocale}`);
        if (!pollRes.ok) return;
        const data = (await pollRes.json()) as { status: string; translated_text?: string };
        if (data.status === 'done' && data.translated_text) {
          setTranslatedText(data.translated_text);
          setShowingOriginal(false);
        } else if (data.status === 'processing') {
          setTimeout(poll, 2000);
        }
      };
      setTimeout(poll, 2000);
    } catch {
      // ignore
    }
  }, [post.id, authorLang, currentLocale]);

  const handleShowOriginalToggle = useCallback(() => {
    setShowingOriginal((prev) => !prev);
  }, []);

  // ---- Fresh toggle ----
  const handleFreshToggle = useCallback(async () => {
    if (freshLoading) return;

    if (!currentUser) {
      showSignInPrompt('fresh');
      return;
    }

    const previousFreshed = isFreshed;
    const previousCount = freshCount;

    setIsFreshed(!previousFreshed);
    setFreshCount(previousFreshed ? previousCount - 1 : previousCount + 1);

    setFreshLoading(true);

    try {
      const response = await fetch(`/api/posts/${post.id}/fresh`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) throw new Error('Failed to toggle fresh');

      const result = (await response.json()) as { freshed: boolean; fresh_count: number };
      setIsFreshed(result.freshed);
      setFreshCount(result.fresh_count);
    } catch (error) {
      setIsFreshed(previousFreshed);
      setFreshCount(previousCount);
      console.error('Failed to toggle fresh:', error);
    } finally {
      setFreshLoading(false);
    }
  }, [freshLoading, currentUser, isFreshed, freshCount, post.id, showSignInPrompt]);

  // ---- Sandbox bridge setup ----
  useEffect(() => {
    const iframe = cardRef.current?.querySelector('.sandbox-frame') as HTMLIFrameElement | null;
    if (!iframe) return;

    const bridge = new SandboxBridge({
      iframe,
      post,
      onFreshRequest: handleFreshToggle,
    });

    return () => bridge.destroy();
  }, [post, handleFreshToggle]);

  // ---- Bookmark toggle ----
  const handleBookmarkToggle = useCallback(async () => {
    if (bookmarkLoading) return;

    if (!currentUser) {
      showSignInPrompt('bookmark');
      return;
    }

    const previousBookmarked = isBookmarked;
    const previousCount = bookmarkCount;

    setIsBookmarked(!previousBookmarked);
    setBookmarkCount(previousBookmarked ? previousCount - 1 : previousCount + 1);

    setBookmarkLoading(true);

    try {
      const response = await fetch(`/api/posts/${post.id}/bookmark`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) throw new Error('Failed to toggle bookmark');

      const result = (await response.json()) as { bookmarked: boolean; bookmark_count: number };
      setIsBookmarked(result.bookmarked);
      setBookmarkCount(result.bookmark_count);
    } catch (error) {
      setIsBookmarked(previousBookmarked);
      setBookmarkCount(previousCount);
      console.error('Failed to toggle bookmark:', error);
    } finally {
      setBookmarkLoading(false);
    }
  }, [bookmarkLoading, currentUser, isBookmarked, bookmarkCount, post.id, showSignInPrompt]);

  // ---- Reply toggle ----
  const handleReplyToggle = useCallback(() => {
    if (!currentUser) {
      showSignInPrompt('reply');
      return;
    }
    setIsReplyComposerOpen((prev) => !prev);
    onReplyToggle?.();
  }, [currentUser, showSignInPrompt, onReplyToggle]);

  // ---- Reply created ----
  const _handleReplyCreated = useCallback(() => {
    setReplyCount((prev) => prev + 1);
    setIsReplyComposerOpen(false);
  }, []);

  // ---- Share ----
  const handleShare = useCallback(() => {
    createShareModal({
      post: {
        id: post.id,
        text: post.text,
        username: post.username,
        display_name: post.display_name,
      },
      onClose: () => {},
    });
  }, [post, createShareModal]);

  // ---- Post click navigation ----
  const handlePostClick = useCallback(
    (e: React.MouseEvent) => {
      if (disableNavigation) return;
      if (window.location.pathname.startsWith('/thread/')) return;

      const target = e.target as HTMLElement;
      if (
        target.closest('button') ||
        target.closest('input') ||
        target.closest('textarea') ||
        target.closest('a') ||
        target.closest('.poll-option') ||
        target.closest('.post-menu-button') ||
        target.closest('.post-menu-dropdown')
      ) {
        return;
      }

      const selection = window.getSelection();
      const isSelectingText = selection && selection.toString().length > 0;
      if (isSelectingText) return;

      e.preventDefault();
      const threadUrl = `/thread/${post.id}`;
      if (window.location.pathname === threadUrl) return;

      window.history.pushState({ postId: post.id }, '', threadUrl);
      window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'thread', postId: post.id } }));
    },
    [disableNavigation, post.id],
  );

  // ---- Menu dropdown ----
  const isOwnPost = currentUser?.username === post.username;

  const toggleMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen((prev) => !prev);
  }, []);

  const _closeMenu = useCallback(() => {
    setMenuOpen(false);
  }, []);

  // ---- Delete post ----
  const handleDelete = useCallback(async () => {
    try {
      const response = await fetch(`/api/posts/${post.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!response.ok) throw new Error('Failed to delete post');

      onDelete?.(post.id);

      if (cardRef.current) {
        cardRef.current.style.transition = 'opacity 0.3s, transform 0.3s';
        cardRef.current.style.opacity = '0';
        cardRef.current.style.transform = 'translateX(-100%)';
        setTimeout(() => {
          cardRef.current?.remove();
        }, 300);
      }

      showToast(t('post.deleted'));
    } catch (error) {
      console.error('Delete post error:', error);
      showToast(t('post.delete_failed'), true);
    }
  }, [post.id, onDelete, showToast]);

  const showDeleteConfirmation = useCallback(() => {
    const overlay = document.createElement('div');
    const unregister = registerModal();
    overlay.style.cssText =
      'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;';

    const dialog = document.createElement('div');
    dialog.style.cssText =
      'background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px; padding: 24px; max-width: 400px; width: 90%;';

    dialog.innerHTML = `
      <h3 style="margin: 0 0 16px 0; font-size: 18px; color: var(--text-primary);">${t('post.delete_title')}</h3>
      <p style="margin: 0 0 24px 0; color: var(--text-muted); font-size: 14px;">${t('post.delete_message')}</p>
      <div style="display: flex; gap: 12px; justify-content: flex-end;">
        <button class="cancel-btn" style="padding: 8px 16px; background: none; border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary); cursor: pointer;">${t('common.cancel')}</button>
        <button class="delete-btn" style="padding: 8px 16px; background: var(--danger, #e74c3c); border: none; border-radius: 4px; color: #fff; cursor: pointer;">${t('common.delete')}</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const cancelBtn = dialog.querySelector('.cancel-btn') as HTMLButtonElement;
    const deleteBtn = dialog.querySelector('.delete-btn') as HTMLButtonElement;

    cancelBtn.addEventListener('click', () => {
      unregister();
      overlay.remove();
    });
    deleteBtn.addEventListener('click', () => {
      unregister();
      overlay.remove();
      handleDelete();
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        unregister();
        overlay.remove();
      }
    });
    setMenuOpen(false);
  }, [handleDelete]);

  // ---- Report ----
  const showReportModal = useCallback(() => {
    const overlay = document.createElement('div');
    const unregister = registerModal();
    overlay.className = 'report-modal-overlay';
    overlay.style.cssText =
      'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;';

    const categories = [
      { value: 'spam', label: t('post.report_category_spam') },
      { value: 'harassment', label: t('post.report_category_harassment') },
      { value: 'hate_speech', label: t('post.report_category_hate_speech') },
      { value: 'inappropriate', label: t('post.report_category_inappropriate') },
      { value: 'misinformation', label: t('post.report_category_misinformation') },
      { value: 'privacy', label: t('post.report_category_privacy') },
      { value: 'copyright', label: t('post.report_category_copyright') },
      { value: 'malware', label: t('post.report_category_malware') },
      { value: 'csam', label: t('post.report_category_csam') },
      { value: 'other', label: t('post.report_category_other') },
    ];

    const dialog = document.createElement('div');
    dialog.style.cssText =
      'background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px; padding: 24px; max-width: 420px; width: 90%; max-height: 80vh; overflow-y: auto;';

    dialog.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="margin: 0; font-size: 18px; color: var(--text-primary);">${t('post.report_title')}</h3>
        <button class="close-btn" style="background: none; border: none; color: var(--text-muted); font-size: 20px; cursor: pointer;">\u2715</button>
      </div>
      <p style="margin: 0 0 16px 0; color: var(--text-muted); font-size: 14px;">${t('post.report_question')}</p>
      <div class="categories" style="margin-bottom: 24px;">
        ${categories
          .map(
            (c) => `
          <label style="display: flex; align-items: center; padding: 10px 0; cursor: pointer; color: var(--text-primary);">
            <input type="radio" name="report-category" value="${c.value}" style="margin-right: 12px;">
            <span>${c.label}</span>
          </label>
        `,
          )
          .join('')}
      </div>
      <div class="dmca-section" style="display: none; margin-bottom: 24px; padding: 16px; background: var(--bg-secondary); border-radius: 8px;">
        <h4 style="margin: 0 0 12px 0; font-size: 14px; color: var(--text-primary);">${t('post.report_dmca_title')}</h4>
        <div style="margin-bottom: 12px;">
          <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.report_dmca_work_label')}</label>
          <input type="text" class="dmca-work" style="width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); font-size: 14px; box-sizing: border-box;" placeholder="${t('post.report_dmca_work_placeholder')}">
        </div>
        <div style="margin-bottom: 12px;">
          <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.report_dmca_email_label')}</label>
          <input type="email" class="dmca-email" style="width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); font-size: 14px; box-sizing: border-box;" placeholder="${t('post.report_dmca_email_placeholder')}">
        </div>
        <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer;">
          <input type="checkbox" class="dmca-sworn" style="margin-top: 2px;">
          <span style="font-size: 12px; color: var(--text-muted);">${t('post.report_dmca_swear')}</span>
        </label>
      </div>
      <div style="display: flex; justify-content: flex-end;">
        <button class="submit-btn" disabled style="padding: 10px 24px; background: var(--accent); border: none; border-radius: 9999px; color: #000; font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; cursor: pointer; opacity: 0.5;">${t('common.submit')}</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const submitBtn = dialog.querySelector('.submit-btn') as HTMLButtonElement;
    const closeBtn = dialog.querySelector('.close-btn');
    const radioInputs = dialog.querySelectorAll('input[name="report-category"]');
    const dmcaSection = dialog.querySelector('.dmca-section') as HTMLElement;
    const dmcaWorkInput = dialog.querySelector('.dmca-work') as HTMLInputElement;
    const dmcaEmailInput = dialog.querySelector('.dmca-email') as HTMLInputElement;
    const dmcaSwornCheckbox = dialog.querySelector('.dmca-sworn') as HTMLInputElement;

    let selectedCategory: string | null = null;

    radioInputs.forEach((input) => {
      input.addEventListener('change', (e) => {
        selectedCategory = (e.target as HTMLInputElement).value;
        submitBtn.disabled = false;
        submitBtn.style.opacity = '1';
        dmcaSection.style.display = selectedCategory === 'copyright' ? 'block' : 'none';
      });
    });

    const checkSubmitEnabled = () => {
      if (!selectedCategory) return false;
      if (selectedCategory === 'copyright') {
        return (
          dmcaWorkInput.value.trim().length > 0 && dmcaEmailInput.value.trim().length > 0 && dmcaSwornCheckbox.checked
        );
      }
      return true;
    };

    dmcaWorkInput.addEventListener('input', () => {
      submitBtn.disabled = !checkSubmitEnabled();
      submitBtn.style.opacity = checkSubmitEnabled() ? '1' : '0.5';
    });
    dmcaEmailInput.addEventListener('input', () => {
      submitBtn.disabled = !checkSubmitEnabled();
      submitBtn.style.opacity = checkSubmitEnabled() ? '1' : '0.5';
    });
    dmcaSwornCheckbox.addEventListener('change', () => {
      submitBtn.disabled = !checkSubmitEnabled();
      submitBtn.style.opacity = checkSubmitEnabled() ? '1' : '0.5';
    });

    closeBtn?.addEventListener('click', () => {
      unregister();
      overlay.remove();
    });

    submitBtn.addEventListener('click', async () => {
      if (!selectedCategory) return;
      let dmcaData: { work_description: string; reporter_email: string; sworn: boolean } | undefined;
      if (selectedCategory === 'copyright') {
        dmcaData = {
          work_description: dmcaWorkInput.value.trim(),
          reporter_email: dmcaEmailInput.value.trim(),
          sworn: dmcaSwornCheckbox.checked,
        };
      }
      unregister();
      overlay.remove();
      await submitReport(selectedCategory, dmcaData);
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        unregister();
        overlay.remove();
      }
    });

    setMenuOpen(false);
  }, [submitReport]);

  async function submitReport(
    category: string,
    dmcaData?: { work_description: string; reporter_email: string; sworn: boolean },
  ) {
    try {
      const body: Record<string, unknown> = { post_id: post.id, category };
      if (dmcaData) body.dmca = dmcaData;

      const response = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      if (response.status === 409) {
        showToast(t('post.report_already'));
        return;
      }
      if (!response.ok) {
        const errorData = (await response.json()) as { error?: string };
        throw new Error(errorData?.error || 'Failed to submit report');
      }
      showToast(t('post.report_submitted'));
    } catch (error) {
      console.error('Report error:', error);
      showToast(t('post.report_failed'), true);
    }
  }

  // ---- Counter notice ----
  const showCounterNoticeModal = useCallback(() => {
    const overlay = document.createElement('div');
    const unregister = registerModal();
    overlay.className = 'counter-notice-modal-overlay';
    overlay.style.cssText =
      'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;';

    const dialog = document.createElement('div');
    dialog.style.cssText =
      'background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px; padding: 24px; max-width: 520px; width: 90%; max-height: 80vh; overflow-y: auto;';

    dialog.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="margin: 0; font-size: 18px; color: var(--text-primary);">${t('post.counter_notice_title')}</h3>
        <button class="close-btn" style="background: none; border: none; color: var(--text-muted); font-size: 20px; cursor: pointer;">\u2715</button>
      </div>
      <p style="margin: 0 0 16px 0; color: var(--text-muted); font-size: 14px;">${t('post.counter_notice_explanation')}</p>
      <div style="margin-bottom: 16px;">
        <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_name_label')}</label>
        <input type="text" class="cn-name" style="width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); font-size: 14px; box-sizing: border-box;" placeholder="${t('post.counter_notice_name_placeholder')}">
      </div>
      <div style="margin-bottom: 16px;">
        <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_email_label')}</label>
        <input type="email" class="cn-email" style="width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); font-size: 14px; box-sizing: border-box;" placeholder="${t('post.counter_notice_email_placeholder')}">
      </div>
      <div style="margin-bottom: 16px;">
        <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_address_label')}</label>
        <input type="text" class="cn-address" style="width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); font-size: 14px; box-sizing: border-box;" placeholder="${t('post.counter_notice_address_placeholder')}">
      </div>
      <div style="margin-bottom: 16px;">
        <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_phone_label')}</label>
        <input type="tel" class="cn-phone" style="width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); font-size: 14px; box-sizing: border-box;" placeholder="${t('post.counter_notice_phone_placeholder')}">
      </div>
      <label style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; cursor: pointer;">
        <input type="checkbox" class="cn-statement" style="margin-top: 2px;">
        <span style="font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_statement')}</span>
      </label>
      <label style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 16px; cursor: pointer;">
        <input type="checkbox" class="cn-consent" style="margin-top: 2px;">
        <span style="font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_consent')}</span>
      </label>
      <div style="display: flex; justify-content: flex-end;">
        <button class="submit-btn" disabled style="padding: 10px 24px; background: var(--accent); border: none; border-radius: 9999px; color: #000; font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; cursor: pointer; opacity: 0.5;">${t('common.submit')}</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const submitBtn = dialog.querySelector('.submit-btn') as HTMLButtonElement;
    const closeBtn = dialog.querySelector('.close-btn');
    const nameInput = dialog.querySelector('.cn-name') as HTMLInputElement;
    const emailInput = dialog.querySelector('.cn-email') as HTMLInputElement;
    const addressInput = dialog.querySelector('.cn-address') as HTMLInputElement;
    const phoneInput = dialog.querySelector('.cn-phone') as HTMLInputElement;
    const statementCheckbox = dialog.querySelector('.cn-statement') as HTMLInputElement;
    const consentCheckbox = dialog.querySelector('.cn-consent') as HTMLInputElement;

    const checkEnabled = () => {
      const valid =
        nameInput.value.trim().length > 0 &&
        emailInput.value.trim().length > 0 &&
        addressInput.value.trim().length > 0 &&
        phoneInput.value.trim().length > 0 &&
        statementCheckbox.checked &&
        consentCheckbox.checked;
      submitBtn.disabled = !valid;
      submitBtn.style.opacity = valid ? '1' : '0.5';
    };

    [nameInput, emailInput, addressInput, phoneInput].forEach((el) => {
      el.addEventListener('input', checkEnabled);
    });
    statementCheckbox.addEventListener('change', checkEnabled);
    consentCheckbox.addEventListener('change', checkEnabled);

    closeBtn?.addEventListener('click', () => {
      unregister();
      overlay.remove();
    });

    submitBtn.addEventListener('click', async () => {
      unregister();
      overlay.remove();
      await submitCounterNotice({
        name: nameInput.value.trim(),
        email: emailInput.value.trim(),
        address: addressInput.value.trim(),
        phone: phoneInput.value.trim(),
        statement: statementCheckbox.checked,
        consent_jurisdiction: consentCheckbox.checked,
      });
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        unregister();
        overlay.remove();
      }
    });

    setMenuOpen(false);
  }, [submitCounterNotice]);

  async function submitCounterNotice(data: {
    name: string;
    email: string;
    address: string;
    phone: string;
    statement: boolean;
    consent_jurisdiction: boolean;
  }) {
    try {
      const response = await fetch(`/api/posts/${post.id}/counter-notice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });

      if (response.status === 409) {
        showToast(t('post.counter_notice_already'));
        return;
      }
      if (!response.ok) {
        const errorData = (await response.json()) as { error?: string };
        throw new Error(errorData?.error || 'Failed to submit counter-notice');
      }
      showToast(t('post.counter_notice_submitted'));
    } catch (error) {
      console.error('Counter-notice error:', error);
      showToast(t('post.counter_notice_failed'), true);
    }
  }

  // ---- Post mode change ----
  const handleModeChange = useCallback((newMode: PostCardMode) => {
    setMode(newMode);
  }, []);

  // ---- Navigate to thread callback ----
  const _onNavigateToThread = useCallback((postId: string) => {
    window.history.pushState({ postId }, '', `/thread/${postId}`);
    window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'thread', postId } }));
  }, []);

  // ---- Post stage ----
  const PostStageComponent = useMemo(() => {
    const hasAttachments = post.gif_key || post.payload_key || post.swf_key || post.thumbnail_key;
    if (!hasAttachments) return null;

    const StageContent = () => {
      const stageRef = useRef<HTMLDivElement>(null);

      useEffect(() => {
        const el = stageRef.current;
        if (!el) return;

        const renderContent = async () => {
          const { createPostStage, updatePostStage } = await import('@/components/PostStage');
          const stageEl = createPostStage({
            post,
            mode,
            sandboxOrigin,
            onModeChange: handleModeChange,
          });
          el.innerHTML = '';
          el.appendChild(stageEl);
        };

        renderContent();
      }, []);

      return <div ref={stageRef} className="post-stage" style={{ width: '100%', margin: '12px 0' }} />;
    };

    return <StageContent />;
  }, [post, mode, sandboxOrigin, handleModeChange]);

  // ---- Post actions ----
  const PostActionsComponent = useMemo(() => {
    if (disableReply) return null;
    return (
      <div className="post-actions" style={{ display: 'flex', gap: '4px', alignItems: 'center', marginTop: '8px' }}>
        <ActionButton type="fresh" count={formatCount(freshCount)} isActive={isFreshed} onClick={handleFreshToggle} />
        <ActionButton
          type="bookmark"
          count={formatCount(bookmarkCount)}
          isActive={isBookmarked}
          onClick={handleBookmarkToggle}
        />
        <ActionButton type="reply" count={formatCount(replyCount)} onClick={handleReplyToggle} />
        <ActionButton type="share" count="0" onClick={handleShare} />
        <ActionButton type="impressions" count={formatCount(impressions)} />
      </div>
    );
  }, [
    disableReply,
    freshCount,
    isFreshed,
    bookmarkCount,
    isBookmarked,
    replyCount,
    impressions,
    handleFreshToggle,
    handleBookmarkToggle,
    handleReplyToggle,
    handleShare,
  ]);

  // ---- Reply composer ----
  const ReplyComposerComponent = useMemo(() => {
    if (disableReply || disableReplyComposer || !isReplyComposerOpen) return null;

    const ReplyComposerInner = () => {
      const rcRef = useRef<HTMLDivElement>(null);

      useEffect(() => {
        const el = rcRef.current;
        if (!el) return;

        const setupComposer = async () => {
          const { createReplyComposer } = await import('@/components/ReplyComposer');
          const prefill = postIndex !== undefined ? `>>${postIndex} ` : undefined;
          const composer = createReplyComposer({
            postId: post.id,
            sandboxOrigin,
            onReplyCreated: () => {
              setReplyCount((prev) => prev + 1);
              setIsReplyComposerOpen(false);
            },
            onCancel: () => setIsReplyComposerOpen(false),
            prefillText: prefill,
            currentUser: currentUser || undefined,
          });
          el.appendChild(composer.getElement());
          composer.focus();
        };

        setupComposer();
      }, []);

      return <div ref={rcRef} />;
    };

    return <ReplyComposerInner />;
  }, [disableReply, disableReplyComposer, isReplyComposerOpen, post.id, sandboxOrigin, postIndex, currentUser]);

  // ---- Menu dropdown element ----
  const MenuDropdownElement = useMemo(() => {
    if (!menuOpen) return null;

    const dropdownStyle: React.CSSProperties = {
      position: 'absolute',
      top: '30px',
      right: 0,
      background: 'var(--bg-primary)',
      border: '1px solid var(--border)',
      borderRadius: '4px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
      zIndex: 100,
      minWidth: '120px',
    };

    if (isOwnPost) {
      return (
        <div className="post-menu-dropdown" style={dropdownStyle}>
          {post.hidden === 1 && (
            <button
              style={{
                display: 'block',
                width: '100%',
                padding: '10px 16px',
                background: 'none',
                border: 'none',
                color: 'var(--text-primary)',
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: '14px',
                transition: 'background 0.2s',
              }}
              onClick={(e) => {
                e.stopPropagation();
                showCounterNoticeModal();
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'var(--bg-secondary)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'none';
              }}
            >
              {t('post.menu_counter_notice')}
            </button>
          )}
          <button
            style={{
              display: 'block',
              width: '100%',
              padding: '10px 16px',
              background: 'none',
              border: 'none',
              color: 'var(--danger, #e74c3c)',
              textAlign: 'left',
              cursor: 'pointer',
              fontSize: '14px',
              transition: 'background 0.2s',
            }}
            onClick={(e) => {
              e.stopPropagation();
              showDeleteConfirmation();
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'var(--bg-secondary)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'none';
            }}
          >
            {t('post.menu_delete')}
          </button>
        </div>
      );
    }

    return (
      <div className="post-menu-dropdown" style={dropdownStyle}>
        <button
          style={{
            display: 'block',
            width: '100%',
            padding: '10px 16px',
            background: 'none',
            border: 'none',
            color: 'var(--text-primary)',
            textAlign: 'left',
            cursor: 'pointer',
            fontSize: '14px',
            transition: 'background 0.2s',
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (!currentUser) {
              showSignInPrompt('report');
              setMenuOpen(false);
              return;
            }
            showReportModal();
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'var(--bg-secondary)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'none';
          }}
        >
          {t('post.menu_report')}
        </button>
      </div>
    );
  }, [
    menuOpen,
    isOwnPost,
    post.hidden,
    currentUser,
    showDeleteConfirmation,
    showReportModal,
    showCounterNoticeModal,
    showSignInPrompt,
  ]);

  // Move toast to global scope
  function showToast(message: string, isError: boolean = false) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: ${isError ? 'var(--danger, #e74c3c)' : 'var(--accent)'};
      color: ${isError ? '#fff' : '#000'};
      padding: 12px 24px;
      border-radius: 4px;
      font-size: 14px;
      z-index: 2000;
      animation: fadeInUp 0.3s ease;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'fadeOut 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.post-menu-dropdown') && !target.closest('.post-menu-button')) {
        setMenuOpen(false);
      }
    };
    setTimeout(() => document.addEventListener('click', handler), 0);
    return () => document.removeEventListener('click', handler);
  }, [menuOpen]);

  // ---- Show Sign In prompt (inline replacement) ----
  function showSignInPrompt(_action: string) {
    const overlay = document.createElement('div');
    const unregister = registerModal();
    overlay.style.cssText =
      'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;';
    const dialog = document.createElement('div');
    dialog.style.cssText =
      'background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px; padding: 24px; max-width: 320px; width: 90%; text-align: center;';
    dialog.innerHTML = `
      <p style="margin: 0 0 16px 0; color: var(--text-primary); font-size: 14px;">${t('sign_in_prompt.message')}</p>
      <div style="display: flex; gap: 8px; justify-content: center;">
        <button class="login-btn" style="padding: 8px 16px; background: var(--accent); border: none; border-radius: 4px; color: #000; cursor: pointer; font-size: 14px;">${t('common.login')}</button>
        <button class="register-btn" style="padding: 8px 16px; background: none; border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary); cursor: pointer; font-size: 14px;">${t('common.register')}</button>
      </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    dialog.querySelector('.login-btn')?.addEventListener('click', () => {
      unregister();
      overlay.remove();
      window.history.pushState({}, '', '/login');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    dialog.querySelector('.register-btn')?.addEventListener('click', () => {
      unregister();
      overlay.remove();
      window.history.pushState({}, '', '/register');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        unregister();
        overlay.remove();
      }
    });
  }

  // Create Share Modal inline (replacement for createShareModal import)
  function createShareModal(shareProps: {
    post: { id: string; text: string; username: string; display_name?: string };
    onClose: () => void;
  }) {
      const url = `${window.location.origin}/thread/${shareProps.post.id}`;
      const text = `${shareProps.post.display_name || shareProps.post.username}: ${shareProps.post.text.slice(0, 80)}${shareProps.post.text.length > 80 ? '...' : ''}`;

      if (navigator.share) {
        navigator.share({ title: text, url }).catch(() => {});
        return;
      }

      const overlay = document.createElement('div');
      const unregister = registerModal();
      overlay.style.cssText =
        'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;';
      const dialog = document.createElement('div');
      dialog.style.cssText =
        'background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px; padding: 24px; max-width: 400px; width: 90%;';

      dialog.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h3 style="margin: 0; font-size: 18px; color: var(--text-primary);">${t('share.title')}</h3>
          <button class="close-btn" style="background: none; border: none; color: var(--text-muted); font-size: 20px; cursor: pointer;">\u2715</button>
        </div>
        <p style="margin: 0 0 8px 0; color: var(--text-muted); font-size: 12px;">${t('share.copy_link')}</p>
        <div style="display: flex; gap: 8px; margin-bottom: 16px;">
          <input type="text" class="share-url-input" readonly value="${url}" style="flex: 1; padding: 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary); font-size: 14px;">
          <button class="copy-btn" style="padding: 8px 16px; background: var(--accent); border: none; border-radius: 4px; color: #000; cursor: pointer; font-size: 14px;">${t('common.copy')}</button>
        </div>
      `;

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const closeBtn = dialog.querySelector('.close-btn');
      const copyBtn = dialog.querySelector('.copy-btn');
      const urlInput = dialog.querySelector('.share-url-input') as HTMLInputElement;

      closeBtn?.addEventListener('click', () => {
        unregister();
        overlay.remove();
        shareProps.onClose();
      });
      copyBtn?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(url);
          showToast(t('share.copied'));
        } catch {
          urlInput.select();
          document.execCommand('copy');
          showToast(t('share.copied'));
        }
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          unregister();
          overlay.remove();
          shareProps.onClose();
        }
      });
  }

  return (
    <article
      ref={cardRef}
      className="post-card"
      data-post-id={post.id}
      data-post-index={postIndex !== undefined ? postIndex : undefined}
      onClick={handlePostClick}
      style={{
        maxWidth: '100%',
        overflowX: 'hidden',
        boxSizing: 'border-box',
        wordBreak: 'break-word',
        cursor: disableNavigation ? 'default' : 'pointer',
      }}
    >
      <div className="post-card-header" style={{ display: 'flex', alignItems: 'flex-start', position: 'relative' }}>
        {postIndex !== undefined && (
          <span
            style={{
              color: '#94a3b8',
              fontSize: '0.8125rem',
              fontFamily: "'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
              marginRight: '0.5rem',
              flexShrink: 0,
            }}
          >
            {postIndex}
          </span>
        )}
        <PostHeader
          username={post.username}
          display_name={post.display_name}
          avatar_key={post.avatar_key}
          createdAt={post.created_at}
        />
        <button
          className="post-menu-button"
          onClick={toggleMenu}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            fontSize: '18px',
            cursor: 'pointer',
            padding: '4px 8px',
            borderRadius: '4px',
            transition: 'color 0.2s ease',
            marginLeft: 'auto',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)';
          }}
        >
          {'\u22ef'}
        </button>
        {MenuDropdownElement}
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <div
          ref={richTextRef}
          className="post-text"
          style={{
            lineHeight: 1.6,
            fontFamily: "'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            color: 'var(--text-primary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {richTextHtml ? (
            <div dangerouslySetInnerHTML={{ __html: richTextHtml }} />
          ) : translatedText && !showingOriginal ? (
            translatedText
          ) : (
            displayText
          )}
        </div>

        {showTranslate && (
          <div style={{ marginTop: '0.5rem' }}>
            {translatedText === null ? (
              <button
                className="translate-btn"
                onClick={handleTranslate}
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--accent)',
                  background: 'none',
                  border: '1px solid var(--accent)',
                  borderRadius: '4px',
                  padding: '2px 8px',
                  cursor: 'pointer',
                }}
              >
                {t('translate.to', { locale: currentLocale.toUpperCase() })}
              </button>
            ) : (
              <button
                className="translate-toggle"
                onClick={handleShowOriginalToggle}
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--accent)',
                  background: 'none',
                  border: 'none',
                  padding: '2px 0',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                {showingOriginal ? t('translate.show_translation') : t('translate.show_original')}
              </button>
            )}
          </div>
        )}
      </div>

      <TagChips hashtags={hashtags} />

      {post.poll && <PollElement poll={post.poll} postId={post.id} />}

      <LinkPreview text={post.text} />

      {PostStageComponent}

      {PostActionsComponent}

      {isReplyComposerOpen && ReplyComposerComponent}
    </article>
  );
}
