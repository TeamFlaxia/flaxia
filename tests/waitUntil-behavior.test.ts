// Behavioral checks for the post-response scheduler: the task must still run
// when there is no Cloudflare ExecutionContext, and must be handed to one when
// present so it survives the response.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitUntil } from '../functions/lib/background-task.ts';

test('waitUntil runs the task without an execution context', async () => {
  let ran = false;
  waitUntil(
    {},
    async () => {
      ran = true;
    },
    'test',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, true);
});

test('waitUntil hands the task to the execution context', async () => {
  let handed: Promise<unknown> | null = null;
  const c = { executionCtx: { waitUntil: (p: Promise<unknown>) => (handed = p) } };
  let ran = false;
  waitUntil(
    c,
    async () => {
      ran = true;
    },
    'test',
  );
  assert.ok(handed, 'executionCtx.waitUntil must receive the task');
  await handed;
  assert.equal(ran, true);
});

test('waitUntil swallows task rejection so the request is unaffected', async () => {
  const original = console.error;
  const errors: unknown[] = [];
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    waitUntil(
      {},
      async () => {
        throw new Error('boom');
      },
      'labeled-task',
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
  } finally {
    console.error = original;
  }
});
