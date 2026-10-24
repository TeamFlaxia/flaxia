// Local documents bundled into the signed native clients. Exact matches only;
// neither the sandbox nor arbitrary remote WebViews are privileged clients.
export const NATIVE_APP_ORIGINS = [
  'https://localhost',
  'capacitor://localhost',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
] as const;
