import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import {
  getPriority,
  getThreshold,
  insertAdminAlert,
  insertNotification,
  type ReportCategory,
  requireAuth,
} from '../helpers';
import type { Bindings, Variables } from '../types';

const report = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// POST /api/report - unified report endpoint (protected)
report.post('/report', requireAuth, async (c) => {
  try {
    const userId = c.get('user')?.id || '';
    const { post_id, category, dmca } = (await c.req.json()) as {
      post_id: string;
      category: ReportCategory;
      dmca?: {
        work_description: string;
        reporter_email: string;
        sworn: boolean;
      };
    };

    if (!post_id) {
      return c.json({ error: 'post_id is required' }, 400);
    }

    // Validate category
    const validCategories: ReportCategory[] = [
      'spam',
      'harassment',
      'inappropriate',
      'misinformation',
      'other',
      'hate_speech',
      'copyright',
      'csam',
      'malware',
      'privacy',
      'nsfw_untagged',
    ];
    if (!category || !validCategories.includes(category)) {
      return c.json({ error: 'Invalid category' }, 400);
    }

    // DMCA validation
    if (category === 'copyright') {
      if (!dmca) {
        return c.json({ error: 'DMCA information required for copyright reports' }, 400);
      }
      if (!dmca.sworn) {
        return c.json({ error: 'You must swear that this report is made in good faith' }, 400);
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(dmca.reporter_email)) {
        return c.json({ error: 'Invalid email format' }, 400);
      }
    }

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Get the post
    const post = (await c.env.DB.prepare('SELECT id, user_id FROM posts WHERE id = ? AND hidden = 0')
      .bind(post_id)
      .first()) as { id: string; user_id: string } | null;

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    // Cannot report own post
    if (post.user_id === userId) {
      return c.json({ error: 'Cannot report own post' }, 403);
    }

    // Check for duplicate report
    const existingReport = await c.env.DB.prepare('SELECT id FROM reports WHERE post_id = ? AND user_id = ?')
      .bind(post_id, userId)
      .first();

    if (existingReport) {
      return c.json({ error: 'Already reported' }, 409);
    }

    // Insert report with optional DMCA fields
    const reportId = nanoid();
    if (dmca && category === 'copyright') {
      await c.env.DB.prepare(
        'INSERT INTO reports (id, post_id, user_id, category, dmca_work_description, dmca_reporter_email, dmca_sworn, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(
          reportId,
          post_id,
          userId,
          category,
          dmca.work_description,
          dmca.reporter_email,
          dmca.sworn ? 1 : 0,
          'pending',
        )
        .run();
    } else {
      await c.env.DB.prepare('INSERT INTO reports (id, post_id, user_id, category, status) VALUES (?, ?, ?, ?, ?)')
        .bind(reportId, post_id, userId, category, 'pending')
        .run();
    }

    // Process based on category
    if (category === 'csam' || category === 'malware') {
      // Immediate hide - no threshold check
      await c.env.DB.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(post_id).run();
      await insertNotification(c.env.DB, post.user_id, 'hidden', post_id);
      await insertAdminAlert(c.env.DB, post_id, category, 'critical');
    } else if (category === 'nsfw_untagged') {
      const threshold = getThreshold(category);
      const { count } = (await c.env.DB.prepare(
        'SELECT COUNT(*) as count FROM reports WHERE post_id = ? AND category = ?',
      )
        .bind(post_id, category)
        .first()) as { count: number };

      if (count >= threshold) {
        await c.env.DB.prepare('UPDATE reports SET status = ? WHERE post_id = ?').bind('warned', post_id).run();
        await insertNotification(c.env.DB, post.user_id, 'warned', post_id);

        // Add #nsfw tag to post if not already present (no hiding)
        const postRow = (await c.env.DB.prepare('SELECT hashtags FROM posts WHERE id = ?').bind(post_id).first()) as {
          hashtags: string;
        } | null;

        if (postRow) {
          const hashtags: string[] = JSON.parse(postRow.hashtags);
          if (!hashtags.some((t: string) => t.toLowerCase() === 'nsfw' || t.toLowerCase() === 'r18')) {
            hashtags.push('nsfw');
            await c.env.DB.prepare('UPDATE posts SET hashtags = ? WHERE id = ?')
              .bind(JSON.stringify(hashtags), post_id)
              .run();
          }
        }
      }
    } else {
      const threshold = getThreshold(category);
      const { count } = (await c.env.DB.prepare(
        'SELECT COUNT(*) as count FROM reports WHERE post_id = ? AND category = ?',
      )
        .bind(post_id, category)
        .first()) as { count: number };

      if (count >= threshold) {
        await c.env.DB.prepare('UPDATE reports SET status = ? WHERE post_id = ?').bind('warned', post_id).run();
        await insertNotification(c.env.DB, post.user_id, 'warned', post_id);

        // Also hide the post and send hidden notification when threshold is reached
        await c.env.DB.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(post_id).run();
        await insertNotification(c.env.DB, post.user_id, 'hidden', post_id);

        const priority = getPriority(category);
        await insertAdminAlert(c.env.DB, post_id, category, priority);
      }
    }

    return c.json({ success: true, report_id: reportId });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Report error:', error);
    return c.json({ error: 'Failed to report post', details: err.message || 'Unknown error' }, 500);
  }
});

export default report;
