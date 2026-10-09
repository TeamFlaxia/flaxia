import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Bindings } from '../functions/api/types.ts';
import {
  consumeEmailVerificationToken,
  isEmailDeliveryConfigured,
  issueEmailVerification,
  sendVerificationEmail,
} from '../functions/lib/email-verification.ts';

function mailEnv(overrides: Partial<Bindings> = {}): Bindings {
  return {
    DB: {} as D1Database,
    DB_TEST: {} as D1Database,
    BUCKET: {} as R2Bucket,
    CACHE: {} as KVNamespace,
    SANDBOX_ORIGIN: 'https://sandbox.flaxia.app',
    BASE_URL: 'https://flaxia.app',
    ADMIN_USERNAMES: '',
    AP_DELIVERY_QUEUE: {} as Queue,
    CROWD_ORCHESTRATOR_URL: '',
    CROWD_API_KEY: '',
    CROWD_NODE_ORIGINS: '',
    CROWD_SCAN_FILE_SOURCES: '',
    CF_ACCESS_AUD: '',
    CF_TEAM_DOMAIN: '',
    ...overrides,
  };
}

describe('verification persistence ordering', () => {
  it('keeps an existing link when the replacement delivery fails', async () => {
    let databaseCalls = 0;
    const env = mailEnv({
      RESEND_API_KEY: 'test-api-key',
      DB: {
        batch: async () => {
          databaseCalls++;
          return [];
        },
      } as unknown as D1Database,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('provider failure', { status: 503 });
    try {
      assert.equal(
        await issueEmailVerification(env, {
          email: 'person@example.com',
          purpose: 'registration',
          userId: 'existing-user',
        }),
        false,
      );
      assert.equal(databaseCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not delete a link when the user update fails', async () => {
    const token = 'a'.repeat(43);
    const preparedStatements: string[] = [];
    let batchCalled = false;
    const env = mailEnv({
      DB: {
        prepare: (sql: string) => {
          preparedStatements.push(sql);
          return {
            bind: (..._values: unknown[]) => ({
              first: async () => ({ purpose: 'registration', user_id: 'user-1', candidate_email: 'a@example.com' }),
            }),
          };
        },
        batch: async () => {
          batchCalled = true;
          throw new Error('database update failed');
        },
      } as unknown as D1Database,
    });
    await assert.rejects(consumeEmailVerificationToken(env, token), /database update failed/);
    assert.equal(batchCalled, true);
    assert.match(preparedStatements[1], /^UPDATE users/);
    assert.match(preparedStatements[2], /^DELETE FROM email_verification_tokens/);
  });
});

describe('Resend verification mail transport', () => {
  it('requires a key outside the test mock and sends through Resend HTTPS', async () => {
    const env = mailEnv({ RESEND_API_KEY: 'test-api-key' });
    assert.equal(isEmailDeliveryConfigured(mailEnv()), false);
    assert.equal(isEmailDeliveryConfigured(env), true);

    const originalFetch = globalThis.fetch;
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response('{}', { status: 200 });
    };
    try {
      const sent = await sendVerificationEmail(
        env,
        'person@example.com',
        'registration',
        'https://flaxia.app/verify-email?token=opaque-test-token',
      );
      assert.equal(sent, true);
      assert.equal(requestUrl, 'https://api.resend.com/emails');
      assert.equal(new Headers(requestInit?.headers).get('Authorization'), 'Bearer test-api-key');
      const payload = JSON.parse(String(requestInit?.body)) as { to: string[]; text: string };
      assert.deepEqual(payload.to, ['person@example.com']);
      assert.match(payload.text, /メールアドレスを認証してください/);
      assert.match(payload.text, /opaque-test-token/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not report failed provider requests as sent', async () => {
    const env = mailEnv({ RESEND_API_KEY: 'test-api-key' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('provider failure', { status: 500 });
    try {
      assert.equal(
        await sendVerificationEmail(
          env,
          'person@example.com',
          'email_change',
          'https://flaxia.app/verify-email?token=x',
        ),
        false,
      );
      globalThis.fetch = async () => {
        throw new Error('network failure');
      };
      assert.equal(
        await sendVerificationEmail(
          env,
          'person@example.com',
          'email_change',
          'https://flaxia.app/verify-email?token=x',
        ),
        false,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
