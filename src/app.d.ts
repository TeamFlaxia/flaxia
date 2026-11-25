// See https://svelte.dev/docs/kit/types#app
declare global {
  namespace App {
    interface Platform {
      env: Record<string, unknown>;
      context: ExecutionContext;
      caches: CacheStorage;
      cf?: IncomingRequestCfProperties;
    }
  }
}

export {};

interface ImportMetaEnv {
  /** `native` for the Tauri/Capacitor static build; absent for the web Worker. */
  readonly BUILD_TARGET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
