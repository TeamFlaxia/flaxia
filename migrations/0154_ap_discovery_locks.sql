-- Atomic, short-lived lock for on-demand federated discovery.
--
-- KV is eventually consistent, so two concurrent cold requests could both
-- start a discovery run and stampede the peer instances. D1's primary key plus
-- INSERT OR IGNORE gives a single winner; the owner token prevents a late run
-- from deleting another run's lock.
CREATE TABLE IF NOT EXISTS ap_discovery_locks (
  key        TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ap_discovery_locks_expires ON ap_discovery_locks(expires_at);
