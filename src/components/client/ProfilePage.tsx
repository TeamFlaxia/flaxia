'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/app/_providers/AuthContext';
import { useI18n } from '@/app/_providers/I18nContext';
import { formatCount } from '@/lib/format';
import { clearMeCache } from '@/lib/auth-cache';
import { registerModal } from '@/lib/modal-state';
import { openPostModal } from '@/lib/post-modal';
import type { Post } from '@/types/post';
import UserPostList from '@/components/client/UserPostList';

interface ProfileUserData {
  username: string;
  display_name?: string;
  bio?: string;
  avatar_key?: string | null;
  created_at?: string;
  posts_count?: number;
  followers_count?: number;
  following_count?: number;
  is_following?: boolean;
}

export default function ProfilePage({ username }: { username: string }) {
  const { currentUser } = useAuth();
  const { t } = useI18n();
  const [userData, setUserData] = useState<ProfileUserData | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [followLoading, setFollowLoading] = useState(false);
  const isOwnProfile = currentUser?.username === username;

  const loadUserData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/users/${username}`);
      if (res.ok) {
        const data = (await res.json()) as { user: ProfileUserData };
        setUserData(data.user);
        setIsFollowing(data.user.is_following || false);
      }
    } catch (err) {
      console.error('Failed to load user data:', err);
    } finally {
      setLoading(false);
    }
  }, [username]);

  useEffect(() => {
    loadUserData();
  }, [loadUserData]);

  const handleFollowToggle = useCallback(async () => {
    if (!currentUser) return;
    if (followLoading) return;
    setFollowLoading(true);
    try {
      const method = isFollowing ? 'DELETE' : 'POST';
      const res = await fetch(`/api/users/${username}/follow`, {
        method,
        credentials: 'include',
      });
      if (res.ok) {
        const result = (await res.json()) as { followers_count: number; following_count: number };
        setIsFollowing(!isFollowing);
        setUserData(prev => prev ? {
          ...prev,
          followers_count: result.followers_count,
          following_count: result.following_count,
        } : prev);
      }
    } catch (err) {
      console.error('Follow toggle error:', err);
    } finally {
      setFollowLoading(false);
    }
  }, [currentUser, followLoading, isFollowing, username]);

  const handleLogout = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      if (res.ok) {
        clearMeCache();
        window.location.href = '/';
      }
    } catch (err) {
      console.error('Logout error:', err);
    }
  }, []);

  const confirmLogout = useCallback(() => {
    if (!currentUser) return;
    const overlay = document.createElement('div');
    const unregister = registerModal();
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:2000;';
    overlay.innerHTML = `
      <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:1.5rem;max-width:320px;width:90%;text-align:center;">
        <h3 style="margin:0 0 1rem;color:var(--text-primary);font-size:1.125rem;">${t('profile.logout_title', { username: currentUser.username })}</h3>
        <div style="display:flex;gap:0.75rem;justify-content:center;">
          <button class="cancel-btn" style="padding:0.5rem 1rem;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:9999px;cursor:pointer;font-size:0.875rem;">${t('common.cancel')}</button>
          <button class="confirm-btn" style="padding:0.5rem 1rem;background:var(--text-primary);color:var(--bg-primary);border:none;border-radius:9999px;cursor:pointer;font-size:0.875rem;font-weight:600;">${t('auth.sign_out')}</button>
        </div>
      </div>`;
    overlay.querySelector('.cancel-btn')?.addEventListener('click', () => { unregister(); overlay.remove(); });
    overlay.querySelector('.confirm-btn')?.addEventListener('click', () => { handleLogout(); unregister(); overlay.remove(); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { unregister(); overlay.remove(); } });
    document.body.appendChild(overlay);
  }, [currentUser, handleLogout, t]);

  const handleNewPost = useCallback((_post: Post) => {
    // TODO: reload user posts
  }, []);

  const handleFabClick = useCallback(() => {
    if (!currentUser) return;
    openPostModal({ currentUser, onPostCreated: handleNewPost });
  }, [currentUser, handleNewPost]);

  return (
    <div className="profile-page">
      <div style={{
        display: 'flex', alignItems: 'center', padding: '0.5rem',
        borderBottom: '1px solid var(--border)', position: 'sticky', top: 0,
        background: 'var(--bg-primary)', zIndex: 10,
      }}>
        <button
          onClick={() => window.history.back()}
          style={{
            background: 'none', border: 'none', color: 'var(--text-primary, inherit)',
            cursor: 'pointer', padding: '0.5rem 0.75rem', fontSize: '1.2rem',
            borderRadius: '0.5rem',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
        >
          &larr;
        </button>
        <span style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', marginLeft: '0.25rem' }}>
          @{username}
        </span>
      </div>

      {loading ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>{t('common.loading')}</div>
      ) : userData ? (
        <>
          <div className="profile-header">
            <div className="profile-avatar-section" style={{ display: 'flex', gap: '1rem', padding: '1rem' }}>
              <div
                className="profile-avatar"
                style={{
                  width: 64, height: 64, borderRadius: '50%', background: 'var(--accent)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.5rem', fontWeight: 'bold', color: '#000',
                  backgroundSize: 'cover', backgroundPosition: 'center',
                  ...(userData.avatar_key ? { backgroundImage: `url(/api/images/${userData.avatar_key})`, color: 'transparent' } : {}),
                }}
              >
                {!userData.avatar_key ? userData.username.charAt(0).toUpperCase() : ''}
              </div>
              <div className="profile-info" style={{ flex: 1 }}>
                <div className="profile-display-name" style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>
                  {userData.display_name || userData.username}
                </div>
                <div className="profile-username" style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                  @{userData.username}
                </div>
                {userData.bio && (
                  <div className="profile-bio" style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap' }}>
                    {userData.bio}
                  </div>
                )}
                {userData.created_at && (
                  <div className="profile-joined-date" style={{
                    color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '0.5rem',
                  }}>
                    {t('profile.joined', { date: new Date(userData.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) })}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="profile-stats" style={{ display: 'flex', gap: '1.5rem', padding: '0.5rem 1rem' }}>
            <div><strong>{formatCount(userData.posts_count || 0)}</strong> {t('profile.posts_label')}</div>
            <div style={{ cursor: 'pointer' }}><strong>{formatCount(userData.followers_count || 0)}</strong> {t('profile.followers_label')}</div>
            <div style={{ cursor: 'pointer' }}><strong>{formatCount(userData.following_count || 0)}</strong> {t('profile.following_label')}</div>
          </div>

          <hr style={{ margin: '0.5rem 0', border: 'none', borderTop: '1px solid var(--border)' }} />

          <div className="profile-actions" style={{ padding: '0.5rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {isOwnProfile && (
              <>
                <button
                  className="profile-button profile-button--primary"
                  style={{ padding: '0.5rem 1rem', borderRadius: '9999px', cursor: 'pointer', background: 'var(--accent)', border: 'none', fontWeight: 600 }}
                >
                  {t('profile.edit')}
                </button>
                <button
                  onClick={confirmLogout}
                  className="profile-button profile-button--secondary"
                  style={{ padding: '0.5rem 1rem', borderRadius: '9999px', cursor: 'pointer', background: 'none', border: '1px solid var(--border)' }}
                >
                  {t('profile.log_out')}
                </button>
              </>
            )}
            {!isOwnProfile && currentUser && (
              <button
                onClick={handleFollowToggle}
                disabled={followLoading}
                className={`profile-button ${isFollowing ? 'profile-button--primary' : 'profile-button--secondary'}`}
                style={{
                  padding: '0.5rem 1rem', borderRadius: '9999px', cursor: 'pointer',
                  background: isFollowing ? 'var(--accent)' : 'none',
                  border: isFollowing ? 'none' : '1px solid var(--border)',
                  fontWeight: isFollowing ? 600 : 'normal',
                }}
              >
                {followLoading ? '...' : isFollowing ? t('profile.following') : t('profile.follow')}
              </button>
            )}
          </div>

          <div className="profile-posts" style={{ padding: '1rem 0' }}>
            <UserPostList username={username} currentUser={currentUser} />
          </div>
        </>
      ) : (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
          {t('profile.user_not_found')}
        </div>
      )}

      {currentUser && (
        <button
          className="timeline-fab visible"
          onClick={handleFabClick}
          style={{
            position: 'fixed', bottom: '1.5rem', right: '1.5rem',
            width: 48, height: 48, borderRadius: '50%',
            background: 'var(--accent)', border: 'none',
            fontSize: '1.5rem', cursor: 'pointer', zIndex: 100,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          +
        </button>
      )}
    </div>
  );
}
