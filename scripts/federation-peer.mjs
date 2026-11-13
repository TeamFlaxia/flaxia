// Start the peer of the federation test.
//
// GoToSocial is started as a single container and is the peer the CI uses.
// Mastodon needs more services and is started with the compose file of the
// test directory; it is meant for a local run, where the differences between
// the implementations are interesting.
//
//   node scripts/federation-peer.mjs up gotosocial
//   node scripts/federation-peer.mjs up mastodon
//   node scripts/federation-peer.mjs down gotosocial
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MASTODON_COMPOSE = join(ROOT, 'tests', 'federation', 'mastodon', 'compose.yaml');

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', cwd: ROOT });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || '');
    process.exit(result.status ?? 1);
  }
  if (!options.quiet) process.stdout.write(result.stdout ?? '');
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch {
      // the instance is not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`The peer did not become ready: ${url}`);
}

const [command, kind] = process.argv.slice(2);

if (!command || !kind) {
  process.stderr.write('Usage: node scripts/federation-peer.mjs <up|down> <gotosocial|mastodon>\n');
  process.exit(1);
}

if (kind === 'gotosocial') {
  if (command === 'up') {
    docker([
      'run',
      '--detach',
      '--rm',
      '--name',
      'flaxia-federation-gotosocial',
      '--network',
      'host',
      '--env',
      'GTS_HOST=localhost:8080',
      '--env',
      'GTS_PROTOCOL=http',
      '--env',
      'GTS_DB_TYPE=sqlite',
      '--env',
      'GTS_DB_ADDRESS=/gotosocial/storage/sqlite.db',
      '--env',
      'GTS_HTTP_CLIENT_ALLOW_IPS=127.0.0.1/32,::1/128',
      '--env',
      'GTS_HTTP_CLIENT_INSECURE_OUTGOING=true',
      '--env',
      'GTS_OPEN_REGISTRATION=true',
      'superseriousbusiness/gotosocial:0.22.2',
    ]);
    await waitForHttp('http://localhost:8080/', 180_000);
    docker([
      'exec',
      'flaxia-federation-gotosocial',
      '/gotosocial/gotosocial',
      'admin',
      'account',
      'create',
      '--username',
      'peer',
      '--email',
      'peer@example.com',
      '--password',
      'peer-password-1234',
    ]);
    // The instance caches its accounts, so the new account is only visible
    // after a restart.
    docker(['restart', 'flaxia-federation-gotosocial']);
    await waitForHttp('http://localhost:8080/', 180_000);
    process.stdout.write('The peer is ready on http://localhost:8080\n');
  } else if (command === 'down') {
    docker(['rm', '--force', 'flaxia-federation-gotosocial']);
  } else {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.exit(1);
  }
} else if (kind === 'mastodon') {
  if (!existsSync(MASTODON_COMPOSE)) {
    process.stderr.write(`The compose file is missing: ${MASTODON_COMPOSE}\n`);
    process.exit(1);
  }
  mkdirSync(join(ROOT, 'tests', 'federation', 'mastodon', 'data'), { recursive: true });
  const compose = ['compose', '--project-name', 'flaxia-federation-mastodon', '--file', MASTODON_COMPOSE];
  if (command === 'up') {
    docker([...compose, 'up', '--detach']);
    await waitForHttp('http://localhost:8080/', 600_000);
    docker([
      ...compose,
      'exec',
      '-T',
      'web',
      'bin/tootctl',
      'accounts',
      'create',
      'peer',
      '--email',
      'peer@example.com',
      '--password',
      'peer-password-1234',
      '--confirmed',
    ]);
    process.stdout.write('The peer is ready on http://localhost:8080\n');
  } else if (command === 'down') {
    docker([...compose, 'down', '--volumes']);
  } else {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.exit(1);
  }
} else {
  process.stderr.write(`Unknown peer: ${kind}\n`);
  process.exit(1);
}
