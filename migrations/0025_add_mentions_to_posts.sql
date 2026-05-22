-- Migration: Add mentions column to posts table
-- Stores JSON array of {username, user_id} objects for resolved mentions

ALTER TABLE posts ADD COLUMN mentions TEXT DEFAULT '[]';
