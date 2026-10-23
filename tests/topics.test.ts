import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aggregateTopicTags,
  classifyTopicVector,
  parseTopicVector,
  postTopicTags,
  TOPIC_DEFINITIONS,
  TOPIC_DIMENSIONS,
  topicAffinity,
} from '../functions/lib/topics.ts';

function vector(index: number): number[] {
  const values = Array<number>(TOPIC_DIMENSIONS).fill(0);
  values[index] = 1;
  return values;
}
const prototypes = TOPIC_DEFINITIONS.map((topic, index) => ({ tag: topic.tag, vector: vector(index) }));

describe('semantic topic classification', () => {
  it('assigns a label by vector meaning without checking text or keywords', () => {
    assert.deepEqual(classifyTopicVector(vector(0), prototypes), ['ゲーム']);
    assert.deepEqual(classifyTopicVector(vector(3), prototypes), ['音楽']);
  });

  it('supports multiple similarly strong topic matches, at most three', () => {
    const mixed = vector(0);
    mixed[3] = 1;
    assert.deepEqual(classifyTopicVector(mixed, prototypes), ['ゲーム', '音楽']);
  });

  it('does not guess from incomplete prototypes, miscellaneous or low-similarity vectors', () => {
    assert.deepEqual(classifyTopicVector(vector(0), prototypes.slice(0, 1)), []);
    assert.deepEqual(classifyTopicVector(vector(12), prototypes), []);
    assert.deepEqual(classifyTopicVector(vector(30), prototypes), []);
  });

  it('rejects nonfinite, zero, malformed and dimension-mismatched output', () => {
    assert.equal(parseTopicVector([1, 0]), null);
    assert.equal(parseTopicVector(Array(TOPIC_DIMENSIONS).fill(0)), null);
    const invalid = vector(0);
    invalid[5] = NaN;
    assert.equal(parseTopicVector(invalid), null);
    assert.equal(parseTopicVector({ vector: vector(0) }), null);
  });

  it('merges saved AI labels and normalized custom hashtags without reading text', () => {
    assert.deepEqual(
      new Set(postTopicTags({ hashtags: '["CustomTag","customtag"]', auto_topic_tags: '["ゲーム"]' })),
      new Set(['customtag', 'ゲーム']),
    );
    assert.deepEqual(postTopicTags({ hashtags: 'broken', auto_topic_tags: '[null,42,"<script>"]' }), []);
    assert.deepEqual(postTopicTags({ hashtags: '[]' }), []);
  });

  it('counts posts once and calculates percentages from the actual sample', () => {
    const tags = aggregateTopicTags([
      { id: 'a', text: 'no keyword', hashtags: '["ゲーム"]', auto_topic_tags: '["ゲーム"]' },
      { id: 'b', text: 'no keyword', hashtags: '[]', auto_topic_tags: '["音楽"]' },
      { id: 'c', text: 'no keyword', hashtags: '[]', auto_topic_tags: '["ゲーム"]' },
    ]);
    assert.deepEqual(
      tags.find((tag) => tag.tag === 'ゲーム'),
      { tag: 'ゲーム', count: 2, percentage: 66.7 },
    );
    assert.deepEqual(aggregateTopicTags([]), []);
  });

  it('ranks matching topics higher without rewarding unrelated tag stuffing', () => {
    const interests = new Map([
      ['ゲーム', 3],
      ['音楽', 1],
    ]);
    assert.equal(topicAffinity(['ゲーム'], interests), 1);
    assert.equal(topicAffinity(['音楽'], interests), 1 / 3);
    assert.equal(topicAffinity(['ゲーム', '料理', '写真'], interests), 1);
    assert.equal(topicAffinity(['料理'], interests), 0);
    assert.equal(topicAffinity(['ゲーム'], new Map()), 0);
  });
});
