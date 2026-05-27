/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SANDBOX_ORIGIN: string
  readonly VITE_CONTENT_ORIGIN: string
  readonly VITE_CLOUDFLARE_ACCOUNT_ID: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
