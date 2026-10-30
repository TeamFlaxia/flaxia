> Cutover status: production enabled `AUTH_AUTHORITY_MODE=flaxia-auth` on
> 2026-10-30 after replacing Auth D1 with a verified full copy of the Flaxia
> users and bulk-linking every profile. Recovery-code enrollment is collected
> on first Auth login. A rollback must preserve Auth as the credential
> authority; do not restore a Worker that accepts linked local credentials.

# Authentication authority transition

Flaxia Auth is the target authority for credentials, authentication and
grant revocation. Flaxia remains responsible for local account availability,
roles, SNS data and access checks.

Initial linking verifies that the existing Flaxia and Auth credentials match.
Once linked in authority mode, Flaxia removes its password verifier, legacy
hash, SRP handshakes, session records and provisioning snapshot atomically.
The browser holds an opaque Auth grant and Flaxia checks that grant with Auth
for every request. The Auth ID is linked to the SNS profile; matching names or
email addresses alone never link two existing accounts. A new Auth identity
can create a profile only if the chosen username and email are available.

The optional `AUTH_AUTHORITY_MODE=flaxia-auth` setting rejects legacy Flaxia
sessions and disables local registration, login and verifier upgrades. It enables
the Auth login and registration UI and
migrates a linked account at its next Auth exchange. Keep it unset in any environment until all existing users have a working
link, supported clients use Auth, and the rollback plan and independent
security review are complete. Purging local verifiers cannot be rolled back simply by disabling
the setting.

Password changes use an Auth-side prepared verifier and an application-side
record containing only the encrypted Vault rewrap and an operation hash. Email
changes reserve the application profile address, update Auth after SRP proof,
and reconcile the profile from Auth's receipt. Recovery retries retain neither
the SRP proof nor an Auth grant in Flaxia's database. An independent random
account recovery code can authenticate with SRP and reset the password; the
Vault recovery phrase separately decrypts and rewraps the Vault key in the
browser. Neither secret is sent to a server. Existing users must enroll an
account recovery code while they still have their password. Enrollment is
available from Settings and after an Auth login as soon as the profile is
linked, including the opt-in phase before `AUTH_AUTHORITY_MODE` is enabled.
Accounts whose old credentials do not match remain blocked pending a verified
linking path.

Account deletion records only an operation hash and user ID in the application
database. Auth records a hashed receipt, and browser retries or the scheduled
backend worker complete application-data deletion after an interrupted call.
Admin moderation uses the bridge's `/api/flaxia/admin/account` action: freeze,
unfreeze and delete land at Auth first, and a linked profile is removed locally
only after Auth has deleted the identity. The backend Worker must have the
`FlaxiaBridge` service binding before rollout.
Legacy credential fingerprints are discarded when linking completes, on
credential change or deletion, and no later than 90 days after creation; see
`flaxia-auth/docs/flaxia-migration.md` for backup expiry and purge procedures.

Logging out of an Auth-backed Flaxia session revokes that application's grant.
The Auth session and other application grants remain valid. If Auth cannot
revoke the grant, logout returns 503 and keeps the local session and cookie so
the caller can retry. This requires Auth's service binding with the revoke
endpoint to be deployed before this version of Flaxia.

The optional SRP-protected `POST /api/auth/flaxia/provision` copies a local SRP account to Auth through the service binding. Flaxia records the exact request before contacting Auth; retries after a timeout reuse that snapshot, and Auth accepts identical retries while rejecting conflicts. Until a successful Auth exchange links and purges the profile, password changes and account deletion return 409; database triggers enforce this during races. Once linked, direct Auth recovery, password change, email change and deletion flows are available. Provisioning still cannot resolve an existing Auth identity conflict or an expired/missing local credential proof. Those cases require a separately verified migration path and remain a rollout blocker.
