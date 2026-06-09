declare var VAPID_PUBLIC_KEY: string | undefined;
declare var VAPID_PRIVATE_KEY: string | undefined;
declare var FCM_SERVER_KEY: string | undefined;

interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  SANDBOX_ORIGIN: string;
  ADMIN_USERNAMES: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  CROWD_ORCHESTRATOR?: Fetcher;
  NOTIFICATION_STREAM?: DurableObjectNamespace;
  FCM_SERVER_KEY?: string;
  [key: string]: unknown;
}
