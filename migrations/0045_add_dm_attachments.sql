-- Add attachment support and editing to DM messages

ALTER TABLE dm_messages ADD COLUMN gif_key TEXT;
ALTER TABLE dm_messages ADD COLUMN payload_key TEXT;
ALTER TABLE dm_messages ADD COLUMN swf_key TEXT;
ALTER TABLE dm_messages ADD COLUMN edited_at TEXT;
