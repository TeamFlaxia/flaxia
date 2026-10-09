# Email verification

New accounts are created without a session and must verify the registration address before login. Existing accounts are marked verified by migration `0103_email_verification.sql`. Email changes are staged separately: the current address remains active until the new address is confirmed.

## Resend production setup

1. Add and authenticate the sending domain in the [Resend dashboard](https://resend.com/domains). Use the DNS records Resend provides; delivery is not reliable until the domain reports verified.
2. Configure the sender address to use that authenticated domain. The default is `Flaxia <no-reply@flaxia.app>`; override it with `RESEND_FROM_EMAIL` if your verified sender differs.
3. Store the API key as a Cloudflare Pages secret (never in `wrangler.toml`):

   ```sh
   npx wrangler pages secret put RESEND_API_KEY --project-name flaxia
   ```

   The optional sender override can be set in the Pages environment or in local `.dev.vars`:

   ```text
   RESEND_FROM_EMAIL=Flaxia <no-reply@your-verified-domain.example>
   ```

4. Ensure the production `BASE_URL` is the fixed HTTPS origin (`https://flaxia.app`). Verification links are generated from this binding, not the incoming request Host header.

If the API key is absent, registration and email-change requests fail without changing the active address. If a provider request fails after registration was stored, the account stays unverified and the registration page offers a generic, rate-limited resend path. Resend requests return neutral guidance for unknown addresses and delivery failures alike, so they do not disclose whether an address has an account or claim that delivery succeeded.

## Local and test development

The integration server launched by `npm run dev:test` sets `ENVIRONMENT=test`. In that environment the Resend transport is mocked: verification links are held only in process memory, and the test-only `/api/test/email-verification-link` helper retrieves them. The helper is guarded by the test-environment binding, and the mock outbox is cleared by `/api/test/reset`. No provider key is needed for the test suite. Do not enable `ENVIRONMENT=test` in a deployed Pages environment.

For normal local development, set a valid `RESEND_API_KEY` in an untracked `.dev.vars` file. A loopback HTTP `BASE_URL` is permitted for local verification links; all non-loopback links require HTTPS. Never commit `.dev.vars` or provider credentials.
