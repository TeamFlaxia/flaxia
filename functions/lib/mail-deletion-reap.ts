// Retries account deletions that could not reach the Mail Worker during the
// original request (docs/mail.md §11.3). Runs from the scheduled backend
// worker, which holds the MAIL_SERVICE binding.
import { deleteMailAccount, type MailServiceEnv } from './mail-service.ts';

type ReapEnv = MailServiceEnv & { DB: D1Database };

export async function reapMailDeletions(env: ReapEnv): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT user_id FROM mail_deletion_outbox
     WHERE last_checked < strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')
     ORDER BY last_checked
     LIMIT 20`,
  ).all<{ user_id: string }>();

  let completed = 0;
  for (const row of rows.results ?? []) {
    if (await deleteMailAccount(env, row.user_id)) {
      await env.DB.prepare('DELETE FROM mail_deletion_outbox WHERE user_id = ?').bind(row.user_id).run();
      completed += 1;
    } else {
      await env.DB.prepare(
        `UPDATE mail_deletion_outbox
         SET attempts = attempts + 1,
             last_checked = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE user_id = ?`,
      )
        .bind(row.user_id)
        .run();
    }
  }
  return completed;
}
