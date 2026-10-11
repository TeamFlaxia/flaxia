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
    hostname: 'localhost',
    // Do not allow remote websites to navigate inside the privileged WebView.
    // External links are handed to the system browser instead.
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
