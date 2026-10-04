import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clamavVerdict, parseContainerOutput } from '../functions/lib/scan/container-result.ts';

describe('parseContainerOutput', () => {
  it('rejects empty-string exitCode instead of reading CLEAN (#96)', () => {
    assert.equal(parseContainerOutput({ stdout: '', stderr: '', exitCode: '' }), null);
    assert.equal(parseContainerOutput({ stdout: '', stderr: '', exitCode: '   ' }), null);
  });

  it('rejects missing and non-numeric exitCode', () => {
    assert.equal(parseContainerOutput({ stdout: '', stderr: '' }), null);
    assert.equal(parseContainerOutput({ stdout: '', stderr: '', exitCode: 'clean' }), null);
    assert.equal(parseContainerOutput({ stdout: '', stderr: '', exitCode: 0.5 }), null);
    assert.equal(parseContainerOutput(null), null);
  });

  it('accepts numbers and numeric strings', () => {
    assert.deepEqual(parseContainerOutput({ stdout: '', stderr: '', exitCode: 0 }), {
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
    assert.deepEqual(parseContainerOutput({ stdout: 'x', stderr: '', exitCode: '1' }), {
      stdout: 'x',
      stderr: '',
      exitCode: 1,
    });
  });

  it('classifies clamav verdicts', () => {
    assert.equal(clamavVerdict({ stdout: '', stderr: '', exitCode: 0 }).status, 'clean');
    assert.equal(clamavVerdict({ stdout: 'f: Eicar FOUND', stderr: '', exitCode: 1 }).status, 'infected');
    assert.equal(clamavVerdict({ stdout: '', stderr: 'boom', exitCode: 2 }).status, 'failed');
  });
});
