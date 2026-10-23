import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  TOPIC_DEFINITIONS,
  TOPIC_DIMENSIONS,
  TOPIC_MODEL,
  TOPIC_VERSION,
  textSha,
} from '../../functions/lib/topics.ts';
import { BASE_URL } from './setup.ts';

// Synthetic embeddings test protocol, persistence and ranking. They do not
// measure the real model's semantic accuracy.
export function topicVector(index: number): number[] {
  const vector = Array<number>(TOPIC_DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

export async function topicCallback(
  params: Record<string, string>,
  vector: unknown,
  model = TOPIC_MODEL,
): Promise<Response> {
  const query = new URLSearchParams(params);
  query.sort();
  query.set('sig', createHmac('sha256', 'test-callback-secret').update(`/api/crowd/webhook?${query}`).digest('hex'));
  return fetch(`${BASE_URL}/api/crowd/webhook?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taskId: crypto.randomUUID(),
      status: 'done',
      result: { output: { vector, model, dimensions: TOPIC_DIMENSIONS } },
    }),
  });
}

export async function seedTopicPrototypes(): Promise<void> {
  const fixture = await fetch(`${BASE_URL}/api/test/topic-prototypes`, { method: 'POST' });
  assert.equal(fixture.status, 200);
  for (const [index, topic] of TOPIC_DEFINITIONS.entries()) {
    const response = await topicCallback(
      { type: 'topic-prototype', tag: topic.tag, version: TOPIC_VERSION, token: `test-prototype-${index}` },
      topicVector(index),
    );
    assert.equal(response.status, 200);
  }
}

export async function embedTopic(postId: string, text: string, index: number): Promise<void> {
  const response = await topicCallback({ type: 'vector-embed', postId, sha: await textSha(text) }, topicVector(index));
  assert.equal(response.status, 200);
}
