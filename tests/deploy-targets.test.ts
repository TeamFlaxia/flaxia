// Guardrails for the two build outputs that must never be confused:
// `npm run build` writes the SvelteKit SSR output to `.svelte-kit/cloudflare`
// (Pages), while `npm run build:native` writes the static SPA to `dist/`
// (Capacitor / Tauri). Deploying or documenting the wrong directory produces a
// site with no worker or a native app with no assets.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readScripts = async (): Promise<Record<string, string>> =>
  (JSON.parse(await read('package.json')) as { scripts: Record<string, string> }).scripts;

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

test('standalone game-loader builds generate $app/tsconfig first', async () => {
  const scripts = await readScripts();
  const command = scripts['build:game-loader'];
  const sync = command.indexOf('svelte-kit sync');
  const loader = command.indexOf('scripts/build-game-loader.mjs');
  assert.ok(sync >= 0, 'build:game-loader must generate $app/tsconfig for its Vite build');
  assert.ok(loader >= 0 && sync < loader, 'svelte-kit sync must run before the Vite build');
});

test('Pages deploy and dev scripts serve the adapter-cloudflare output', async () => {
  const scripts = await readScripts();
  for (const name of ['deploy', 'dev:api', 'dev:test', 'dev:all']) {
    assert.ok(scripts[name], `package.json is missing the ${name} script`);
    assert.match(scripts[name], /\.svelte-kit\/cloudflare\b/, `${name} must serve the SSR build`);
    assert.doesNotMatch(scripts[name], /wrangler pages deploy\s+dist\b/, `${name} must not deploy dist/`);
  }
});

test('the deploy workflow and wrangler.toml agree on .svelte-kit/cloudflare', async () => {
  const deploy = await read('.github/workflows/deploy.yml');
  assert.match(deploy, /wrangler pages deploy \.svelte-kit\/cloudflare\b/);
  assert.doesNotMatch(deploy, /wrangler pages deploy\s+dist\b/);
  const wrangler = await read('wrangler.toml');
  assert.match(wrangler, /^pages_build_output_dir\s*=\s*"\.svelte-kit\/cloudflare"\s*$/m);
});

test('no workflow deploys a Pages site from dist', async () => {
  for (const workflow of ['ci.yml', 'deploy.yml', 'federation.yml', 'release.yml', 'native-android.yml']) {
    const source = await read(`.github/workflows/${workflow}`);
    assert.doesNotMatch(source, /wrangler pages deploy\s+dist\b/, `${workflow} deploys the obsolete dist/ output`);
  }
});

test('the SSR browser job fails when its server never comes up', async () => {
  const job = jobSection(await read('.github/workflows/ci.yml'), 'ssr-browser');
  // Without the env var the browser test silently skips when no server is up.
  assert.match(job, /FLAXIA_SSR_REQUIRE_SERVER:\s*'?1'?/, 'the SSR browser job must require a live server');
  // A readiness loop that only breaks is not an assertion: fail the job if the
  // server never answered.
  assert.match(job, /curl -fsS http:\/\/localhost:8788\/home\s*>\s*\/dev\/null/);
  assert.match(job, /set -euo pipefail/, 'a failed readiness assertion must fail the step');
});

test('readiness probes use /home instead of the / redirect', async () => {
  const ci = await read('.github/workflows/ci.yml');
  const testJob = jobSection(ci, 'test');
  assert.match(testJob, /curl -s http:\/\/localhost:8788\/home\s*>/);
  assert.doesNotMatch(testJob, /curl -s http:\/\/localhost:8788\s*>/);
  const federation = await read('.github/workflows/federation.yml');
  assert.match(federation, /curl -fsS http:\/\/localhost:8788\/home\s*>/);
  assert.doesNotMatch(federation, /curl -fsS http:\/\/localhost:8788\/?\s*>/);
});

test('docs and generated-file comments no longer advertise the obsolete outputs', async () => {
  const deployment = await read('docs/deployment.md');
  assert.match(deployment, /\.svelte-kit\/cloudflare/);
  assert.doesNotMatch(deployment, /wrangler pages deploy\s+dist\b/);
  assert.doesNotMatch(deployment, /build output is in `dist\/`/i);
  assert.doesNotMatch(
    deployment,
    /CONTENT_ORIGIN[^\n]*SANDBOX_ORIGIN[^\n]*wrangler pages deploy/,
    'origin variables are baked in by npm run build, not by wrangler pages deploy',
  );

  const setup = await read('docs/setup.md');
  assert.doesNotMatch(setup, /existing dist\//i, 'dev:api serves .svelte-kit/cloudflare');

  const offline = await read('docs/offline-clients.md');
  assert.match(offline, /npm run build:native/);
  assert.doesNotMatch(offline, /Web and Capacitor builds use `npm run build`/i);

  const rendering = await read('docs/rendering.md');
  assert.doesNotMatch(rendering, /dist\/assets\/main-\*\.css/);

  const manifest = await read('scripts/docs-manifest.mjs');
  assert.doesNotMatch(manifest, /adapter-static/);

  const gitignore = await read('.gitignore');
  assert.doesNotMatch(gitignore, /functions\/lib\/ssr-head\.generated\.ts/);
});
