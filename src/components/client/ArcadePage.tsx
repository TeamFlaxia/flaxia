'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/app/_providers/AuthContext';
import { useI18n } from '@/app/_providers/I18nContext';
import { formatCount } from '@/lib/format';
import { showToast } from '@/lib/toast';
import { getReplyStyle } from '@/lib/settings';
import { buildTree } from '@/lib/thread';
import type { PostNode } from '@/lib/thread';
import type { Game } from '@/types/game';
import type { Post } from '@/types/post';
import PostCard from '@/components/client/PostCard';
import ReplyComposer from '@/components/client/ReplyComposer';
import { LeftNav } from '@/components/client/LeftNav';

interface GamePlayerProps {
  game: Game;
  sandboxOrigin: string;
}

function GamePlayer({ game, sandboxOrigin }: GamePlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = '';

    if (game.type === 'zip' || game.type === 'html5') {
      const src = `${sandboxOrigin}/sandbox/${game.payloadKey}/index.html`;
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'width: 100%; height: 100%; border: none;';
      iframe.allow = 'autoplay; fullscreen';
      iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-downloads');
      iframe.src = src;
      iframe.onerror = () => setLoadError('Failed to load game');
      container.appendChild(iframe);
    } else if (game.type === 'dos' && game.dosKey) {
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'width: 100%; height: 100%; border: none;';
      iframe.allow = 'autoplay; fullscreen';
      iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-downloads');
      iframe.src = `${sandboxOrigin}/sandbox/${game.dosKey}/index.html`;
      iframe.onerror = () => setLoadError('Failed to load DOS game');
      container.appendChild(iframe);
    } else if (game.type === 'flash' && game.swfKey) {
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'width: 100%; height: 100%; border: none;';
      iframe.allow = 'autoplay; fullscreen';
      iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-downloads');
      iframe.src = `${sandboxOrigin}/flash/${game.swfKey}`;
      iframe.onerror = () => setLoadError('Failed to load Flash game');
      container.appendChild(iframe);
    } else {
      setLoadError('Unsupported game type');
    }

    return () => { container.innerHTML = ''; };
  }, [game, sandboxOrigin]);

  if (loadError) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: '#ef4444' }}>{loadError}</div>;
  }

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}

interface CommentModalProps {
  postId: string;
  sandboxOrigin: string;
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null;
  onClose: () => void;
}

