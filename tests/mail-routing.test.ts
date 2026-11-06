// Routing invariants for postmaster/abuse forwarding (docs/mail.md §11.1.3).
//
// The Email Routing forwarding itself is configured in the Cloudflare
// dashboard and cannot be tested from the repo. This suite guards the repo
// side of the contract so a future edit cannot silently break the exception:
//   - the destination is the TeamFlaxia contact already published in legal docs
//   - postmaster/abuse stay reserved (not provisionable as user addresses)
//   - docs/deployment.md records the forwarding steps for the operator
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { isReservedLocal } from '../src/lib/mail/address.ts';

const DESTINATION = 'teamflaxia@proton.me';

describe('mail postmaster/abuse forwarding', () => {
  it('keeps postmaster/abuse reserved (not user addresses)', () => {
    assert.equal(isReservedLocal('postmaster'), true);
    assert.equal(isReservedLocal('abuse'), true);
  });

  it('documents the forwarding destination in mail.md', () => {
    const mail = readFileSync(new URL('../docs/mail.md', import.meta.url), 'utf8');
    assert.ok(mail.includes(`${DESTINATION}`), 'mail.md must name the forwarding destination');
    assert.ok(
      mail.includes('postmaster@flaxia.app') && mail.includes('abuse@flaxia.app'),
      'mail.md must name both forwarded addresses',
    );
    assert.ok(mail.includes('§11.1.3') || mail.includes('§11.1'), 'mail.md must cite the routing section');
  });

  it('records the dashboard steps in deployment.md', () => {
    const deploy = readFileSync(new URL('../docs/deployment.md', import.meta.url), 'utf8');
    assert.ok(deploy.includes(`${DESTINATION}`), 'deployment.md must name the destination');
    assert.ok(
      deploy.includes('postmaster@flaxia.app') && deploy.includes('abuse@flaxia.app'),
      'deployment.md must name both forwarded addresses',
    );
    assert.ok(
      deploy.includes('Destination') && deploy.includes('Custom address'),
      'deployment.md must describe destination + custom address steps',
    );
  });

  it('does not forward user mail (catch-all stays on the Worker)', () => {
    const worker = readFileSync(new URL('../mail-worker/src/index.ts', import.meta.url), 'utf8');
    assert.ok(!worker.includes(DESTINATION), 'the Mail Worker must never see proton.me traffic');
    assert.ok(!worker.includes('MAIL_FALLBACK_FORWARD'), 'the fallback forward must stay removed');
  });
});
