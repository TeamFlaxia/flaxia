import assert from 'node:assert';
import { describe, it } from 'node:test';
import { type NudeNetDetection, resolveNsfwTags } from '@flaxia/sdk';

function det(label: string, score: number): NudeNetDetection {
  return { label, score, box: [0, 0, 10, 10] };
}

describe('resolveNsfwTags', () => {
  it('returns no tags for empty/undefined detections', () => {
    assert.deepEqual(resolveNsfwTags(undefined), { nsfw: false, tags: [] });
    assert.deepEqual(resolveNsfwTags([]), { nsfw: false, tags: [] });
  });

  it('flags EXPLICIT labels above threshold as NSFW and adds #nsfw', () => {
    const res = resolveNsfwTags([det('FEMALE_GENITALIA_EXPOSED', 0.98)]);
    assert.equal(res.nsfw, true);
    assert.ok(res.tags.includes('nsfw'));
    assert.ok(res.tags.includes('exposed_genital'));
  });

  it('flags MALE_GENITALIA_EXPOSED and ANUS_EXPOSED as NSFW', () => {
    assert.equal(resolveNsfwTags([det('MALE_GENITALIA_EXPOSED', 0.9)]).nsfw, true);
    assert.equal(resolveNsfwTags([det('ANUS_EXPOSED', 0.9)]).nsfw, true);
  });

  it('adds partial element tags for exposed breasts/buttocks', () => {
    const res = resolveNsfwTags([det('FEMALE_BREAST_EXPOSED', 0.7)]);
    assert.equal(res.nsfw, false);
    assert.ok(!res.tags.includes('nsfw'));
    assert.ok(res.tags.includes('exposed_breast'));

    const res2 = resolveNsfwTags([det('BUTTOCKS_EXPOSED', 0.7)]);
    assert.ok(res2.tags.includes('exposed_buttocks'));
  });

  it('ignores covered labels and low-confidence detections', () => {
    const res = resolveNsfwTags([
      det('FEET_EXPOSED', 0.99),
      det('FEMALE_BREAST_COVERED', 0.99),
      det('FEMALE_GENITALIA_EXPOSED', 0.2),
    ]);
    assert.deepEqual(res, { nsfw: false, tags: [] });
  });

  it('deduplicates element tags across labels', () => {
    const res = resolveNsfwTags([det('FEMALE_GENITALIA_EXPOSED', 0.9), det('MALE_GENITALIA_EXPOSED', 0.8)]);
    assert.equal(res.tags.filter((t) => t === 'exposed_genital').length, 1);
    assert.equal(res.tags.includes('nsfw'), true);
  });
});
