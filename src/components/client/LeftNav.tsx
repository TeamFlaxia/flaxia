'use client';

import { useRouter } from 'next/navigation';
import { useAuth } from '@/app/_providers/AuthContext';
import { useI18n } from '@/app/_providers/I18nContext';
import { useNotification } from '@/app/_providers/NotificationContext';

interface LeftNavProps {
  activeItem?: 'home' | 'explore' | 'arcade' | 'notifications' | 'bookmarks' | 'settings' | 'profile';
}

export function LeftNav({ activeItem }: LeftNavProps) {
  const router = useRouter();
  const { currentUser } = useAuth();
  const { t } = useI18n();
  const { unreadCount } = useNotification();

  return (
    <nav className="left-nav">
      <div className="nav-logo" style={{ fontFamily: 'monospace', fontSize: '1.25rem', fontWeight: 'bold', color: 'var(--accent)' }}>
        Flaxia
      </div>
      <div className="nav-items">
        <button
          className={`nav-item${activeItem === 'home' ? ' nav-item--active' : ''}`}
          onClick={() => router.push('/')}
        >
          <span>🏠</span> Home
        </button>
        <button
          className={`nav-item${activeItem === 'explore' ? ' nav-item--active' : ''}`}
          onClick={() => router.push('/explore')}
        >
          <span>🔍</span> Explore
        </button>
        <button
          className={`nav-item${activeItem === 'arcade' ? ' nav-item--active' : ''}`}
          onClick={() => router.push('/arcade')}
        >
          <span>🎮</span> Arcade
        </button>
        <button
          className={`nav-item${activeItem === 'notifications' ? ' nav-item--active' : ''}`}
          onClick={() => router.push('/notifications')}
        >
          <span>🔔</span> Notifications
        </button>
        <button
          className={`nav-item${activeItem === 'bookmarks' ? ' nav-item--active' : ''}`}
          onClick={() => router.push('/bookmarks')}
        >
          <span>🔖</span> Bookmarks
        </button>
        <button
          className={`nav-item${activeItem === 'settings' ? ' nav-item--active' : ''}`}
          onClick={() => router.push('/settings')}
        >
          <span>⚙️</span> Settings
        </button>
        <button
          className={`nav-item${activeItem === 'profile' ? ' nav-item--active' : ''}`}
          onClick={() => {
            if (currentUser) router.push(`/users/${currentUser.username}`);
          }}
        >
          <span>👤</span> Profile
        </button>
      </div>
      <button className="nav-post-button">Post</button>
      {!currentUser && (
        <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <button className="nav-post-button" style={{ background: 'transparent', border: '1px solid var(--accent)', color: 'var(--accent)' }} onClick={() => router.push('/login')}>
            Sign In
          </button>
          <button className="nav-post-button" onClick={() => router.push('/register')}>
            Sign Up
          </button>
        </div>
      )}
    </nav>
  );
}
