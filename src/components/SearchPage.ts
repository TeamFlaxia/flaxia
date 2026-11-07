import { attachPlusBadge } from '../lib/avatar.js';
import { formatCount } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { applyNameColor } from '../lib/name-color.js';
import { nativeApiHref } from '../lib/native-api.js';
import { stripPostColors } from '../lib/post-colors.js';
import { pushSpaHistory } from '../lib/spa-history.js';
import { ExternalItem, Post, PostCardMode } from '../types/post.js';
import { createExternalItemCard } from './ExternalItemCard.js';
import { createPostCard } from './PostCard.js';

interface SearchPageProps {
  query: string;
  type?: 'posts' | 'users' | 'arcade';
  currentUser: {
    username: string;
    id: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
    name_color?: string | null;
  } | null;
  sandboxOrigin: string;
}

export function createSearchPage({ query, type = 'posts', currentUser, sandboxOrigin }: SearchPageProps) {
  const initialFilter: 'all' | 'users' | 'posts' | 'arcade' =
    type === 'users' ? 'users' : type === 'arcade' ? 'arcade' : 'all';

  let activeFilter: 'all' | 'users' | 'posts' | 'arcade' = initialFilter;

  let allUsers: Array<{
    id: string;
    username: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
    name_color?: string | null;
    bio?: string;
    is_following?: boolean;
  }> = [];
  let allPosts: Post[] = [];
  let allArcade: Post[] = [];
  let allExternal: ExternalItem[] = [];

  const container = document.createElement('div');
  container.className = 'search-page';

  // ── Header with search input ──
  const header = document.createElement('div');
  header.className = 'search-page-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'search-page-back';
  backBtn.textContent = '←';
  backBtn.addEventListener('click', () => {
    window.history.pushState({}, '', '/explore');
    window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'explore' } }));
  });

  const searchBox = document.createElement('div');
  searchBox.className = 'search-box';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'search-input';
  input.value = query;
  input.placeholder = t('explore.search_placeholder');

  const icon = document.createElement('span');
  icon.className = 'search-icon';
  icon.setAttribute('aria-hidden', 'true');

  searchBox.appendChild(input);
  searchBox.appendChild(icon);

  const suggestDropdown = document.createElement('div');
  suggestDropdown.className = 'tag-suggest-dropdown';
  suggestDropdown.style.cssText = `
    display: none;
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 100;
    max-height: 300px;
    overflow-y: auto;
    margin-top: 4px;
  `;
  searchBox.appendChild(suggestDropdown);

  header.appendChild(backBtn);
  header.appendChild(searchBox);
  container.appendChild(header);

  // ── Filter bar ──
  const filterBar = document.createElement('div');
  filterBar.className = 'search-filter-bar';
  // Calculate filter bar top based on actual header height
  requestAnimationFrame(() => {
    filterBar.style.top = `${header.offsetHeight}px`;
  });

  const filters: { key: 'all' | 'users' | 'posts' | 'arcade'; label: string }[] = [
    { key: 'all', label: t('search.filter_all') },
    { key: 'users', label: t('explore.filter_users') },
    { key: 'posts', label: t('explore.filter_posts') },
    { key: 'arcade', label: t('explore.filter_arcade') },
  ];

  const filterBtns: HTMLElement[] = [];

  const updateFilterUI = (activeKey: string) => {
    filterBtns.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.filter === activeKey);
    });
  };

  for (const f of filters) {
    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.dataset.filter = f.key;
    btn.textContent = f.label;
    btn.onclick = () => {
      activeFilter = f.key;
      updateFilterUI(f.key);
      renderResults();
    };
    filterBtns.push(btn);
    filterBar.appendChild(btn);
  }

  updateFilterUI(activeFilter);
  container.appendChild(filterBar);

  // ── Content area ──
  const content = document.createElement('div');
  content.className = 'search-page-content';

  container.appendChild(content);

  // Loading state
  const loadingEl = document.createElement('div');
  loadingEl.className = 'search-loading';
  loadingEl.textContent = t('common.loading');
  content.appendChild(loadingEl);

  // ── Suggest helpers ──
  let suggestAbortController: AbortController | null = null;
  let suggestTimer: ReturnType<typeof setTimeout> | null = null;

  const fetchSuggestions = async (prefix: string, kind: 'tag' | 'user') => {
    if (suggestAbortController) suggestAbortController.abort();
    const controller = new AbortController();
    suggestAbortController = controller;
    try {
      const url =
        kind === 'tag'
          ? `/api/tags/suggest?q=${encodeURIComponent(prefix)}`
          : `/api/users/suggest?q=${encodeURIComponent(prefix)}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return;
      if (kind === 'tag') {
        const data = (await res.json()) as { tags: { tag: string; count: number }[] };
        renderSuggestions((data.tags || []).map((t) => ({ type: 'tag' as const, label: t.tag, count: t.count })));
      } else {
        const data = (await res.json()) as {
          users: { username: string; display_name: string; avatar_key: string; badge_type?: string | null }[];
        };
        renderSuggestions(
          (data.users || []).map((u) => ({
            type: 'user' as const,
            label: u.username,
            display: u.display_name,
            avatar: u.avatar_key,
            badge: u.badge_type ?? null,
          })),
        );
      }
    } catch (err: unknown) {
      if ((err as { name?: string })?.name !== 'AbortError') console.error('Suggest error:', err);
    }
  };

  const renderSuggestions = (
    items: (
      | { type: 'tag'; label: string; count: number }
      | { type: 'user'; label: string; display: string; avatar: string; badge?: string | null }
    )[],
  ) => {
    suggestDropdown.innerHTML = '';
    if (items.length === 0) {
      suggestDropdown.style.display = 'none';
      return;
    }
    suggestDropdown.style.display = 'block';
    for (const it of items) {
      const item = document.createElement('div');
      item.style.cssText = `padding: 0.6rem 0.75rem; cursor: pointer; display: flex; align-items: center; gap: 0.5rem; transition: background 0.15s;`;
      item.addEventListener('mouseenter', () => {
        item.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))';
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = 'none';
      });
      if (it.type === 'tag') {
        const tagName = document.createElement('span');
        tagName.textContent = `# ${it.label}`;
        tagName.style.cssText = 'font-weight: 600; color: var(--accent-text); font-size: 0.875rem;';
        const count = document.createElement('span');
        count.textContent = formatCount(it.count);
        count.style.cssText = 'margin-left: auto; color: var(--text-muted); font-size: 0.75rem;';
        item.appendChild(tagName);
        item.appendChild(count);
        item.addEventListener('click', () => {
          suggestDropdown.style.display = 'none';
          window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(it.label)}`);
          window.location.reload();
        });
      } else {
        const avatar = document.createElement('div');
        avatar.style.cssText = `width: 28px; height: 28px; border-radius: 50%; background: var(--accent); color: var(--on-accent); display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 0.7rem; flex-shrink: 0;`;
        avatar.textContent = (it.display || it.label)[0].toUpperCase();
        attachPlusBadge(avatar, it.badge);
        const info = document.createElement('div');
        info.style.cssText = 'display: flex; flex-direction: column;';
        const name = document.createElement('span');
        name.textContent = `@${it.label}`;
        name.style.cssText = 'font-weight: 600; color: var(--text-primary); font-size: 0.85rem;';
        const display = document.createElement('span');
        display.textContent = it.display;
        display.style.cssText = 'font-size: 0.75rem; color: var(--text-muted);';
        info.appendChild(name);
        info.appendChild(display);
        item.appendChild(avatar);
        item.appendChild(info);
        item.addEventListener('click', () => {
          suggestDropdown.style.display = 'none';
          window.history.pushState({}, '', `/profile/${encodeURIComponent(it.label)}`);
          window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'profile', username: it.label } }));
        });
      }
      suggestDropdown.appendChild(item);
    }
  };

  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      const q = input.value.trim();
      suggestAbortController?.abort();
      suggestDropdown.style.display = 'none';
      if (q.startsWith('#')) {
        const afterHash = q.slice(1).trim();
        const spaceIdx = afterHash.indexOf(' ');
        if (spaceIdx === -1 && afterHash) {
          window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(afterHash)}`);
          window.location.reload();
          return;
        }
      }
      if (q && q !== query) {
        window.history.pushState({}, '', `/search?q=${encodeURIComponent(q)}&type=${type}`);
        window.dispatchEvent(
          new CustomEvent('spaNavigate', {
            detail: { view: 'search', searchQuery: q, searchType: type },
          }),
        );
      }
    }
  });

  input.addEventListener('input', () => {
    const val = input.value;
    if (suggestAbortController) suggestAbortController.abort();
    if (suggestTimer) clearTimeout(suggestTimer);
    if (val.length < 2 || val.includes(' ')) {
      suggestDropdown.style.display = 'none';
      return;
    }
    if (val.startsWith('#')) {
      const prefix = val.slice(1);
      if (!prefix) {
        suggestDropdown.style.display = 'none';
        return;
      }
      suggestTimer = setTimeout(() => fetchSuggestions(prefix, 'tag'), 200);
      return;
    }
    if (val.startsWith('@')) {
      const prefix = val.slice(1);
      if (!prefix) {
        suggestDropdown.style.display = 'none';
        return;
      }
      suggestTimer = setTimeout(() => fetchSuggestions(prefix, 'user'), 200);
      return;
    }
    suggestDropdown.style.display = 'none';
  });

  input.addEventListener('blur', () => {
    setTimeout(() => {
      suggestDropdown.style.display = 'none';
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      suggestDropdown.style.display = 'none';
      input.blur();
    }
  });

  // ── Data fetching ──
  const loadSearchResults = async () => {
    try {
      const [postsRes, arcadeRes] = await Promise.all([
        fetch(`/api/search?q=${encodeURIComponent(query)}&type=posts&limit=20`),
        fetch(`/api/search?q=${encodeURIComponent(query)}&type=arcade&limit=20`),
      ]);
      const postsData = (await postsRes.json()) as {
        results: Post[];
        external_results?: ExternalItem[];
        users?: Array<{
          id: string;
          username: string;
          display_name?: string;
          avatar_key?: string;
          badge_type?: string | null;
          name_color?: string | null;
          bio?: string;
          is_following?: boolean;
        }>;
      };
      const arcadeData = (await arcadeRes.json()) as { results: Post[] };

      allUsers = postsData.users || [];
      allPosts = postsData.results || [];
      allExternal = postsData.external_results || [];
      allArcade = arcadeData.results || [];

      content.removeChild(loadingEl);
      renderResults();
    } catch (error) {
      console.error('Search error:', error);
      if (loadingEl.parentNode === content) content.removeChild(loadingEl);
      const errorEl = document.createElement('div');
      errorEl.style.cssText = 'text-align: center; padding: 3rem; color: var(--danger-text);';
      errorEl.textContent = t('common.error');
      content.appendChild(errorEl);
    }
  };

  // ── Rendering ──
  const renderResults = () => {
    content.innerHTML = '';

    const showAll = activeFilter === 'all';
    let anyVisible = false;

    // Users section
    if ((showAll || activeFilter === 'users') && allUsers.length > 0) {
      anyVisible = true;
      if (showAll) {
        const sectionTitle = document.createElement('div');
        sectionTitle.className = 'search-section-label';
        sectionTitle.textContent = t('search.users');
        content.appendChild(sectionTitle);
      }
      renderUsers(allUsers);
      if (showAll && allArcade.length > 0) {
        const divider = document.createElement('div');
        divider.className = 'search-section-divider';
        content.appendChild(divider);
      }
    }

    // Arcade section
    if ((showAll || activeFilter === 'arcade') && allArcade.length > 0) {
      anyVisible = true;
      if (showAll) {
        const sectionTitle = document.createElement('div');
        sectionTitle.className = 'search-section-label';
        sectionTitle.textContent = t('explore.filter_arcade');
        content.appendChild(sectionTitle);
        renderArcade(allArcade, false);
      } else {
        const sectionTitle = document.createElement('div');
        sectionTitle.className = 'search-section-label';
        sectionTitle.textContent = t('explore.filter_arcade');
        content.appendChild(sectionTitle);
        renderArcade(allArcade, true);
      }
      if (showAll && allPosts.length > 0) {
        const divider = document.createElement('div');
        divider.className = 'search-section-divider';
        content.appendChild(divider);
      }
    }

    // Posts section
    if ((showAll || activeFilter === 'posts') && allPosts.length > 0) {
      anyVisible = true;
      if (showAll) {
        const sectionTitle = document.createElement('div');
        sectionTitle.className = 'search-section-label';
        sectionTitle.textContent = t('search.posts');
        content.appendChild(sectionTitle);
      }
      renderPosts(allPosts);
    }

    // External sources section (arXiv / Hacker News)
    if ((showAll || activeFilter === 'posts') && allExternal.length > 0) {
      anyVisible = true;
      const sectionTitle = document.createElement('div');
      sectionTitle.className = 'search-section-label';
      sectionTitle.textContent = t('timeline.source_label');
      content.appendChild(sectionTitle);
      renderExternal(allExternal);
    }

    if (!anyVisible) {
      const empty = document.createElement('div');
      empty.className = 'page-empty';
      const emptyIcon = document.createElement('span');
      emptyIcon.className = 'page-empty-icon';
      const emptyTitle = document.createElement('p');
      emptyTitle.className = 'page-empty-title fx-display';
      emptyTitle.textContent = t('search.no_results', { query });
      empty.appendChild(emptyIcon);
      empty.appendChild(emptyTitle);
      content.appendChild(empty);
    }
  };

  const renderUsers = (
    users: Array<{
      id: string;
      username: string;
      display_name?: string;
      avatar_key?: string;
      badge_type?: string | null;
      name_color?: string | null;
      bio?: string;
      is_following?: boolean;
    }>,
  ) => {
    users.forEach((user) => {
      const userItem = document.createElement('div');
      userItem.className = 'search-user-row';
      userItem.onclick = () => {
        window.history.pushState({ username: user.username }, '', `/profile/${user.username}`);
        window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'profile', username: user.username } }));
      };

      const avatar = document.createElement('div');
      avatar.className = 'search-avatar';
      if (user.avatar_key) {
        avatar.style.backgroundImage = `url('${nativeApiHref(`/api/images/${user.avatar_key}`)}')`;
      }
      if (!user.avatar_key) {
        avatar.textContent = user.display_name?.[0]?.toUpperCase() || user.username[0].toUpperCase();
      }
      attachPlusBadge(avatar, user.badge_type);

      const userInfo = document.createElement('div');
      userInfo.className = 'search-user-info';
      const usernameEl = document.createElement('div');
      usernameEl.className = 'search-user-name';
      usernameEl.textContent = `@${user.username}`;
      const displayNameEl = document.createElement('div');
      displayNameEl.className = 'search-user-display';
      displayNameEl.textContent = user.display_name || '';
      applyNameColor(displayNameEl, user.name_color, user.badge_type);

      userInfo.appendChild(usernameEl);
      userInfo.appendChild(displayNameEl);
      userItem.appendChild(avatar);
      userItem.appendChild(userInfo);
      content.appendChild(userItem);
    });
  };

  const renderExternal = (items: ExternalItem[]) => {
    items.forEach((item) => {
      content.appendChild(createExternalItemCard(item).getElement());
    });
  };

  const renderPosts = (posts: Post[]) => {
    posts.forEach((post) => {
      const postCard = createPostCard({
        post,
        currentUser,
        sandboxOrigin,
        initialMode: PostCardMode.PREVIEW,
        depth: post.depth,
      });
      content.appendChild(postCard.getElement());
    });
  };

  const renderArcade = (posts: Post[], grid: boolean) => {
    if (grid) {
      // YouTube-style horizontal list
      for (const post of posts) {
        const row = document.createElement('div');
        row.style.cssText = `
          display: flex;
          gap: 1rem;
          padding: 0.75rem;
          border-radius: 0.5rem;
          cursor: pointer;
          transition: background 0.2s;
          margin-bottom: 0.25rem;
        `;
        row.addEventListener('mouseenter', () => {
          row.style.background = 'var(--bg-secondary)';
        });
        row.addEventListener('mouseleave', () => {
          row.style.background = 'transparent';
        });
        row.onclick = () => {
          pushSpaHistory(`/arcade/${post.id}`, { postId: post.id });
          window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'arcade', postId: post.id } }));
        };

        // Thumbnail (fixed width, 16:9 aspect ratio)
        const thumb = document.createElement('div');
        thumb.style.cssText = `
          width: 180px;
          flex-shrink: 0;
          aspect-ratio: 16 / 9;
          border-radius: 0.5rem;
          overflow: hidden;
          position: relative;
          background: var(--bg-input);
        `;
        if (post.thumbnail_key) {
          const img = document.createElement('img');
          img.src = nativeApiHref(`/api/images/${post.thumbnail_key}`);
          img.loading = 'lazy';
          img.width = 180;
          img.height = 101;
          img.style.cssText = 'width: 100%; height: 100%; object-fit: cover; display: block;';
          thumb.appendChild(img);
        } else {
          const icon = document.createElement('span');
          icon.textContent = '🎮';
          icon.style.cssText =
            'position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 1.5rem;';
          thumb.appendChild(icon);
        }

        // Badge
        const badge = document.createElement('span');
        badge.style.cssText = `
          position: absolute; top: 4px; right: 4px;
          padding: 0.1rem 0.4rem; border-radius: 4px;
          background: var(--accent); color: var(--on-accent);
          font-size: 0.6rem; font-weight: 600; text-transform: uppercase;
          line-height: 1.2;
        `;
        badge.textContent = 'GAME';
        thumb.appendChild(badge);

        // Details
        const details = document.createElement('div');
        details.style.cssText = 'display: flex; flex-direction: column; justify-content: center; min-width: 0;';

        const title = document.createElement('div');
        title.textContent = stripPostColors(post.text || '') || '(no title)';
        title.style.cssText = `
          font-weight: 600; color: var(--text-primary);
          font-size: 0.95rem; line-height: 1.4;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        `;

        const meta = document.createElement('div');
        meta.textContent = `@${post.username}`;
        meta.style.cssText = `
          font-size: 0.8rem; color: var(--text-muted);
          margin-top: 0.25rem;
        `;

        details.appendChild(title);
        details.appendChild(meta);
        row.appendChild(thumb);
        row.appendChild(details);
        content.appendChild(row);
      }
    } else {
      // Horizontal scroll cards
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'position: relative;';

      const scrollContainer = document.createElement('div');
      scrollContainer.style.cssText = `
        display: flex;
        overflow-x: auto;
        gap: 0.75rem;
        padding: 0.5rem 0 0.75rem;
        scrollbar-width: thin;
        scrollbar-color: var(--border) transparent;
        scroll-snap-type: x mandatory;
        -webkit-overflow-scrolling: touch;
      `;
      scrollContainer.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
          e.preventDefault();
          scrollContainer.scrollLeft += e.deltaY;
        }
      });

      // Right-edge fade hint
      const fadeHint = document.createElement('div');
      fadeHint.style.cssText = `
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        width: 48px;
        background: linear-gradient(to right, transparent, var(--bg-primary));
        pointer-events: none;
        opacity: 1;
        transition: opacity 0.3s;
        z-index: 1;
      `;
      wrapper.appendChild(fadeHint);

      const updateFade = () => {
        const atEnd = scrollContainer.scrollLeft >= scrollContainer.scrollWidth - scrollContainer.clientWidth - 4;
        fadeHint.style.opacity = atEnd ? '0' : '1';
      };
      scrollContainer.addEventListener('scroll', updateFade);

      for (const post of posts) {
        const card = document.createElement('div');
        card.style.cssText = `
          width: 150px;
          flex-shrink: 0;
          cursor: pointer;
          border-radius: 0.75rem;
          overflow: hidden;
          transition: transform 0.2s, box-shadow 0.2s;
          scroll-snap-align: start;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
        `;
        card.onmouseenter = () => {
          card.style.transform = 'translateY(-3px)';
          card.style.boxShadow = '0 6px 16px rgba(0,0,0,0.15)';
        };
        card.onmouseleave = () => {
          card.style.transform = 'none';
          card.style.boxShadow = 'none';
        };
        card.onclick = () => {
          pushSpaHistory(`/arcade/${post.id}`, { postId: post.id });
          window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'arcade', postId: post.id } }));
        };

        // Thumbnail
        const thumb = document.createElement('div');
        thumb.style.cssText = `
          width: 100%;
          aspect-ratio: 9 / 12;
          overflow: hidden;
          position: relative;
          background: var(--bg-input);
        `;
        if (post.thumbnail_key) {
          const img = document.createElement('img');
          img.src = nativeApiHref(`/api/images/${post.thumbnail_key}`);
          img.loading = 'lazy';
          img.width = 150;
          img.height = 200;
          img.style.cssText = 'width: 100%; height: 100%; object-fit: cover; display: block;';
          thumb.appendChild(img);
        } else {
          const icon = document.createElement('span');
          icon.textContent = '🎮';
          icon.style.cssText =
            'position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 2rem;';
          thumb.appendChild(icon);
        }

        // Badge
        const badge = document.createElement('span');
        badge.style.cssText = `
          position: absolute; top: 4px; right: 4px;
          padding: 0.1rem 0.35rem; border-radius: 4px;
          background: var(--accent); color: var(--on-accent);
          font-size: 0.6rem; font-weight: 600; text-transform: uppercase;
          line-height: 1.2;
        `;
        badge.textContent = 'GAME';
        thumb.appendChild(badge);

        // Info
        const info = document.createElement('div');
        info.style.cssText = 'padding: 0.4rem 0.35rem 0.35rem;';

        const title = document.createElement('div');
        title.textContent = stripPostColors(post.text || '').slice(0, 60) || '(no text)';
        title.style.cssText = `
          font-weight: 600; color: var(--text-primary);
          font-size: 0.8rem; line-height: 1.3;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        `;

        const meta = document.createElement('div');
        meta.textContent = `@${post.username}`;
        meta.style.cssText = `
          font-size: 0.7rem; color: var(--text-muted);
          margin-top: 0.15rem;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        `;

        info.appendChild(title);
        info.appendChild(meta);
        card.appendChild(thumb);
        card.appendChild(info);
        scrollContainer.appendChild(card);
      }

      wrapper.appendChild(scrollContainer);
      content.appendChild(wrapper);

      // Initial fade state
      requestAnimationFrame(updateFade);
    }
  };

  // Start
  loadSearchResults();

  return {
    getElement: () => container,
    destroy: () => {
      container.remove();
    },
  };
}
