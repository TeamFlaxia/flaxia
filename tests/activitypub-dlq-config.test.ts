import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('ActivityPub consumer quarantines poison messages after bounded retries', () => {
  const toml = readFileSync(new URL('../wrangler.worker.toml', import.meta.url), 'utf8');
  const consumers = toml.split('[[queues.consumers]]').slice(1);
  assert.ok(consumers.length >= 1, 'ActivityPub consumer must be configured');
  const consumer = consumers[0];
  assert.match(consumer, /queue\s*=\s*"activitypub-delivery"/);
  assert.match(consumer, /max_retries\s*=\s*3\b/);
  assert.match(consumer, /dead_letter_queue\s*=\s*"activitypub-delivery-dlq"/);
});

test('the dead-letter queue has its own bounded consumer that persists to D1', () => {
  const toml = readFileSync(new URL('../wrangler.worker.toml', import.meta.url), 'utf8');
  const consumers = toml.split('[[queues.consumers]]').slice(1);
  assert.equal(consumers.length, 2, 'the DLQ must have a consumer of its own');

  const dlq = consumers[1];
  assert.match(dlq, /queue\s*=\s*"activitypub-delivery-dlq"/);
  assert.match(dlq, /max_retries\s*=\s*1\b/, 'a bounded retry avoids an infinite DLQ loop');
  assert.doesNotMatch(dlq, /dead_letter_queue/, 'a dead letter must not be handed off again');
});

test('deploy provisions the DLQ and never overrides the Worker compatibility date', () => {
  const toml = readFileSync(new URL('../wrangler.worker.toml', import.meta.url), 'utf8');
  assert.match(toml, /compatibility_date\s*=\s*"2026-06-02"/);

  const deploy = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(deploy, /node scripts\/ensure-activitypub-dlq\.mjs/);
  assert.doesNotMatch(deploy, /--compatibility-date/);

  const script = readFileSync(new URL('../scripts/ensure-activitypub-dlq.mjs', import.meta.url), 'utf8');
  const listCalls = script.match(/\?name=\$\{queueName\}/g) ?? [];
  assert.ok(listCalls.length >= 2, 'the queue is listed before and after creation');
});
