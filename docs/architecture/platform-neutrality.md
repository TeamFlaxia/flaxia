# ADR: Platform neutrality through Ports and an Adapter

- Status: Accepted
- Date: 2026-11-19
- Related: `TODO.md` (A0/A1), `docs/architecture.md`

## Context

Flaxia runs on Cloudflare Pages and Workers today. That is the deployment
target, not the product architecture. Feature code currently reaches for
Cloudflare bindings directly (`c.env.DB`, `D1Database`, `R2Bucket`,
`KVNamespace`, Durable Objects, Vectorize, Queues), which makes the code hard to
reason about, hard to test, and expensive to move later.

The goal of this decision is **code organization**: make the boundary explicit
and keep new Cloudflare dependencies from spreading. A provider swap or a
separate repository is *possible* later, but neither is part of this decision.

## Decision

1. Feature code depends only on the ports in `functions/lib/ports/`:
   - `Db` (D1-shaped: `prepare` / `bind` / `all` / `first` / `run` / `batch`)
   - `Kv`
   - `BlobStore`
   - `Queue`
   - `Realtime`
   - `Vector`
   - `Tasks` (an abstraction over `waitUntil`)
2. The only code allowed to know about Cloudflare binding types is:
   - `functions/lib/adapters/cloudflare/**` (the adapter)
   - `functions/api/types.ts` (the environment type)
   - composition roots that receive the real bindings: `functions/api/[[route]].ts`,
     `functions/queue-worker.ts`, `src/sandbox-worker.ts`
   - generated artifacts (`*.generated.ts`, `*.d.ts`, `worker-configuration.d.ts`)
   - other independently deployed runtimes (`mail-worker/`, `do-worker/`,
     `multiplayer-worker/`)
3. Port definitions mirror today's binding shapes so the first migration is a
   pure adapter change with no behaviour change.
4. A CI guardrail fails on **new** occurrences of Cloudflare types or `c.env`
   outside the allowed paths. Existing occurrences are recorded in
   `tests/architecture-baseline.json`; the baseline may shrink but must not grow.

## Consequences

- `createCloudflareServices(env, ctx)` is the single conversion point.
- Tests can pass plain objects that implement the ports; no Cloudflare runtime
  is required for unit tests.
- Moving a feature to another provider (or another repository) becomes a matter
  of implementing the same ports.
- The baseline is intentionally ugly at first. It is a ratchet, not an
  endorsement: every PR may remove entries, none may add them.

## Non-goals

- A Node adapter (see the self-host notes in `TODO.md`).
- Dual-running Cloudflare and a self-hosted stack.
- Replacing Durable Objects, Vectorize, or Queues.
- Splitting the repository. The ports make that feasible later; they are not a
  commitment to do it.
