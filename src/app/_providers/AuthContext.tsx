'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { clearMeCache, getMe, updateMeCache } from '@/lib/auth-cache';

export interface User {
  id: string;
  username: string;
  display_name?: string;
  avatar_key?: string;
}

interface AuthContextValue {
  currentUser: User | null;
  loading: boolean;
  login: (sessionId: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  currentUser: null,
  loading: true,
  login: async () => {},
  logout: async () => {},
  refreshUser: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const data = await getMe();
      if (data) {
        const userData = data.user as User;
        setCurrentUser({
          id: userData.id,
          username: userData.username,
          display_name: userData.display_name,
          avatar_key: userData.avatar_key,
        });
      } else {
        setCurrentUser(null);
      }
    } catch {
      setCurrentUser(null);
    }
  }, []);

  useEffect(() => {
    refreshUser().finally(() => setLoading(false));
  }, [refreshUser]);

  const login = useCallback(async (sessionId: string) => {
    localStorage.setItem('flaxia_session', sessionId);
    updateMeCache({ user: { id: '', username: '', display_name: '', avatar_key: '' } });
    await refreshUser();
  }, [refreshUser]);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // ignore
    }
    localStorage.removeItem('flaxia_session');
    clearMeCache();
    setCurrentUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ currentUser, loading, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
