import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.flaxia.app',
  appName: 'Flaxia',
  // Bundle the built SPA in the native binary instead of loading the entire app
  // from a remote URL.
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
    // Keep Android API requests same-site with flaxia.app so the existing
    // HttpOnly, SameSite=Strict session cookie works without exposing it to JS.
    // iOS retains its Capacitor-local origin and config.
    hostname: process.env.CAPACITOR_PLATFORM === 'android' ? 'native.flaxia.app' : 'localhost',
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
