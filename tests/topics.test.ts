import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregateTopicTags, extractTopicTags, topicAffinity } from '../functions/lib/topics.ts';

describe('automatic topic tagging', () => {
  it('unifies Japanese and English topic signals without hashtags', () => {
    assert.ok(extractTopicTags('Godotでゲームを制作しています').includes('ゲーム'));
    assert.ok(extractTopicTags('Building a new game in Godot').includes('ゲーム'));
    assert.ok(extractTopicTags('ＴｙｐｅＳｃｒｉｐｔで開発').includes('プログラミング'));
  });

  it('supports multiple topics and preserves normalized custom tags', () => {
    const tags = extractTopicTags('AIで音楽を作曲', '["CustomTag","customtag","AI"]');
    assert.deepEqual(new Set(tags), new Set(['customtag', 'ai', '音楽']));
  });

  it('ignores URL/mention keywords, substrings and malformed historical tags', () => {
    assert.deepEqual(extractTopicTags('chair gameplay https://example.com/gaming @music', 'broken'), []);
    assert.deepEqual(extractTopicTags('hello', '[42,null,"<script>"]'), []);
    assert.deepEqual(extractTopicTags('ordinary text', '{}'), []);
  });

  it('counts each post once per topic with actual sample percentages', () => {
    const tags = aggregateTopicTags([
      { id: 'a', text: 'ゲーム game gaming', hashtags: '["ゲーム","ゲーム"]' },
      { id: 'b', text: 'music', hashtags: '[]' },
      { id: 'c', text: 'another game', hashtags: '[]' },
    ]);
    assert.deepEqual(
      tags.find((tag) => tag.tag === 'ゲーム'),
      { tag: 'ゲーム', count: 2, percentage: 66.7 },
    );
    assert.deepEqual(aggregateTopicTags([]), []);
  });

  it('ranks matching topics higher and does not reward unrelated tag stuffing', () => {
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
