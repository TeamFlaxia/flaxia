CREATE TABLE flaxia_auth_sessions (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  grant_token TEXT NOT NULL,
  auth_stamp TEXT NOT NULL,
  source_stamp TEXT NOT NULL
);
