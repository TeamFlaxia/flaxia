'use client';

import { type ReactNode } from 'react';
import { AuthProvider } from './AuthContext';
import { I18nProvider } from './I18nContext';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <I18nProvider>
        {children}
      </I18nProvider>
    </AuthProvider>
  );
}
