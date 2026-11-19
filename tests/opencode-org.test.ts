import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectGrantedOrg } from '../src/lib/auth-connections.ts';

const alpha = { id: 'org_a', name: 'Alpha' };
const beta = { id: 'org_b', name: 'Beta' };
const orgs = [alpha, beta];

test('an org-scoped grant selects the bound workspace', () => {
  assert.deepEqual(selectGrantedOrg(orgs, 'org_b'), beta);
});

test('an unscoped grant auto-selects a single workspace', () => {
  assert.deepEqual(selectGrantedOrg([alpha], null), alpha);
  assert.deepEqual(selectGrantedOrg([alpha], undefined), alpha);
  assert.equal(selectGrantedOrg(orgs, null), null);
});

test('a granted org missing from the list defers to the caller', () => {
  assert.equal(selectGrantedOrg(orgs, 'org_missing'), null);
  assert.equal(selectGrantedOrg([], 'org_a'), null);
  assert.equal(selectGrantedOrg([], null), null);
});
