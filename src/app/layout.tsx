import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './_providers/Providers';
import { FontLoader } from '@/components/client/FontLoader';

export const metadata: Metadata = {
  title: 'Flaxia',
  description: 'The SNS where your posts are playable.',
  metadataBase: new URL('https://flaxia.app'),
  openGraph: {
    title: 'Flaxia',
    description: 'The SNS where your posts are playable.',
    siteName: 'Flaxia',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Flaxia',
    description: 'The SNS where your posts are playable.',
  },
  other: {
    'google-adsense-account': 'ca-pub-8703789531673358',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://flaxia.app" />
        <link rel="dns-prefetch" href="/api" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700&swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <FontLoader />
        <Providers>
          <div id="app">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
