'use client';

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { initI18n, t as translate, setLocale, getLocale } from '@/lib/i18n';

interface I18nContextValue {
  t: (key: string, params?: Record<string, string | number>) => string;
  locale: string;
  setLocale: (locale: string) => Promise<void>;
}

const I18nContext = createContext<I18nContextValue>({
  t: (key) => key,
  locale: 'en',
  setLocale: async () => {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<string>('en');

  useEffect(() => {
    initI18n().then(() => {
      setLocaleState(getLocale());
    });
  }, []);

  const changeLocale = async (newLocale: string) => {
    await setLocale(newLocale);
    setLocaleState(newLocale);
  };

  return (
    <I18nContext.Provider value={{ t: translate, locale, setLocale: changeLocale }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
