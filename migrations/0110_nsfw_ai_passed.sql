-- Historical done rows have no recorded verdict and cannot claim AI approval.
ALTER TABLE post_nsfw_scans ADD COLUMN ai_passed INTEGER CHECK (ai_passed IN (0, 1));
