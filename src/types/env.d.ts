interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  CF_ACCESS_AUD: string;
  CF_TEAM_DOMAIN: string;
  SANDBOX_ORIGIN: string;
  ADMIN_USERNAMES: string;
}

interface RequestData {
  user: {
    sub: string;
    email: string;
  };
}
