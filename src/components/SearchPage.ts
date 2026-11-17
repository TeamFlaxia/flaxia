import { attachPlusBadge } from '../lib/avatar.js';
import { formatCount } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { applyNameColor } from '../lib/name-color.js';
import { nativeApiHref } from '../lib/native-api.js';
import { stripPostColors } from '../lib/post-colors.js';
import { each, legacy, type Mounted, mount, signal } from '../lib/render/index.ts';
import { pushSpaHistory } from '../lib/spa-history.js';
import { uniqueBy } from '../lib/unique.ts';
import { Post, PostCardMode } from '../types/post.js';
import { createPostCard } from './PostCard.js';

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  published_at?: string;
}

interface SearchUser {
  id: string;
  username: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
  name_color?: string | null;
  bio?: string;
  is_following?: boolean;
}

type SearchFilter = 'all' | 'web' | 'users' | 'posts' | 'arcade';

interface SearchPageProps {
  query: string;
  type?: 'posts' | 'users' | 'arcade' | 'web';
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
  const initialFilter: SearchFilter =
    type === 'users' ? 'users' : type === 'arcade' ? 'arcade' : type === 'web' ? 'web' : 'all';

  let activeFilter: SearchFilter = initialFilter;

  let allUsers: SearchUser[] = [];
  let allPosts: Post[] = [];
  let allArcade: Post[] = [];
  let allWeb: WebSearchResult[] = [];
  let loadRequestId = 0;

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

