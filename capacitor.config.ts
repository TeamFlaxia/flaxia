import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.flaxia.app',
  appName: 'Flaxia',
  // Keep a built SPA available for platforms/configurations without a remote URL.
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
    // Android loads the production site directly so the document, API, and
    // SameSite=Strict session cookie all use https://flaxia.app. No local
    // virtual server or custom hostname is involved.
    ...(process.env.CAPACITOR_PLATFORM === 'android' ? { url: 'https://flaxia.app' } : {}),
    allowNavigation: ['flaxia.app', '*.flaxia.app', 'sandbox.flaxia.app'],
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_flaxia',
      iconColor: '#22c55e',
    },
    Badge: {
      persist: true,
    },
  },
};

export default config;
