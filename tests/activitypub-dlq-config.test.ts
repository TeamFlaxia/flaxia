import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('ActivityPub consumer quarantines poison messages after bounded retries', () => {
  const toml = readFileSync(new URL('../wrangler.toml.worker', import.meta.url), 'utf8');
  const consumer = toml.split('[[queues.consumers]]')[1];
  assert.ok(consumer, 'ActivityPub consumer must be configured');
  assert.match(consumer, /queue\s*=\s*"activitypub-delivery"/);
  assert.match(consumer, /max_retries\s*=\s*3\b/);
  assert.match(consumer, /dead_letter_queue\s*=\s*"activitypub-delivery-dlq"/);
});