  const filters: { key: SearchFilter; label: string }[] = [
    { key: 'all', label: t('search.filter_all') },
    { key: 'web', label: t('search.filter_web') },
    { key: 'posts', label: t('explore.filter_posts') },
    { key: 'users', label: t('explore.filter_users') },
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
      if (activeFilter === f.key) return;
      activeFilter = f.key;
      updateFilterUI(f.key);
      const nextType = f.key === 'all' ? 'posts' : f.key;
      window.history.replaceState({}, '', `/search?q=${encodeURIComponent(query)}&type=${nextType}`);
      loadSearchResults(f.key);
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

  // ── Results: persistent sections with keyed lists ──
  const usersSignal = signal<SearchUser[]>([]);
  const postsSignal = signal<Post[]>([]);
  const arcadeSignal = signal<Post[]>([]);
  const webSignal = signal<WebSearchResult[]>([]);

  const sectionLabel = (text: string): HTMLElement => {
    const label = document.createElement('div');
    label.className = 'search-section-label';
    label.textContent = text;
    return label;
  };

  const sectionDivider = (): HTMLElement => {
    const divider = document.createElement('div');
    divider.className = 'search-section-divider';
    divider.style.cssText = 'height: 1px; background: var(--border); margin: 1rem 0;';
    return divider;
  };

  const usersLabel = sectionLabel(t('search.users'));
  const usersHost = document.createElement('div');
  const usersDivider = sectionDivider();

  const arcadeLabel = sectionLabel(t('explore.filter_arcade'));
  const arcadeRowsHost = document.createElement('div');
  const arcadeCardsWrapper = document.createElement('div');
  arcadeCardsWrapper.style.cssText = 'position: relative;';
  const arcadeScroll = document.createElement('div');
  arcadeScroll.style.cssText = `
    display: flex;
    overflow-x: auto;
    gap: 0.75rem;
    padding: 0.5rem 0 0.75rem;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
  `;
  const arcadeFade = document.createElement('div');
  arcadeFade.style.cssText = `
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
  const updateArcadeFade = () => {
    const atEnd = arcadeScroll.scrollLeft >= arcadeScroll.scrollWidth - arcadeScroll.clientWidth - 4;
    arcadeFade.style.opacity = atEnd ? '0' : '1';
  };
  arcadeScroll.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
      e.preventDefault();
      arcadeScroll.scrollLeft += e.deltaY;
    }
  });
  arcadeScroll.addEventListener('scroll', updateArcadeFade);
  arcadeCardsWrapper.appendChild(arcadeFade);
  arcadeCardsWrapper.appendChild(arcadeScroll);
  const arcadeDivider = sectionDivider();

  const postsLabel = sectionLabel(t('search.posts'));
  const postsHost = document.createElement('div');

  const webDivider = sectionDivider();
  const webLabel = sectionLabel(t('search.web_results'));
  webLabel.style.cssText =
    'font-weight: 600; font-size: 0.9rem; color: var(--text-muted); margin-bottom: 0.5rem; padding: 0 0.25rem;';
  const webHost = document.createElement('div');

  const empty = document.createElement('div');
  empty.className = 'page-empty';
  empty.hidden = true;
  const emptyIcon = document.createElement('span');
  emptyIcon.className = 'page-empty-icon';
  const emptyTitle = document.createElement('p');
  emptyTitle.className = 'page-empty-title fx-display';
  emptyTitle.textContent = t('search.no_results', { query });
  empty.appendChild(emptyIcon);
  empty.appendChild(emptyTitle);

  const statusHost = document.createElement('div');
  statusHost.hidden = true;

  for (const element of [
    usersLabel,
    usersHost,
    usersDivider,
    arcadeLabel,
    arcadeRowsHost,
    arcadeCardsWrapper,
    arcadeDivider,
    postsLabel,
    postsHost,
    webDivider,
    webLabel,
    webHost,
    empty,
    statusHost,
  ]) {
    content.appendChild(element);
  }

  const usersMount: Mounted = mount(usersHost, () =>
    each(
      () => usersSignal(),
      (user) => user.id,
      (user) => legacy(createUserRow(user())),
    ),
  );

  const postsMount: Mounted = mount(postsHost, () =>
    each(
      () => postsSignal(),
      (post) => post.id,
      (post) => {
        const value = post();
        const card = createPostCard({
          post: value,
          currentUser,
          sandboxOrigin,
          initialMode: PostCardMode.PREVIEW,
          depth: value.depth,
        });
        return legacy(card.getElement(), () => card.destroy());
      },
    ),
  );

  const arcadeRowsMount: Mounted = mount(arcadeRowsHost, () =>
    each(
      () => arcadeSignal(),
      (post) => post.id,
      (post) => legacy(createArcadeRow(post())),
    ),
  );

  const arcadeCardsMount: Mounted = mount(arcadeScroll, () =>
    each(
      () => arcadeSignal(),
      (post) => post.id,
      (post) => legacy(createArcadeCard(post())),
    ),
  );

  const webMount: Mounted = mount(webHost, () =>
    each(
      () => webSignal(),
      (result) => result.url,
      (result) => {
        const item = createWebItem(result());
        return item ? legacy(item) : null;
      },
    ),
  );

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
        const nextType = activeFilter === 'all' ? 'posts' : activeFilter;
        window.history.pushState({}, '', `/search?q=${encodeURIComponent(q)}&type=${nextType}`);
        window.dispatchEvent(
          new CustomEvent('spaNavigate', {
            detail: { view: 'search', searchQuery: q, searchType: nextType },
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
  const hideSections = () => {
    for (const element of [
      usersLabel,
      usersHost,
      usersDivider,
      arcadeLabel,
      arcadeRowsHost,
      arcadeCardsWrapper,
      arcadeDivider,
      postsLabel,
      postsHost,
      webDivider,
      webLabel,
      webHost,
      empty,
    ]) {
      element.hidden = true;
    }
  };

  const showStatus = (text: string, danger = false) => {
    hideSections();
    statusHost.hidden = false;
    statusHost.textContent = text;
    statusHost.style.cssText = danger
      ? 'text-align: center; padding: 3rem; color: var(--danger);'
      : 'text-align: center; padding: 3rem; color: var(--text-muted);';
  };

  const showLoading = () => showStatus(t('common.loading'));
  const showError = () => showStatus(t('common.error'), true);

  const tabForFilter = (filter: SearchFilter): string => (filter === 'arcade' ? 'games' : filter);

  const loadSearchResults = async (filter: SearchFilter = activeFilter) => {
    const requestId = ++loadRequestId;
    showLoading();
    try {
      const response = await fetch(
        `/api/search/v2?q=${encodeURIComponent(query)}&tab=${tabForFilter(filter)}&limit=20`,
      );
      if (!response.ok) throw new Error(`Search failed with ${response.status}`);
      const data = (await response.json()) as {
        posts?: Post[];
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
        games?: Post[];
        web?: WebSearchResult[];
      };
      if (requestId !== loadRequestId) return;

      allUsers = uniqueBy(data.users || [], (user) => user.id);
      allPosts = uniqueBy(data.posts || [], (post) => post.id);
      allArcade = uniqueBy(data.games || [], (post) => post.id);
      allWeb = uniqueBy(data.web || [], (result) => result.url);

      renderResults();
    } catch (error) {
      if (requestId !== loadRequestId) return;
      console.error('Search error:', error);
      showError();
    }
  };

  // ── Rendering ──
  const renderResults = () => {
    const showAll = activeFilter === 'all';
    const showUsers = (showAll || activeFilter === 'users') && allUsers.length > 0;
    const showArcade = (showAll || activeFilter === 'arcade') && allArcade.length > 0;
    const showPosts = (showAll || activeFilter === 'posts') && allPosts.length > 0;
    const showWeb = (showAll || activeFilter === 'web') && allWeb.length > 0;
    const anyVisible = showUsers || showArcade || showPosts || showWeb;

    usersSignal.set(allUsers);
    arcadeSignal.set(allArcade);
    postsSignal.set(allPosts);
    webSignal.set(allWeb);

    statusHost.hidden = true;
    usersHost.hidden = !showUsers;
    usersLabel.hidden = !(showAll && showUsers);
    usersDivider.hidden = !(showAll && showUsers && showArcade);

    arcadeLabel.hidden = !showArcade;
    arcadeRowsHost.hidden = !(showArcade && !showAll);
    arcadeCardsWrapper.hidden = !(showArcade && showAll);
    arcadeDivider.hidden = !(showAll && showArcade && showPosts);

    postsHost.hidden = !showPosts;
    postsLabel.hidden = !(showAll && showPosts);

    webHost.hidden = !showWeb;
    webLabel.hidden = !showWeb;
    webDivider.hidden = !(showAll && showWeb && (showUsers || showArcade || showPosts));
    empty.hidden = anyVisible;
    requestAnimationFrame(updateArcadeFade);
  };

  function createUserRow(user: SearchUser): HTMLElement {
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
    return userItem;
  }

  function createWebItem(result: WebSearchResult): HTMLElement | null {
    let href: string;
    try {
      const parsed = new URL(result.url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
      href = parsed.toString();
    } catch {
      return null;
    }

    const item = document.createElement('a');
    item.href = href;
    item.target = '_blank';
    item.rel = 'noopener noreferrer';
    item.style.cssText = `
      display: block;
      padding: 0.75rem;
      border-radius: 0.5rem;
      text-decoration: none;
      transition: background 0.2s ease;
    `;
    item.addEventListener('mouseenter', () => {
      item.style.background = 'var(--bg-secondary)';
    });
    item.addEventListener('mouseleave', () => {
      item.style.background = 'transparent';
    });

    const title = document.createElement('div');
    title.textContent = result.title;
    title.style.cssText = `
      font-weight: 600;
      color: var(--link, var(--accent));
      font-size: 0.95rem;
      line-height: 1.35;
    `;

    const meta = document.createElement('div');
    let hostname = '';
    try {
      hostname = new URL(href).hostname;
    } catch {
      hostname = '';
    }
    meta.textContent = [result.source, hostname].filter(Boolean).join(' · ');
    meta.style.cssText = 'font-size: 0.75rem; color: var(--text-muted); margin-top: 0.2rem;';

    const snippet = document.createElement('div');
    snippet.textContent = result.snippet;
    snippet.style.cssText = 'font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.3rem; line-height: 1.45;';

    item.appendChild(title);
    item.appendChild(meta);
    if (result.snippet) item.appendChild(snippet);
    return item;
  }

  function createArcadeRow(post: Post): HTMLElement {
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
    return row;
  }

  function createArcadeCard(post: Post): HTMLElement {
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
    return card;
  }

  // Start
  loadSearchResults();

  return {
    getElement: () => container,
    destroy: () => {
      usersMount.dispose();
      postsMount.dispose();
      arcadeRowsMount.dispose();
      arcadeCardsMount.dispose();
      webMount.dispose();
      container.remove();
    },
  };
}
