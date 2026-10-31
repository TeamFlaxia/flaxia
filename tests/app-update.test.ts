import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  APP_UPDATE_RELEASES_API,
  APP_UPDATE_RELEASES_URL,
  checkForAppUpdate,
  dismissAppUpdate,
  isAppUpdateDismissed,
  isNewerAppVersion,
  normalizeAppVersion,
  parseLatestAppRelease,
  supportsAppUpdatePrompt,
} from '../src/lib/app-update.ts';

describe('app version comparison', () => {
  it('normalizes release tags', () => {
    assert.equal(normalizeAppVersion('v1.2.3'), '1.2.3');
    assert.equal(normalizeAppVersion(' 0.1.101 '), '0.1.101');
    assert.equal(normalizeAppVersion('main'), null);
    assert.equal(normalizeAppVersion('v1.2'), null);
  });

  it('detects strictly newer semantic versions', () => {
    assert.equal(isNewerAppVersion('0.1.100', 'v0.1.101'), true);
    assert.equal(isNewerAppVersion('0.1.100', 'v0.2.0'), true);
    assert.equal(isNewerAppVersion('0.1.100', 'v1.0.0'), true);
    assert.equal(isNewerAppVersion('0.1.100', 'v0.1.100'), false);
    assert.equal(isNewerAppVersion('0.1.101', 'v0.1.100'), false);
    assert.equal(isNewerAppVersion('bad', 'v0.1.100'), false);
  });
});

describe('supportsAppUpdatePrompt', () => {
  it('only targets Tauri Windows and Linux', () => {
    assert.equal(supportsAppUpdatePrompt({ isTauri: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }), true);
    assert.equal(supportsAppUpdatePrompt({ isTauri: true, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), true);
    assert.equal(
      supportsAppUpdatePrompt({ isTauri: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' }),
      false,
    );
    assert.equal(supportsAppUpdatePrompt({ isTauri: true, userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), false);
    assert.equal(supportsAppUpdatePrompt({ isTauri: false, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), false);
  });
});

describe('latest release parsing', () => {
  it('accepts stable release tags and GitHub release URLs', () => {
    assert.deepEqual(
      parseLatestAppRelease({
        tag_name: 'v0.1.101',
        html_url: 'https://github.com/TeamFlaxia/flaxia/releases/tag/v0.1.101',
      }),
      {
        tagName: 'v0.1.101',
        releaseUrl: 'https://github.com/TeamFlaxia/flaxia/releases/tag/v0.1.101',
      },
    );
  });

  it('rejects drafts, prereleases, and invalid tags', () => {
    assert.equal(parseLatestAppRelease({ tag_name: 'v0.1.101', draft: true }), null);
    assert.equal(parseLatestAppRelease({ tag_name: 'v0.1.101', prerelease: true }), null);
    assert.equal(parseLatestAppRelease({ tag_name: 'nightly' }), null);
    assert.equal(parseLatestAppRelease(null), null);
  });

  it('falls back to the generic latest release URL for untrusted links', () => {
    const release = parseLatestAppRelease({
      tag_name: 'v0.1.101',
      html_url: 'https://example.com/not-a-release',
    });
    assert.equal(release?.releaseUrl, APP_UPDATE_RELEASES_URL);
  });
});

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function installStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  (globalThis as { localStorage?: Storage }).localStorage = storage as unknown as Storage;
  return storage;
}

function clearStorage(): void {
  delete (globalThis as { localStorage?: Storage }).localStorage;
}

describe('checkForAppUpdate', () => {
  it('returns update details when GitHub has a newer release', async () => {
    let requestedUrl = '';
    const fetchImpl = (async (input: RequestInfo | URL) => {
      requestedUrl = input.toString();
      return new Response(
        JSON.stringify({
          tag_name: 'v0.1.101',
          html_url: 'https://github.com/TeamFlaxia/flaxia/releases/tag/v0.1.101',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const update = await checkForAppUpdate('0.1.100', fetchImpl);
    assert.equal(requestedUrl, APP_UPDATE_RELEASES_API);
    assert.deepEqual(update, {
      currentVersion: '0.1.100',
      latestVersion: '0.1.101',
      latestTag: 'v0.1.101',
      releaseUrl: 'https://github.com/TeamFlaxia/flaxia/releases/tag/v0.1.101',
    });
  });

  it('returns null when the app is already up to date', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ tag_name: 'v0.1.101' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    assert.equal(await checkForAppUpdate('0.1.101', fetchImpl), null);
  });

  it('fails closed when GitHub is unavailable', async () => {
    const fetchImpl = (async () => new Response('rate limited', { status: 403 })) as typeof fetch;
    assert.equal(await checkForAppUpdate('0.1.100', fetchImpl), null);
  });

  it('does not repeat a dismissed release', async () => {
    installStorage();
    try {
      dismissAppUpdate('v0.1.101');
      assert.equal(isAppUpdateDismissed('v0.1.101'), true);

      const fetchImpl = (async () =>
        new Response(JSON.stringify({ tag_name: 'v0.1.101' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch;

      assert.equal(await checkForAppUpdate('0.1.100', fetchImpl), null);
    } finally {
      clearStorage();
    }
  });
});
