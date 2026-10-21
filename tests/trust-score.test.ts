import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  computeRepetitionScore,
  isNearDuplicateText,
  MIN_TRUST_SCORE,
  normalizePostText,
  RECOMMENDATION_MIN_TRUST,
  trustScoreFromRepetition,
} from '../functions/lib/trust.ts';

describe('normalizePostText', () => {
  it('normalizes width, case, punctuation, links, and tags', () => {
    assert.equal(normalizePostText('ＨＥＬＬＯ　ＷＯＲＬＤ！ #game @friend https://example.com'), 'helloworld');
  });

  it('returns an empty string for content with no comparable text', () => {
    assert.equal(normalizePostText('   #tag @mention https://example.com  '), '');
  });
});

describe('isNearDuplicateText', () => {
  it('matches identical text', () => {
    assert.equal(isNearDuplicateText('same post', 'same post'), true);
  });

  it('matches text that differs only by punctuation, tags, or links', () => {
    assert.equal(
      isNearDuplicateText('Check out this game now', 'Check out this game now!! #game https://example.com'),
      true,
    );
  });

  it('matches a small wording change', () => {
    assert.equal(
      isNearDuplicateText('今日のゲームを公開しました。ぜひ遊んでください', '今日のゲームを公開しました。ぜひ遊んでね'),
      true,
    );
  });

  it('does not match unrelated text', () => {
    assert.equal(isNearDuplicateText('今日はいい天気ですね', '明日は雨が降るでしょう'), false);
    assert.equal(isNearDuplicateText('I love this game', 'I hate this game'), false);
  });
});

describe('computeRepetitionScore', () => {
  it('returns 1 when every post repeats the same content', () => {
    assert.equal(computeRepetitionScore(['same', 'same', 'same']), 1);
  });

  it('ignores two repeated posts without further repetition', () => {
    assert.equal(computeRepetitionScore(['same', 'same', 'different', 'another post']), 0);
  });

  it('counts the share of posts that belong to a repeated cluster', () => {
    assert.equal(computeRepetitionScore(['same', 'same', 'same', 'unique one', 'unique two']), 3 / 5);
  });

  it('returns 0 for distinct posts', () => {
    assert.equal(computeRepetitionScore(['first', 'second', 'third', 'fourth']), 0);
  });

  it('ignores posts without comparable text', () => {
    assert.equal(computeRepetitionScore(['#one', '#two', '#three']), 0);
  });
});

describe('trustScoreFromRepetition', () => {
  it('keeps clean authors eligible for recommendations', () => {
    assert.equal(trustScoreFromRepetition(0), 1);
    assert.ok(trustScoreFromRepetition(0) >= RECOMMENDATION_MIN_TRUST);
  });

  it('drops repeat offenders below the recommendation threshold', () => {
    assert.ok(trustScoreFromRepetition(1) < RECOMMENDATION_MIN_TRUST);
    assert.equal(trustScoreFromRepetition(1), MIN_TRUST_SCORE);
  });

  it('clamps out-of-range input', () => {
    assert.equal(trustScoreFromRepetition(-1), 1);
    assert.equal(trustScoreFromRepetition(2), MIN_TRUST_SCORE);
  });
});
