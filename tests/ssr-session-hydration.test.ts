// The root layout resolves the session in the browser BEFORE hydration, so a
// page that calls getSessionUser() while rendering produces different markup
// on the client than the server sent. Pages must start from null and hydrate
// the session in onMount (as home/thread/users already do).
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const FILES = [
  'src/routes/explore/+page.svelte',
  'src/routes/search/+page.svelte',
  'src/routes/profile/[username]/+page.svelte',
  'src/routes/@[domain]/[username]/+page.svelte',
];

async function listComponents(dir: string, accept: (name: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listComponents(full, accept)));
    else if (entry.name.endsWith('.svelte') && accept(entry.name)) found.push(full);
  }
  return found;
}

/** Client-only APIs that must not be read while SSR builds the initial HTML. */
const RENDER_TIME_CALLS = ['getSessionUser()', 'detectDevicePlatform()', 'isDataSaverEnabled()'] as const;

// These components are never SSR-rendered: they are mounted imperatively from
// CardHost.svelte's onMount via Svelte's client-only `mount()`. Their init code
// therefore runs in the browser only, where reading localStorage is safe.
const CLIENT_ONLY_COMPONENTS = new Set(['src/lib/svelte/AdCard.svelte']);

/**
 * Return source locations where a client-only API is read during render.
 *
 * A call at script brace-depth 0 runs while the component is instantiated —
 * the same phase SSR renders — unless it sits in a deferred callback
 * (`onMount`, `$effect`, event handler, helper function) or behind a
 * `typeof window` guard. In markup, a bare `{...getSessionUser()...}` renders
 * immediately, while an inline arrow (`onclick={() => getSessionUser()}`) only
 * runs on interaction. Braces in strings/templates balance out, so a simple
 * line-by-line depth count is enough for this fast source-level guardrail.
 */
function renderTimeCalls(source: string): string[] {
  const scriptEnd = source.indexOf('</script>');
  const script = scriptEnd >= 0 ? source.slice(0, scriptEnd) : '';
  const markup = scriptEnd >= 0 ? source.slice(scriptEnd) : '';
  const offenders: string[] = [];

  let depth = 0;
  for (const [index, line] of script.split('\n').entries()) {
    const call = RENDER_TIME_CALLS.find((token) => line.includes(token));
    if (call) {
      const before = line.slice(0, line.indexOf(call));
      const deferred = depth > 0 || before.includes('=>') || before.includes('typeof window');
      if (!deferred) offenders.push(`script:${index + 1}: ${line.trim()}`);
    }
    depth += (line.match(/{/g)?.length ?? 0) - (line.match(/}/g)?.length ?? 0);
  }

  for (const [index, line] of markup.split('\n').entries()) {
    const call = RENDER_TIME_CALLS.find((token) => line.includes(token));
    if (call && !line.includes('=>')) offenders.push(`markup:${index + 1}: ${line.trim()}`);
  }
  return offenders;
}

test('SSR pages do not read the client-only session during render', async () => {
  for (const file of FILES) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /import \{ onMount \} from 'svelte'/, `${file} must hydrate the session in onMount`);
    assert.match(source, /let currentUser = \$state[^\n]*null/, `${file} must start with a null session`);
    assert.match(
      source,
      /onMount\(\(\)\s*=>\s*\{[\s\S]*?currentUser = getSessionUser\(\)/,
      `${file} must set the session in onMount`,
    );
    const markup = source.slice(source.indexOf('</script>'));
    assert.doesNotMatch(markup, /getSessionUser\(\)/, `${file} must not call getSessionUser() in markup`);
  }
});

test('no client-only session/device/setting API is read during component render', async () => {
  const routePages = await listComponents(join(ROOT, 'src/routes'), (name) => name === '+page.svelte');
  const libComponents = await listComponents(join(ROOT, 'src/lib/svelte'), () => true);
  const files = [...routePages, ...libComponents].map((file) => relative(ROOT, file));
  assert.ok(files.length > 20, 'the guardrail must cover every route page and lib component');

  const offenders: string[] = [];
  for (const file of files) {
    if (CLIENT_ONLY_COMPONENTS.has(file)) continue;
    const source = await readFile(join(ROOT, file), 'utf8');
    for (const hit of renderTimeCalls(source)) offenders.push(`${file}:${hit}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `client-only APIs must be read in onMount/callbacks, not during SSR render:\n${offenders.join('\n')}`,
  );
});

test('Mail components take a nullable session prop instead of reading it during render', async () => {
  const view = await readFile(new URL('../src/lib/svelte/MailView.svelte', import.meta.url), 'utf8');
  assert.match(view, /let currentUser = \$state[^\n]*null/, 'MailView must start with a null session');
  const mount = view.slice(view.indexOf('onMount('));
  assert.match(mount, /getSessionUser\(\)/, 'MailView must read the session in onMount');
  assert.match(mount, /currentUser = user/, 'MailView must adopt the session in onMount');

  const page = await readFile(new URL('../src/lib/svelte/MailPage.svelte', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /getSessionUser/, 'MailPage must not read the client-only session itself');
  assert.match(
    page,
    /currentUser: \{ id: string; username: string \} \| null/,
    'MailPage must accept a nullable session',
  );
});

test('DownloadPage hydrates the device recommendation and publishes an absolute og:url', async () => {
  const source = await readFile(new URL('../src/lib/svelte/DownloadPage.svelte', import.meta.url), 'utf8');
  assert.match(source, /let device = \$state[^\n]*'other'/, 'SSR must start from a neutral device');
  assert.match(
    source,
    /onMount\(\(\)\s*=>\s*\{[\s\S]*?device = detectDevicePlatform\(\)/,
    'device detection must run in onMount',
  );
  assert.doesNotMatch(source, /window\.location\.origin/, 'og:url must be absolute, not built from window');
});

test('StageThumbnail starts with thumbnails enabled and defers the data-saver check', async () => {
  const source = await readFile(new URL('../src/lib/svelte/media/StageThumbnail.svelte', import.meta.url), 'utf8');
  assert.match(source, /let skipThumbnail = \$state\(false\)/, 'SSR and the first client render must agree');
  const mount = source.slice(source.indexOf('onMount('));
  assert.match(mount, /isDataSaverEnabled\(\)/, 'the data-saver preference must be read in onMount');
  assert.match(mount, /skipThumbnail = true/, 'onMount must apply the preference to the rendered state');
});
