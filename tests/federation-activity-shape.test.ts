// A JSON-LD `@context` may be a string or an array. The differential suite
// compares protocol-visible shape, not this representation detail, so both
// forms must produce the same comparison shape.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activityShape, diffShapes } from './federation/diff.ts';

describe('federation activityShape', () => {
  const activity = (context: string | string[]) => ({
    '@context': context,
    id: 'https://flaxia.test/api/activities/delete/1',
    type: 'Delete',
    actor: 'https://flaxia.test/api/actors/alice',
    object: {
      id: 'https://flaxia.test/api/notes/1',
      type: 'Tombstone',
    },
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [],
  });

  it('ignores the @context representation when comparing Delete activities', () => {
    assert.deepEqual(
      activityShape(activity('https://www.w3.org/ns/activitystreams')),
      activityShape(activity(['https://www.w3.org/ns/activitystreams'])),
    );
    assert.deepEqual(
      diffShapes(
        activityShape(activity('https://www.w3.org/ns/activitystreams')),
        activityShape(activity(['https://www.w3.org/ns/activitystreams'])),
      ),
      [],
    );
  });

  it('still detects a real audience difference', () => {
    const differences = diffShapes(
      activityShape(activity(['https://www.w3.org/ns/activitystreams'])),
      activityShape({ ...activity(['https://www.w3.org/ns/activitystreams']), to: [] }),
    );
    assert.ok(differences.length > 0, 'audience differences must still be reported');
    assert.ok(differences.some((entry) => entry.field === 'addressedToPublic' || entry.field === 'hasTo'));
  });
});
