'use client';

import { useEffect } from 'react';

export function FontLoader() {
  useEffect(() => {
    const link = document.createElement('link');
    link.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700&display=swap';
    link.rel = 'stylesheet';
    link.media = 'print';
    link.onload = () => { link.media = 'all'; };
    document.head.appendChild(link);

    const gtagScript = document.createElement('script');
    gtagScript.async = true;
    gtagScript.src = 'https://www.googletagmanager.com/gtag/js?id=G-JZWZ08QFCW';
    document.head.appendChild(gtagScript);

    window.dataLayer = window.dataLayer || [];
    window.gtag = (...args: unknown[]) => { window.dataLayer!.push(args); };
    window.gtag('js', new Date());
    window.gtag('config', 'G-JZWZ08QFCW');

    const adScript = document.createElement('script');
    adScript.async = true;
    adScript.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8703789531673358';
    adScript.crossOrigin = 'anonymous';
    document.head.appendChild(adScript);
  }, []);

  return null;
}
