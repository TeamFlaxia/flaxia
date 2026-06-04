declare module '@capacitor/push-notifications' {
  export interface PushNotificationToken {
    value: string;
  }

  export interface PushNotificationSchema {
    title?: string;
    body?: string;
    id: string;
    data?: Record<string, string>;
  }

  export interface ActionPerformed {
    notification: PushNotificationSchema;
    actionId?: string;
  }

  export const PushNotifications: {
    requestPermissions(): Promise<void>;
    register(): Promise<void>;
    addListener(event: 'registration', handler: (token: PushNotificationToken) => void): Promise<void>;
    addListener(event: 'registrationError', handler: (err: { error: string }) => void): Promise<void>;
    addListener(
      event: 'pushNotificationReceived',
      handler: (notification: PushNotificationSchema) => void,
    ): Promise<void>;
    addListener(event: 'pushNotificationActionPerformed', handler: (action: ActionPerformed) => void): Promise<void>;
  };
}

declare module '@capacitor/app' {
  export interface AppStateChange {
    isActive: boolean;
  }

  export const App: {
    addListener(event: 'appStateChange', handler: (state: AppStateChange) => void): Promise<void>;
  };
}
