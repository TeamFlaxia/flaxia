import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  type BlocklistEntry,
  matchBlocklistEntries,
  matchSignatureEntry,
  PHASH_MAX_DISTANCE,
  validateBlocklistEntry,
} from '../functions/lib/scan/blocklist.ts';
import type { FileFeatures } from '../functions/lib/scan/features.ts';

function entry(kind: BlocklistEntry['kind'], value: string): BlocklistEntry {
  return { id: 1, kind, value, signature: null, reason: null };
}

function features(partial: Partial<FileFeatures> & { sha256: string }): FileFeatures {
  return { kind: 'other', ...partial };
}

describe('matchBlocklistEntries', () => {
  const sha = 'a'.repeat(64);
  const structureHash = 'b'.repeat(64);
  const textHash = 'c'.repeat(64);

  it('matches sha256 case-insensitively', () => {
    const found = matchBlocklistEntries(features({ sha256: sha.toUpperCase() }), [entry('sha256', sha)]);
    assert.ok(found);
    assert.equal(matchBlocklistEntries(features({ sha256: sha }), [entry('sha256', 'd'.repeat(64))]), null);
    assert.equal(matchBlocklistEntries(features({ sha256: sha }), []), null);
  });

  it('only matches structure/text hashes when the file carries them', () => {
    const withStructure = features({ sha256: sha, structureHash });
    assert.ok(matchBlocklistEntries(withStructure, [entry('structure_hash', structureHash)]));
    assert.equal(matchBlocklistEntries(features({ sha256: sha }), [entry('structure_hash', structureHash)]), null);

    const withText = features({ sha256: sha, textHash });
    assert.ok(matchBlocklistEntries(withText, [entry('text_hash', textHash)]));
    assert.equal(matchBlocklistEntries(features({ sha256: sha }), [entry('text_hash', textHash)]), null);
  });

  it('never matches a different entry kind', () => {
    const mixed = features({ sha256: sha, structureHash, textHash });
    assert.equal(matchBlocklistEntries(mixed, [entry('text_hash', structureHash)]), null);
    assert.equal(matchBlocklistEntries(mixed, [entry('structure_hash', textHash)]), null);
  });

  it('matches phash entries at the threshold boundary', () => {
    assert.equal(PHASH_MAX_DISTANCE, 8);
    const target = 'ffffffffffffffff';
    const atThreshold = 'ffffffffffffff00'; // last byte: 8 bits flipped
    const beyond = 'fffffffffffffe00'; // 9 bits flipped

    const base = features({ sha256: sha, phash: target });
    assert.ok(matchBlocklistEntries(base, [entry('phash', atThreshold)]), 'distance 8 must match');
    assert.equal(matchBlocklistEntries(base, [entry('phash', beyond)]), null, 'distance 9 must not match');
  });

  it('matches any keyframe hash in a multi-hash video result', () => {
    const multi = features({
      sha256: sha,
      phash: '0000000000000000,ffffffffffffffff,1111111111111111',
    });
    assert.ok(matchBlocklistEntries(multi, [entry('phash', 'ffffffffffffff00')]));
    assert.equal(matchBlocklistEntries(multi, [entry('phash', '2222222222222222')]), null);
  });

  it('skips malformed phash entries instead of throwing', () => {
    const withHash = features({ sha256: sha, phash: 'ffffffffffffffff' });
    assert.equal(matchBlocklistEntries(withHash, [entry('phash', 'not-a-hash')]), null);
  });

  it('ignores reserved signature entries during sync matching', () => {
    const found = matchBlocklistEntries(features({ sha256: sha }), [entry('signature', 'Win.Trojan.Test')]);
    assert.equal(found, null);
  });
});

describe('matchSignatureEntry', () => {
  const entries: BlocklistEntry[] = [
    { id: 1, kind: 'sha256', value: 'a'.repeat(64), signature: null, reason: null },
    { id: 2, kind: 'signature', value: 'Trojan.Win32', signature: null, reason: 'family block' },
  ];

  it('matches a signature entry as a case-insensitive substring of the verdict', () => {
    assert.equal(matchSignatureEntry('Win.Trojan.Win32.Agent-123', entries)?.id, 2);
    assert.equal(matchSignatureEntry('Eicar-Test-Signature', entries), null);
  });

  it('never matches non-signature entries and tolerates a null verdict', () => {
    assert.equal(matchSignatureEntry(null, entries), null);
    assert.equal(matchSignatureEntry('aaaaaaaa', entries), null);
  });
});

describe('validateBlocklistEntry', () => {
  it('accepts and normalizes valid entries', () => {
    const sha = 'ABCDEF0123456789'.repeat(4); // 64 hex chars
    assert.deepEqual(validateBlocklistEntry('sha256', sha.toUpperCase()), { kind: 'sha256', value: sha.toLowerCase() });
    assert.deepEqual(validateBlocklistEntry('structure_hash', 'a'.repeat(64)), {
      kind: 'structure_hash',
      value: 'a'.repeat(64),
    });
    assert.deepEqual(validateBlocklistEntry('phash', 'ABCDEF0123456789'), {
      kind: 'phash',
      value: 'abcdef0123456789',
    });
    assert.deepEqual(validateBlocklistEntry('signature', 'Eicar-Test-Signature'), {
      kind: 'signature',
      value: 'Eicar-Test-Signature',
    });
  });

  it('rejects malformed entries', () => {
    assert.ok('error' in validateBlocklistEntry('nope', 'a'.repeat(64)));
    assert.ok('error' in validateBlocklistEntry('sha256', 'a'.repeat(63)));
    assert.ok('error' in validateBlocklistEntry('sha256', 'zz'.repeat(32)));
    assert.ok('error' in validateBlocklistEntry('phash', 'abc'));
    assert.ok('error' in validateBlocklistEntry('phash', 'a'.repeat(17)));
    assert.ok('error' in validateBlocklistEntry('signature', 'x'.repeat(201)));
    assert.ok('error' in validateBlocklistEntry('sha256', ''));
    assert.ok('error' in validateBlocklistEntry('sha256', 42));
    assert.ok('error' in validateBlocklistEntry(undefined, 'a'.repeat(64)));
  });
});
