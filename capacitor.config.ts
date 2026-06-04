import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.flaxia.app',
  appName: 'Flaxia',
  webDir: 'dist',
  server: {
    url: 'https://flaxia.app',
    androidScheme: 'https',
    iosScheme: 'https',
    hostname: 'flaxia.app',
    allowNavigation: ['flaxia.app', '*.flaxia.app'],
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
