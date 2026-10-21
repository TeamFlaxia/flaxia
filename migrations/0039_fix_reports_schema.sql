-- Migration: Fix reports schema, add admin_alerts and counter_notifications
-- This brings the schema in line with the application code.

-- Create admin_alerts table
CREATE TABLE IF NOT EXISTS admin_alerts (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL CHECK(priority IN ('critical', 'high', 'normal')),
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_alerts_unresolved ON admin_alerts(resolved, priority DESC, created_at DESC);

-- Create counter_notifications table for DMCA counter-notices
CREATE TABLE IF NOT EXISTS counter_notifications (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT NOT NULL,
  phone TEXT NOT NULL,
  statement TEXT NOT NULL,
  consent_jurisdiction INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'auto_restored', 'rejected_by_admin')),
  submitted_at TEXT NOT NULL,
  restore_at TEXT,
  rejected_by TEXT,
  rejected_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_counter_pending ON counter_notifications(status, restore_at);
