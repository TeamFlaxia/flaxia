// Capacitor copies `capacitor.config.ts`'s webDir (`dist`) into the native
// project. PR #506 made `npm run build` emit the adapter-cloudflare SSR output
// into `.svelte-kit/cloudflare`, while the static SPA moved to `build:native`
// (BUILD_TARGET=native). A CI job that still runs plain `npm run build`
// before `cap sync` ships missing or stale web assets.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const CAPACITOR_JOBS = [
  { workflow: '../.github/workflows/native-android.yml', job: 'android-offline' },
  { workflow: '../.github/workflows/release.yml', job: 'android' },
] as const;

function jobSection(source: string, job: string): string {
  const lines = source.split('\n');
  const start = lines.indexOf(`  ${job}:`);
  assert.notEqual(start, -1, `missing ${job} job`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[a-z][a-z0-9-]*:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

test('Capacitor jobs build the static dist/ web assets before cap sync', async () => {
  for (const { workflow, job } of CAPACITOR_JOBS) {
    const section = jobSection(await readFile(new URL(workflow, import.meta.url), 'utf8'), job);
    const capIndex = section.search(/\bcap\s+(?:add|sync|copy)\b/);
    assert.notEqual(capIndex, -1, `${job} must sync Capacitor web assets`);
    const beforeSync = section.slice(0, capIndex);

    assert.doesNotMatch(
      beforeSync,
      /(?:^|[\s'"])npm run build(?:\s|$)/,
      `${job} still runs plain npm run build before cap sync; that emits SSR output into .svelte-kit/cloudflare, not dist/`,
    );
    assert.match(
      beforeSync,
      /npm run (?:build:native|build:desktop)\b/,
      `${job} must build the static SPA into dist/ before cap sync`,
    );
  }
});

test('build:native emits the static native Vite build for webDir dist/', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(pkg.scripts['build:native'] ?? '', /BUILD_TARGET=native vite build/);
  const capacitor = await readFile(new URL('../capacitor.config.ts', import.meta.url), 'utf8');
  assert.match(capacitor, /webDir:\s*'dist'/);
});

test('cap:build:android:release builds static dist/ web assets before cap sync', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts['cap:build:android:release'] ?? '';
  assert.ok(script, 'missing cap:build:android:release script');

  assert.doesNotMatch(
    script,
    /npm run build\s*&&/,
    'cap:build:android:release must not run plain npm run build before cap sync; that emits SSR output into .svelte-kit/cloudflare, not dist/',
  );
  assert.match(
    script,
    /npm run (?:build:native|build:desktop)\s*&&/,
    'cap:build:android:release must build the static SPA into dist/ before cap sync',
  );
});

test('cap:sync applies the native bridge patches in both Android jobs', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(
    pkg.scripts['cap:sync'] ?? '',
    /patch-native-bridges\.mjs[\s\S]*&&[\s\S]*npx cap sync/,
    'cap:sync must patch bridges before copying web assets',
  );
  for (const { workflow, job } of CAPACITOR_JOBS) {
    const section = jobSection(await readFile(new URL(workflow, import.meta.url), 'utf8'), job);
    assert.match(section, /npm run cap:sync\b/, `${job} must use the patching cap:sync flow`);
    assert.doesNotMatch(section, /\bnpx cap sync android\b/, `${job} bypasses the native bridge patches`);
  }
});

test('release Tauri jobs rely on tauri.conf beforeBuildCommand instead of a plain build', async () => {
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  for (const job of ['tauri-linux', 'tauri-windows']) {
    const section = jobSection(release, job);
    const buildIndex = section.indexOf('npm run tauri:build');
    assert.notEqual(buildIndex, -1, `${job} must run tauri:build`);
    assert.doesNotMatch(
      section.slice(0, buildIndex),
      /(?:^|[\s'"])npm run build(?:\s|$)/,
      `${job} runs a redundant plain npm run build before tauri:build`,
    );
  }
  const tauri = await readFile(new URL('../src-tauri/tauri.conf.base.json', import.meta.url), 'utf8');
  assert.match(tauri, /"beforeBuildCommand":\s*"npm run build:(?:desktop|native)"/);
});
