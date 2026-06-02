interface Window {
  Capacitor?: {
    isNativePlatform(): boolean;
  };
  __TAURI__?: boolean;
  __TAURI_INTERNALS__?: boolean;
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  webkitAudioContext?: typeof AudioContext;
  gtag?: (...args: unknown[]) => void;
  JSZip?: unknown;
  katex?: {
    render: (text: string, element: HTMLElement, options: { throwOnError: boolean; displayMode: boolean }) => void;
  };
  __tauriDesktopPoll?: () => void;
}
