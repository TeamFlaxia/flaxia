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
  MAIL_SERVICE?: Fetcher;
  MAIL_INTERNAL_SECRET?: string;
  MAIL_DOMAIN?: string;
  NOTIFICATION_STREAM?: DurableObjectNamespace;
  MULTIPLAYER_ROOM?: DurableObjectNamespace;
  MATCHMAKER?: DurableObjectNamespace;
  FCM_SERVER_KEY?: string;
  [key: string]: unknown;
}
