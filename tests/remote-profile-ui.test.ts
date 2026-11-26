// UI guards for internal remote-profile navigation and bio rendering.
//
// Remote authors must open their local `/@domain/user` page instead of the
// original instance, and their untrusted `summary` must be rendered as escaped
// Svelte text rather than injected HTML.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

/** Body of `function goToProfile()` in the header component. */
async function goToProfile(): Promise<string> {
  const header = await read('src/lib/svelte/PostHeader.svelte');
  const body = header.match(/function goToProfile\(\): void \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'PostHeader must define goToProfile()');
  return body;
}

describe('remote profile navigation', () => {
  it('prefers the internal profile path over the external actor URL', async () => {
    const body = await goToProfile();
    const internal = body.indexOf('props.profile_path');
    const external = body.indexOf('props.profile_url');
    assert.ok(internal >= 0, 'profile_path must be handled');
    assert.ok(external > internal, 'profile_path must be checked before the external fallback');
    assert.match(body, /navigate\(props\.profile_path\)/);
    assert.match(body, /window\.open\(props\.profile_url, '_blank', 'noopener,noreferrer'\)/);
    assert.match(body, /navigate\(`\/profile\/\$\{props\.username\}`\)/);
  });

  it('keeps the card click isolated from the profile click', async () => {
    const header = await read('src/lib/svelte/PostHeader.svelte');
    assert.match(header, /function onProfileClick\(e: MouseEvent\): void \{\s*e\.stopPropagation\(\);/);
    assert.match(header, /onclick=\{onProfileClick\}/);
  });

  it('forwards profile_path from the post into the header', async () => {
    const card = await read('src/lib/svelte/PostCard.svelte');
    const headerBlock = card.match(/<PostHeader([\s\S]*?)\/>/)?.[1];
    assert.ok(headerBlock, 'PostCard must render PostHeader');
    assert.match(headerBlock, /profile_path=\{props\.post\.profile_path\}/);
    // The external URL and the other author props must survive the change.
    assert.match(headerBlock, /profile_url=\{props\.post\.actor_id\}/);
    assert.match(headerBlock, /username=\{props\.post\.username\}/);
    assert.match(headerBlock, /display_name=\{props\.post\.display_name\}/);
    assert.match(headerBlock, /createdAt=\{props\.post\.created_at\}/);
  });
});

describe('remote profile bio rendering', () => {
  it('renders the bio as escaped text inside profile-bio', async () => {
    const page = await read('src/lib/svelte/RemoteProfilePage.svelte');
    assert.match(page, /<div class="profile-bio">\{bio\}<\/div>/);
    assert.match(page, /bio = \$state<string \| null>\(initialActor\?\.bio \?\? null\)/);
    assert.match(page, /bio = data\.actor\?\.bio \?\? null/);
    assert.doesNotMatch(page, /\{@html[^}]*bio/i, 'remote summary is untrusted HTML and must never be injected');
    assert.match(page, /t\('remote_profile\.bio_label'\)/);
  });

  it('links to the original actor only for safe http(s) URLs', async () => {
    const page = await read('src/lib/svelte/RemoteProfilePage.svelte');
    assert.match(page, /\^https\?:\\\/\\\//);
    assert.match(page, /class="profile-instance-link" href=\{safeActorUrl\}/);
    assert.match(page, /rel="noopener noreferrer"/);
    assert.match(page, /t\('remote_profile\.view_on_instance'\)/);
    assert.match(page, /actorUrl = data\.actor\?\.actor_url \?\? null/);
  });

  it('reuses SSR data without a duplicate fetch and releases the SSR fallback', async () => {
    const page = await read('src/lib/svelte/RemoteProfilePage.svelte');
    assert.match(page, /initialProfile\?: \{/);
    assert.match(page, /let skipInitialFetch = Boolean\(initialProfile\)/);
    assert.match(page, /if \(skipInitialFetch\) \{[\s\S]*?signalSsrHandover\(\);/);
    assert.match(page, /signalSsrHandover\(\);[\s\S]*?\n\s*\}\s*catch/);
  });
});
