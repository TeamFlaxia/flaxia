import { Hono } from 'hono';
import { getMeWithSession, getSessionToken } from '../../lib/auth';
import { sendPushToAll } from '../../lib/notify';
import { requireAuth } from '../helpers';
import type { Bindings, Variables } from '../types';

const polls = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// GET /api/polls/:postId - get a poll and its options
polls.get('/polls/:postId', async (c) => {
  try {
    const postId = c.req.param('postId');
    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);

    const poll = (await c.env.DB.prepare('SELECT * FROM polls WHERE post_id = ?').bind(postId).first()) as Record<
      string,
      unknown
    > | null;

    if (!poll) return c.json({ error: 'Poll not found' }, 404);

    const { results: options } = await c.env.DB.prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY rowid')
      .bind(poll.id)
      .all();

    let userVote: string | null = null;
    const token = getSessionToken(c.req.raw);
    const sessionData = token ? await getMeWithSession(c.env, token) : null;
    if (sessionData) {
      const vote = (await c.env.DB.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?')
        .bind(poll.id, sessionData.user.id)
        .first()) as { option_id: string } | null;
      if (vote) userVote = vote.option_id;
    }

    const now = new Date();
    const endsAt = (poll.ends_at as string | undefined) || null;
    const expired = endsAt ? new Date(endsAt) <= now : false;

    if (expired && !poll.ended_notified) {
      try {
        const post = (await c.env.DB.prepare('SELECT user_id FROM posts WHERE id = ?').bind(postId).first()) as {
          user_id: string;
        } | null;
        if (post) {
          await c.env.DB.prepare(
            'INSERT INTO notifications (id, user_id, type, post_id, actor_id) VALUES (?, ?, ?, ?, ?)',
          )
            .bind(crypto.randomUUID(), post.user_id, 'poll_ended', postId, '')
            .run();
          await sendPushToAll(c.env, post.user_id, 'poll_ended');
          await c.env.DB.prepare('UPDATE polls SET ended_notified = 1 WHERE id = ?')
            .bind(poll.id as string)
            .run();
        }
      } catch (e) {
        console.error('Failed to create poll ended notification:', e);
      }
    }

    return c.json({ poll, options, userVote, expired });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Get poll error:', error);
    return c.json({ error: 'Failed to get poll', details: err.message }, 500);
  }
});

// POST /api/polls/:pollId/vote - vote on a poll option (protected)
polls.post('/polls/:pollId/vote', requireAuth, async (c) => {
  try {
    const pollId = c.req.param('pollId');
    const userId = c.get('user')?.id;
    const { optionId } = await c.req.json();

    if (!c.env.DB) return c.json({ error: 'Database not available' }, 500);
    if (!optionId) return c.json({ error: 'optionId is required' }, 400);

    const poll = (await c.env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(pollId).first()) as Record<
      string,
      unknown
    > | null;

    if (!poll) return c.json({ error: 'Poll not found' }, 404);

    if (poll.ends_at && new Date(poll.ends_at as string) <= new Date()) {
      return c.json({ error: 'Poll has ended' }, 400);
    }

    const option = (await c.env.DB.prepare('SELECT * FROM poll_options WHERE id = ? AND poll_id = ?')
      .bind(optionId, pollId)
      .first()) as Record<string, unknown> | null;

    if (!option) return c.json({ error: 'Option not found' }, 404);

    const existingVote = (await c.env.DB.prepare('SELECT * FROM poll_votes WHERE poll_id = ? AND user_id = ?')
      .bind(pollId, userId)
      .first()) as Record<string, unknown> | null;

    if (existingVote) {
      if ((existingVote.option_id as string) === optionId) {
        return c.json({ error: 'Already voted for this option' }, 409);
      }
      // Change vote: batch all operations
      await c.env.DB.batch([
        c.env.DB.prepare('DELETE FROM poll_votes WHERE id = ?').bind(existingVote.id as string),
        c.env.DB.prepare('UPDATE poll_options SET votes_count = MAX(0, votes_count - 1) WHERE id = ?').bind(
          existingVote.option_id as string,
        ),
        c.env.DB.prepare('INSERT INTO poll_votes (id, poll_id, option_id, user_id) VALUES (?, ?, ?, ?)').bind(
          crypto.randomUUID(),
          pollId,
          optionId,
          userId,
        ),
        c.env.DB.prepare('UPDATE poll_options SET votes_count = votes_count + 1 WHERE id = ?').bind(optionId),
      ]);
    } else {
      await c.env.DB.batch([
        c.env.DB.prepare('INSERT INTO poll_votes (id, poll_id, option_id, user_id) VALUES (?, ?, ?, ?)').bind(
          crypto.randomUUID(),
          pollId,
          optionId,
          userId,
        ),
        c.env.DB.prepare('UPDATE poll_options SET votes_count = votes_count + 1 WHERE id = ?').bind(optionId),
      ]);
    }

    const { results: options } = await c.env.DB.prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY rowid')
      .bind(pollId)
      .all();

    return c.json({ options, userVote: optionId });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Vote error:', error);
    return c.json({ error: 'Failed to vote', details: err.message }, 500);
  }
});

export default polls;
