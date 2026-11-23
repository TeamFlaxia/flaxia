// Routing invariants for postmaster/abuse forwarding (docs/mail.md §11.1.3).
//
// The Email Routing forwarding itself is configured in the Cloudflare
// dashboard and cannot be tested from the repo. The Worker-side source guards
// live in the flaxia-mail repo; this suite protects the operator-facing
// documentation that ships with the Flaxia app.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { isReservedLocal } from '@flaxia/mail-contract';

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
});
