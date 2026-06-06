'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/app/_providers/AuthContext';
import { useI18n } from '@/app/_providers/I18nContext';
import type { Post } from '@/types/post';
import PostCard from '@/components/client/PostCard';

type SearchFilter = 'all' | 'users' | 'posts' | 'arcade';

interface ArcadeItem {
  id: string;
  title: string;
  payload_key?: string;
  payload_type?: 'zip' | 'swf';
  thumbnail_key?: string;
  username?: string;
  fresh_count?: number;
}

function userMatches(q: string, user: { username: string; display_name?: string }): boolean {
  const lq = q.toLowerCase();
  return user.username.toLowerCase().includes(lq) || (user.display_name || '').toLowerCase().includes(lq);
}

export default function SearchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { currentUser } = useAuth();
  const { t } = useI18n();

  const queryParam = searchParams.get('q') || '';
  const typeParam = (searchParams.get('type') || 'all') as SearchFilter;

  const [query, setQuery] = useState(queryParam);
  const [filter, setFilter] = useState<SearchFilter>(typeParam);
  const [posts, setPosts] = useState<Post[]>([]);
  const [users, setUsers] = useState<Array<{ username: string; display_name?: string; avatar_key?: string }>>([]);
  const [arcade, setArcade] = useState<ArcadeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(!!queryParam);
  const [suggestions, setSuggestions] = useState<Array<string>>([]);
  const suggestTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController>(undefined);

  const sandboxOrigin = process.env.NEXT_PUBLIC_SANDBOX_ORIGIN || 'http://localhost:3001';

  const doSearch = useCallback(async (q: string, f: SearchFilter) => {
    if (!q.trim()) return;
    setLoading(true);
    setHasSearched(true);
    router.replace(`/search?q=${encodeURIComponent(q)}&type=${f}`);
    try {
      if (f === 'all' || f === 'posts' || f === 'users') {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&type=posts&limit=20`);
        if (res.ok) {
          const data = (await res.json()) as { results?: (Post & { _type?: string })[] };
          const results = data.results || [];
          setPosts(results.filter((r: { _type?: string }) => r._type !== 'user') as Post[]);
          setUsers(results.filter((r: { _type?: string }) => r._type === 'user') as Array<{ username: string; display_name?: string; avatar_key?: string }>);
        }
      }
      if (f === 'all' || f === 'arcade') {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&type=arcade&limit=20`);
        if (res.ok) {
          const data = (await res.json()) as { results?: ArcadeItem[] };
          setArcade(data.results || []);
        }
      }
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, [router]);

  useEffect(() => {
    if (queryParam) doSearch(queryParam, typeParam);
  }, []);

  const handleInput = useCallback((value: string) => {
    setQuery(value);
    clearTimeout(suggestTimeout.current);
    abortRef.current?.abort();
    if (value.length > 1) {
      suggestTimeout.current = setTimeout(async () => {
        const ac = new AbortController();
        abortRef.current = ac;
        try {
          const [tagsRes, usersRes] = await Promise.all([
            fetch(`/api/tags/suggest?q=${encodeURIComponent(value)}&limit=5`, { signal: ac.signal }),
            fetch(`/api/users/suggest?q=${encodeURIComponent(value)}&limit=5`, { signal: ac.signal }),
          ]);
          const s: Array<string> = [];
          if (tagsRes.ok) {
            const td = (await tagsRes.json()) as { tags?: Array<{ tag: string }> };
            (td.tags || []).forEach((tag: { tag: string }) => s.push(`#${tag.tag}`));
          }
          if (usersRes.ok) {
            const ud = (await usersRes.json()) as { users?: Array<{ username: string }> };
            (ud.users || []).forEach((u: { username: string }) => s.push(`@${u.username}`));
          }
          setSuggestions(s);
        } catch {}
      }, 200);
    } else { setSuggestions([]); }
  }, []);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    setSuggestions([]);
    if (query.startsWith('#')) {
      router.push(`/explore?tag=${encodeURIComponent(query.slice(1))}`);
      return;
    }
    doSearch(query, filter);
  }, [query, filter, router, doSearch]);

  const handleSuggestionClick = useCallback((s: string) => {
    setSuggestions([]);
    if (s.startsWith('#')) {
      setQuery(s);
      router.push(`/explore?tag=${encodeURIComponent(s.slice(1))}`);
    } else if (s.startsWith('@')) {
      router.push(`/users/${s.slice(1)}`);
    }
  }, [router]);

  const switchFilter = useCallback((f: SearchFilter) => {
    setFilter(f);
    if (query.trim()) doSearch(query, f);
  }, [query, doSearch]);

  return (
    <div className="search-page">
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-primary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '0.5rem', gap: '0.5rem' }}>
          <button onClick={() => router.back()} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', padding: '0.25rem' }}>&larr;</button>
          <form onSubmit={handleSubmit} style={{ flex: 1, position: 'relative' }}>
            <input
              value={query}
              onChange={e => handleInput(e.target.value)}
              placeholder={t('search.placeholder')}
              style={{ width: '100%', padding: '0.5rem', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
            />
            {suggestions.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4, zIndex: 20 }}>
                {suggestions.map((s, i) => (
                  <div key={i} onClick={() => handleSuggestionClick(s)} style={{ padding: '0.5rem', cursor: 'pointer' }}>{s}</div>
                ))}
              </div>
            )}
          </form>
        </div>
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)' }}>
          {(['all', 'users', 'posts', 'arcade'] as SearchFilter[]).map(f => (
            <button
              key={f}
              onClick={() => switchFilter(f)}
              style={{
                flex: 1, padding: '0.5rem', border: 'none', background: filter === f ? 'var(--accent)' : 'none',
                color: filter === f ? '#000' : 'var(--text-primary)', cursor: 'pointer', fontWeight: filter === f ? 600 : 'normal',
              }}
            >
              {t(`search.filter_${f}`)}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>{t('common.loading')}</div>
      ) : hasSearched ? (
        <>
          {(filter === 'all' || filter === 'users') && users.length > 0 && (
            <div style={{ padding: '0.5rem 0' }}>
              <h3 style={{ fontSize: '0.875rem', padding: '0 1rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{t('search.users_section')}</h3>
              {users.map(u => (
                <div
                  key={u.username}
                  onClick={() => router.push(`/users/${u.username}`)}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem', cursor: 'pointer' }}
                >
                  <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', backgroundSize: 'cover', ...(u.avatar_key ? { backgroundImage: `url(/api/images/${u.avatar_key})`, color: 'transparent' } : {}) }}>
                    {!u.avatar_key ? u.username.charAt(0).toUpperCase() : ''}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600 }}>{u.display_name || u.username}</div>
                    <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>@{u.username}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {(filter === 'all' || filter === 'posts') && (
            <div className="post-list">
              {posts.length > 0 ? posts.map(p => (
                <PostCard key={p.id} post={p} sandboxOrigin={sandboxOrigin} currentUser={currentUser} />
              )) : filter === 'posts' && (
                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>{t('search.no_posts')}</div>
              )}
            </div>
          )}
          {(filter === 'all' || filter === 'arcade') && arcade.length > 0 && (
            <div style={{ padding: '0.5rem 0' }}>
              <h3 style={{ fontSize: '0.875rem', padding: '0 1rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{t('search.arcade_section')}</h3>
              <div style={{ display: 'flex', overflowX: 'auto', gap: '0.75rem', padding: '0.75rem 1rem' }}>
                {arcade.map(a => (
                  <div
                    key={a.id}
                    onClick={() => router.push(`/arcade/${a.id}`)}
                    style={{ flex: '0 0 160px', cursor: 'pointer', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}
                  >
                    <div style={{ width: 160, height: 90, background: 'var(--bg-secondary)', backgroundSize: 'cover', backgroundPosition: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', ...(a.thumbnail_key ? { backgroundImage: `url(/api/images/${a.thumbnail_key})` } : {}) }}>
                      {!a.thumbnail_key && <span style={{ fontSize: '2rem' }}>&#x1f3ae;</span>}
                    </div>
                    <div style={{ padding: '0.5rem', fontSize: '0.875rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.title}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!loading && users.length === 0 && posts.length === 0 && arcade.length === 0 && (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>{t('search.no_results')}</div>
          )}
        </>
      ) : (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>{t('search.hint')}</div>
      )}
    </div>
  );
}
