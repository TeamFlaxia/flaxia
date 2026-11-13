import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeSubject, parseInboundEmail } from '../mail-worker/src/parse.ts';

function raw(headers: string[], body: string): ArrayBuffer {
  return new TextEncoder().encode(`${headers.join('\r\n')}\r\n\r\n${body}`).buffer;
}

function multipart(attachment: { filename: string; contentType: string; base64: string }): string {
  return [
    '--boundary',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Hello <strong>world</strong></p>',
    '--boundary',
    `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    attachment.base64,
    '--boundary--',
  ].join('\r\n');
}

describe('mail MIME parsing', () => {
  it('parses headers, html/text, references and safe attachments', async () => {
    const body = multipart({ filename: 'guide.pdf', contentType: 'application/pdf', base64: 'JVBERi0=' });
    const parsed = await parseInboundEmail({
      raw: raw(
        [
          'From: Alice Example <alice@example.com>',
          'To: preview@flaxia.app',
          'Subject: Re: Fwd: Project update',
          'Message-ID: <child@example.com>',
          'In-Reply-To: <parent@example.com>',
          'References: <root@example.com> <parent@example.com>',
          'Authentication-Results: mx.cloudflare.net; spf=pass dkim=pass dmarc=pass',
          'Content-Type: multipart/mixed; boundary="boundary"',
        ],
        body,
      ),
      envelopeFrom: 'alice@example.com',
      envelopeTo: 'preview@flaxia.app',
      threadSecret: 'thread-secret',
    });

    assert.equal(parsed.subject, 'Re: Fwd: Project update');
    assert.equal(parsed.fromAddress, 'alice@example.com');
    assert.equal(parsed.fromName, 'Alice Example');
    assert.deepEqual(parsed.to, ['preview@flaxia.app']);
    assert.match(parsed.text, /Hello world/);
    assert.equal(parsed.html?.includes('<strong>world</strong>'), true);
    assert.equal(parsed.referenceIds.length, 2);
    assert.equal(parsed.referenceHashes.length, 2);
    assert.equal(parsed.inReplyTo, 'parent@example.com');
    assert.ok(parsed.subjectKey);
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0]?.filename, 'guide.pdf');
    assert.equal(parsed.attachments[0]?.blocked, false);
    assert.equal(parsed.attachments[0]?.inline, false);
    assert.equal(parsed.spam, true, 'non-inline attachments are quarantined until scanning exists');
    assert.equal(parsed.spamReason, 'attachment_scan_unavailable');
    assert.equal(normalizeSubject(parsed.subject), 'project update');
    assert.equal(normalizeSubject('  PROJECT   update '), 'project update');
  });

  it('blocks executable attachments', async () => {
    const body = multipart({ filename: 'invoice.exe', contentType: 'application/x-msdownload', base64: 'TVqQ' });
    const parsed = await parseInboundEmail({
      raw: raw(
        [
          'From: Bad Sender <bad@example.com>',
          'To: preview@flaxia.app',
          'Subject: Invoice',
          'Content-Type: multipart/mixed; boundary="boundary"',
        ],
        body,
      ),
      envelopeFrom: 'bad@example.com',
      envelopeTo: 'preview@flaxia.app',
    });
    assert.equal(parsed.attachments[0]?.blocked, true);
    assert.equal(parsed.spam, true);
    assert.equal(parsed.spamReason, 'attachment_blocked');
  });

  it('quarantines clear SPF/DKIM/DMARC failures', async () => {
    const parsed = await parseInboundEmail({
      raw: raw(
        [
          'From: Spoof <spoof@example.com>',
          'To: preview@flaxia.app',
          'Subject: Verify your account',
          'Authentication-Results: mx.cloudflare.net; spf=fail dkim=fail dmarc=fail',
          'Content-Type: text/plain; charset=utf-8',
        ],
        'Click here',
      ),
      envelopeFrom: 'spoof@example.com',
      envelopeTo: 'preview@flaxia.app',
    });
    assert.equal(parsed.auth.spf, 'fail');
    assert.equal(parsed.auth.dkim, 'fail');
    assert.equal(parsed.auth.dmarc, 'fail');
    assert.equal(parsed.spam, true);
    assert.equal(parsed.spamReason, 'auth_failed');
  });

  it('quarantines conflicting Authentication-Results headers', async () => {
    const parsed = await parseInboundEmail({
      raw: raw(
        [
          'From: Spoof <spoof@example.com>',
          'To: preview@flaxia.app',
          'Subject: Verify your account',
          // A client can prepend forged verdicts; the forged pass must not
          // override the MX verdict, so the conflict quarantines the message.
          'Authentication-Results: forged.example; spf=pass dkim=pass dmarc=pass',
          'Authentication-Results: mx.cloudflare.net; spf=fail dkim=fail dmarc=fail',
          'Content-Type: text/plain; charset=utf-8',
        ],
        'Click here',
      ),
      envelopeFrom: 'spoof@example.com',
      envelopeTo: 'preview@flaxia.app',
    });
    assert.equal(parsed.auth.ambiguous, true);
    assert.equal(parsed.spam, true);
    assert.equal(parsed.spamReason, 'auth_conflict');
  });

  it('keeps agreeing duplicate Authentication-Results headers unquarantined', async () => {
    const parsed = await parseInboundEmail({
      raw: raw(
        [
          'From: Alice <alice@example.com>',
          'To: preview@flaxia.app',
          'Subject: Hello',
          'Authentication-Results: mx.cloudflare.net; spf=pass dkim=pass dmarc=pass',
          'Authentication-Results: mx.cloudflare.net; spf=pass dkim=pass dmarc=pass',
          'Content-Type: text/plain; charset=utf-8',
        ],
        'Hello body',
      ),
      envelopeFrom: 'alice@example.com',
      envelopeTo: 'preview@flaxia.app',
    });
    assert.equal(parsed.auth.ambiguous, false);
    assert.equal(parsed.spam, false);
    assert.equal(parsed.spamReason, null);
  });
});
