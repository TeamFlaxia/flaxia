// The Crowd node bundle must stay same-origin and versioned. A regression to
// an external CDN or the deleted /api/crowd asset proxy would reintroduce the
// npm/unpkg runtime dependency.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crowdNodeEntry } from '../src/lib/crowd-node.ts';

describe('crowd node entry path', () => {
  it('serves the pinned bundle same-origin under /crowd', () => {
    assert.equal(crowdNodeEntry('0.11.1'), '/crowd/v0.11.1-0/index.js');
    assert.ok(!crowdNodeEntry().includes('/api/crowd'));
    assert.ok(!crowdNodeEntry().includes('unpkg.com'));
  });
});
