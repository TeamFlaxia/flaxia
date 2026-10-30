-- A retry capability must survive loss of the initiating browser. The token
-- stays private in D1 alongside the grant and is erased after completion.
ALTER TABLE flaxia_auth_credential_jobs ADD COLUMN operation_token TEXT;
