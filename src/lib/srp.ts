// Single source of truth: shared/srp.ts.
// This entrypoint exists because the browser bundle and the Workers bundle
// have separate roots; both re-export the shared implementation.
export * from '../../shared/srp.ts';