function CommentModal({ postId, sandboxOrigin, currentUser, onClose }: CommentModalProps) {
  const { t } = useI18n();
  const [replies, setReplies] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const commentGenRef = useRef(0);

  const loadComments = useCallback(async () => {
    const myGen = ++commentGenRef.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/posts/${postId}/thread`);
      if (!res.ok) throw new Error('Failed');
      if (myGen !== commentGenRef.current) return;
      const data = await res.json() as { replies: Post[] };
      if (myGen !== commentGenRef.current) return;
      setReplies(data.replies || []);
    } catch {} finally {
      if (myGen === commentGenRef.current) setLoading(false);
    }
  }, [postId]);

  useEffect(() => { loadComments(); }, [loadComments]);

  const handleReplyCreated = useCallback((newReply: Post) => {
    setReplies(prev => [...prev, newReply]);
  }, []);

  const replyStyle = typeof window !== 'undefined' ? getReplyStyle() : '2ch';

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 12, maxWidth: 500, width: '90%',
        maxHeight: '80vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>
            {t('thread_view.title')} ({formatCount(replies.length)})
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.1rem' }}>✕</button>
        </div>

        <ReplyComposer
          postId={postId}
          onReplyCreated={handleReplyCreated}
          onCancel={() => {}}
        />

        <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '0.5rem 0' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>{t('common.loading')}</div>
          ) : replies.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>{t('thread.no_replies')}</div>
          ) : (
            <div className="replies-container">
              {replyStyle === 'twitter' ? (
                buildTree(replies).map(node => (
                  <ReplyNodeComponent
                    key={node.post.id}
                    node={node}
                    sandboxOrigin={sandboxOrigin}
                    currentUser={currentUser}
                    postIndex={0}
                  />
                ))
              ) : (
                replies.map((reply, idx) => (
                  <PostCard
                    key={reply.id}
                    post={reply}
                    sandboxOrigin={sandboxOrigin}
                    currentUser={currentUser}
                    depth={reply.depth}
                    disableNavigation
                    postIndex={idx + 1}
                    enablePostRefs
                  />
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ReplyNodeComponent({ node, sandboxOrigin, currentUser, postIndex }: {
  node: PostNode; sandboxOrigin: string;
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null;
  postIndex: number;
}) {
  return (
    <div className="reply-node" style={{ marginLeft: '1rem', borderLeft: '2px solid var(--border-color, #e2e8f0)', paddingLeft: '0.75rem' }}>
      <PostCard post={node.post} sandboxOrigin={sandboxOrigin} currentUser={currentUser} depth={node.post.depth} disableNavigation postIndex={postIndex} enablePostRefs />
      {node.children.map((child, idx) => (
        <ReplyNodeComponent key={child.post.id} node={child} sandboxOrigin={sandboxOrigin} currentUser={currentUser} postIndex={postIndex + idx + 1} />
      ))}
    </div>
  );
}

export default function ArcadePage({ initialGameId, onBack }: { initialGameId?: string; onBack?: () => void }) {
  const { currentUser } = useAuth();
  const { t } = useI18n();

  const [games, setGames] = useState<Game[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [showTutorial, setShowTutorial] = useState(false);
  const [showComments, setShowComments] = useState(false);

  const sandboxOrigin = process.env.NEXT_PUBLIC_SANDBOX_ORIGIN || 'http://localhost:3001';

  useEffect(() => {
    if (typeof window !== 'undefined' && !localStorage.getItem('flaxia_tutorial_seen')) {
      setShowTutorial(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/arcade/games?limit=50', { credentials: 'include' })
      .then(res => res.json() as Promise<{ games: Game[] }>)
      .then(data => {
        if (cancelled) return;
        const list = Array.isArray(data.games) ? data.games : [];
        setGames(list);
        setHasMore(list.length === 50);
        if (initialGameId) {
          const idx = list.findIndex(g => g.id === initialGameId);
          if (idx >= 0) setCurrentIndex(idx);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [initialGameId]);

  const handleFresh = useCallback(async () => {
    const game = games[currentIndex];
    if (!game || !currentUser) {
      // show sign in prompt
      return;
    }
    try {
      const res = await fetch(`/api/posts/${game.postId}/fresh`, { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error();
      const data = await res.json() as { freshed: boolean; freshCount: number };
      setGames(prev => prev.map((g, i) => i === currentIndex ? {
        ...g, isFreshed: data.freshed, freshCount: data.freshCount,
      } : g));
    } catch {}
  }, [currentIndex, games, currentUser]);

  const handleFullscreen = useCallback(() => {
    const el = document.querySelector('.arcade-game-area') as HTMLElement;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen().catch(() => {});
    }
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (showComments || showTutorial) return;
    if (document.fullscreenElement) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCurrentIndex(i => Math.max(0, i - 1));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCurrentIndex(i => Math.min(games.length - 1, i + 1));
    }
  }, [showComments, showTutorial, games.length]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Preconnect to emulator CDNs
  useEffect(() => {
    const urls = ['https://unpkg.com', 'https://v8.js-dos.com', 'https://sandbox.flaxia.app'];
    for (const href of urls) {
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = href;
      document.head.appendChild(link);
    }
  }, []);

  const currentGame = games[currentIndex] || null;

  return (
    <div className="main-container" style={{ background: '#ffffff', minHeight: '100vh' }}>
      <LeftNav activeItem="arcade" />
      <div className="arcade-page" style={{
        flex: 1, display: 'flex', flexDirection: 'column', height: '100dvh',
        overflow: 'hidden', background: 'var(--bg-primary)', position: 'relative',
      }}>
        {/* Header */}
        <div className="arcade-header" style={{
          padding: '0.4rem 0.75rem', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0,
        }}>
          {onBack && (
            <button onClick={onBack} style={{
              background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer',
              color: 'var(--text-primary)', padding: '0.15rem 0.35rem', borderRadius: 4,
              lineHeight: 1,
            }}>←</button>
          )}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <h1 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
              {t('arcade.title')}
            </h1>
            <span style={{ fontSize: '0.75rem', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
              {t('arcade.subtitle')}
            </span>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={() => setShowTutorial(true)} style={{
            background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer',
            color: 'var(--text-muted)', padding: '0.25rem 0.5rem', borderRadius: 4,
          }}>
            {t('arcade.tutorial_btn')}
          </button>
        </div>

        {/* Game container */}
        <div className="arcade-game-container" style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {/* Nav arrows */}
          {currentIndex > 0 && (
            <button onClick={() => setCurrentIndex(i => i - 1)} style={{
              position: 'absolute', top: '1rem', left: '50%', transform: 'translateX(-50%)',
              width: 48, height: 48, borderRadius: '50%', border: 'none',
              background: 'rgba(0,0,0,0.5)', color: 'white', fontSize: '1.25rem',
              cursor: 'pointer', zIndex: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
              opacity: 0.7,
            }}>▲</button>
          )}
          {currentIndex < games.length - 1 && (
            <button onClick={() => setCurrentIndex(i => i + 1)} style={{
              position: 'absolute', bottom: '1rem', left: '50%', transform: 'translateX(-50%)',
              width: 48, height: 48, borderRadius: '50%', border: 'none',
              background: 'rgba(0,0,0,0.5)', color: 'white', fontSize: '1.25rem',
              cursor: 'pointer', zIndex: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
              opacity: 0.7,
            }}>▼</button>
          )}

          {loading ? (
            <div style={{
              position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem',
            }}>
              <div className="spinner" />
              <div style={{ fontSize: '1.5rem', color: 'var(--text-muted)' }}>{t('arcade.loading')}</div>
            </div>
          ) : !currentGame ? (
            <div style={{
              position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
              textAlign: 'center', color: 'var(--text-muted)',
            }}>
              <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>🎮</div>
              <div style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>{t('arcade.no_games_title')}</div>
              <div style={{ fontSize: '0.875rem' }}>{t('arcade.no_games_subtitle')}</div>
            </div>
          ) : (
            <div className="arcade-viewport" style={{
              width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative',
            }}>
              {/* Info overlay */}
              <div className="arcade-info-overlay" style={{
                position: 'absolute', top: '0.5rem', left: '0.5rem', zIndex: 10,
                background: 'rgba(0,0,0,0.6)', color: 'white', padding: '0.5rem 0.75rem',
                borderRadius: 8, fontSize: '0.9rem', backdropFilter: 'blur(4px)',
              }}>
                <div style={{ fontWeight: 600 }}>{currentGame.title}</div>
                <div style={{ fontSize: '0.875rem', opacity: 0.9 }}>{t('arcade.game_author', { username: currentGame.username })}</div>
              </div>

              {/* Game area */}
              <div className="arcade-game-area" style={{
                flex: 1, position: 'relative', display: 'flex', alignItems: 'center',
                justifyContent: 'center', overflow: 'hidden',
              }}>
                <GamePlayer game={currentGame} sandboxOrigin={sandboxOrigin} />
              </div>

              {/* Floating action buttons */}
              <div className="arcade-floating-actions" style={{
                position: 'absolute', right: '1rem', top: '50%', transform: 'translateY(-50%)',
                display: 'flex', flexDirection: 'column', gap: '1rem', zIndex: 10,
              }}>
                <button onClick={handleFresh} style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem',
                  background: 'rgba(255,255,255,0.12)', border: 'none', borderRadius: 12,
                  cursor: 'pointer', color: currentGame?.isFreshed ? '#22c55e' : 'white',
                  padding: '0.5rem', fontSize: '0.875rem', fontWeight: 700, lineHeight: 1.4, backdropFilter: 'blur(4px)',
                  transition: 'all 0.15s',
                }}>
                  <span style={{ fontSize: '1.2rem' }}>🍃</span>
                  <span>{formatCount(currentGame?.freshCount || 0)}</span>
                </button>
                <button onClick={handleFullscreen} style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem',
                  background: 'rgba(255,255,255,0.12)', border: 'none', borderRadius: 12,
                  cursor: 'pointer', color: 'white', padding: '0.5rem', fontSize: '0.75rem',
                  lineHeight: 1.4, backdropFilter: 'blur(4px)', transition: 'all 0.15s',
                }}>
                  <span style={{ fontSize: '1.2rem' }}>⛶</span>
                  <span>{t('arcade.fullscreen')}</span>
                </button>
                <button onClick={() => setShowComments(true)} style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem',
                  background: 'rgba(255,255,255,0.12)', border: 'none', borderRadius: 12,
                  cursor: 'pointer', color: 'white', padding: '0.5rem', fontSize: '0.875rem',
                  fontWeight: 700, lineHeight: 1.4, backdropFilter: 'blur(4px)', transition: 'all 0.15s',
                }}>
                  <span style={{ fontSize: '1.2rem' }}>💬</span>
                  <span>{formatCount(currentGame?.replyCount || 0)}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Comment modal */}
        {showComments && currentGame && (
          <CommentModal
            postId={currentGame.postId}
            sandboxOrigin={sandboxOrigin}
            currentUser={currentUser}
            onClose={() => setShowComments(false)}
          />
        )}

        {/* Tutorial modal */}
        {showTutorial && (
          <div
            onClick={e => { if (e.target === e.currentTarget) { setShowTutorial(false); try { localStorage.setItem('flaxia_tutorial_seen', '1'); } catch {} } }}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 2000, color: 'white', textAlign: 'center',
            }}
          >
            <div style={{ maxWidth: 400, padding: '1rem' }}>
              <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🎮</div>
              <h2 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>{t('arcade.tutorial_title')}</h2>
              <p style={{ marginBottom: '0.5rem', lineHeight: 1.6 }}>{t('arcade.tutorial_swipe')}</p>
              <p style={{ marginBottom: '0.5rem', lineHeight: 1.6 }}>{t('arcade.tutorial_arrows')}</p>
              <p style={{ marginBottom: '1.5rem', lineHeight: 1.6 }}>{t('arcade.tutorial_actions')}</p>
              <button
                onClick={() => { setShowTutorial(false); try { localStorage.setItem('flaxia_tutorial_seen', '1'); } catch {} }}
                style={{
                  padding: '0.75rem 2rem', borderRadius: 9999, border: 'none',
                  background: '#22c55e', color: 'white', fontWeight: 600, cursor: 'pointer', fontSize: '1rem',
                }}
              >
                {t('arcade.tutorial_start')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
