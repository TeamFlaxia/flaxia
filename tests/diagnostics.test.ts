import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearDiagnostics, getDiagnostics, logEvent } from '../src/lib/diagnostics.ts';

test('events are captured in order with their fields', () => {
  clearDiagnostics();
  logEvent('offline-fetch', 'probe_failed', { probeFailures: 3 });
  logEvent('offline-fetch', 'probe_recovered');
  const events = getDiagnostics();
  assert.equal(events.length, 2);
  assert.equal(events[0].component, 'offline-fetch');
  assert.equal(events[0].event, 'probe_failed');
  assert.equal(events[0].fields?.probeFailures, 3);
  assert.equal(events[1].event, 'probe_recovered');
  assert.ok(events[1].at >= events[0].at);
});

test('the ring buffer is bounded', () => {
  clearDiagnostics();
  for (let i = 0; i < 250; i++) logEvent('test', `evt-${i}`);
  const events = getDiagnostics();
  assert.equal(events.length, 200);
  assert.equal(events[0].event, 'evt-50');
  assert.equal(events[199].event, 'evt-249');
});

test('getDiagnostics returns a copy', () => {
  clearDiagnostics();
  logEvent('test', 'one');
  const snapshot = getDiagnostics();
  snapshot.length = 0;
  assert.equal(getDiagnostics().length, 1);
});
