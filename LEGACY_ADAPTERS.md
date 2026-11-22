# Legacy DOM adapters (shrinking list)

These Svelte entrypoints still mount legacy DOM factories. Entries may only be
**removed** from this list — never added. When a component is rewritten in
Svelte, delete its line in the same PR. `tests/legacy-adapters.test.ts` enforces
this ratchet.

