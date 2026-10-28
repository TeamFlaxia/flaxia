# Authentication authority transition

Flaxia Auth is the target authority for credentials, authentication and
grant revocation. Flaxia remains responsible for local account availability,
roles, SNS data and access checks.

The experimental integration still compares copied credentials during account
linking and session validation. Do not delete the original credentials until a
separate, audited migration replaces that comparison with a durable identity
link and all account recovery, password change and Vault flows are complete.

The optional `AUTH_AUTHORITY_MODE=flaxia-auth` setting rejects legacy Flaxia
sessions and disables local registration, login and verifier upgrades. It does
not migrate accounts or enable the new login UI. Keep it unset until all
accounts are linked, all supported clients use Auth, recovery and registration
work, and the operational rollback plan has been verified.

Logging out of an Auth-backed Flaxia session revokes that application's grant.
The Auth session and other application grants remain valid. If Auth cannot
revoke the grant, logout returns 503 and keeps the local session and cookie so
the caller can retry. This requires Auth's service binding with the revoke
endpoint to be deployed before this version of Flaxia.
