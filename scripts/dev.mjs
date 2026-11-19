#!/usr/bin/env node
// Local dev orchestrator: Flaxia + the sibling flaxia-auth worker.
//
// Auth lives in TeamFlaxia/flaxia-auth. `npm run dev` starts both so the
// redirect login flow works locally without hand-wiring ports, the service
// binding, or AUTH_UI_ORIGIN. UI-only work can use `npm run dev:guest`.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
if (has('help') || args.includes('-h')) {
  console.log(`Flaxia local dev

  npm run dev        Flaxia + local Auth (login works)
  npm run dev:guest  UI-only, no Auth (login disabled)
  npm run dev:hot    Same as dev, with a Vite build watcher

Environment:
  FLAXIA_AUTH_DIR             Auth repo path (default ../flaxia-auth)
  FLAXIA_DEV_PORT             Flaxia port (default 8787)
  FLAXIA_AUTH_PORT            Auth port (default 8799)
  FLAXIA_AUTH_INSPECTOR_PORT  Auth inspector port (default auth port + 100)`);
  process.exit(0);
}
const optionValue = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const envNumber = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const guest = has('guest') || process.env.FLAXIA_DEV_GUEST === '1';
const hot = has('hot');
const flaxiaPort = envNumber('FLAXIA_DEV_PORT', Number(optionValue('port')) || 8787);
const authPort = envNumber('FLAXIA_AUTH_PORT', Number(optionValue('auth-port')) || 8799);
const authInspectorPort = envNumber('FLAXIA_AUTH_INSPECTOR_PORT', authPort + 100);
const authDir = resolve(ROOT, process.env.FLAXIA_AUTH_DIR || optionValue('auth-dir') || '../flaxia-auth');

const children = new Set();
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const pids = [...children];
  for (const child of pids) {
    try {
      if (process.platform === 'win32') child.kill('SIGINT');
      else process.kill(-child.pid, 'SIGINT');
    } catch {
      // already gone
    }
  }
  // Give workerd a moment to release its ports, then make sure the whole
  // process group is gone.
  setTimeout(() => {
    for (const child of pids) {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    process.exit(code);
  }, 600);
}

function spawnTracked(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, {
    cwd: options.cwd ?? ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    // Own process group so a Ctrl-C / SIGTERM tears down workerd too.
    detached: process.platform !== 'win32',
    env: { ...process.env, ...options.env },
  });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!shuttingDown && options.exitOnFailure && code !== 0) {
      console.error(`[dev] ${options.label ?? command} exited (${signal ?? code}).`);
      shutdown(code ?? 1);
    }
  });
  child.on('error', (error) => {
    children.delete(child);
    console.error(`[dev] ${options.label ?? command} failed to start: ${error.message}`);
    if (!shuttingDown && options.exitOnFailure) shutdown(1);
  });
  return child;
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, ...options.env },
    });
    child.on('exit', (code) => resolvePromise(code ?? 1));
    child.on('error', () => resolvePromise(1));
  });
}

function portInUse(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('error', () => resolvePromise(false));
  });
}

async function authHealthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.service === 'flaxia-auth';
  } catch {
    return false;
  }
}

async function waitForAuth(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await authHealthy(port)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  }
  return false;
}

async function startAuth() {
  if (!existsSync(join(authDir, 'package.json'))) {
    console.error(`[dev] flaxia-auth was not found at ${authDir}`);
    console.error('[dev] Clone TeamFlaxia/flaxia-auth next to this repo, or set FLAXIA_AUTH_DIR.');
    console.error('[dev] For UI-only work without login: npm run dev:guest');
    shutdown(1);
    return false;
  }
  if (!existsSync(join(authDir, 'node_modules'))) {
    console.error(`[dev] flaxia-auth dependencies are missing. Run \`npm ci\` in ${authDir}`);
    shutdown(1);
    return false;
  }
  if (await authHealthy(authPort)) {
    console.log(`[dev] Reusing the local auth worker on http://localhost:${authPort}`);
    return true;
  }
  if (await portInUse(authPort)) {
    console.error(`[dev] Port ${authPort} is already in use by another process.`);
    console.error('[dev] Set FLAXIA_AUTH_PORT or stop that process.');
    shutdown(1);
    return false;
  }

  console.log('[dev] Applying local auth migrations…');
  if (
    (await run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'flaxia-auth-prod', '--local'], { cwd: authDir })) !== 0
  ) {
    console.error('[dev] Auth migrations failed.');
    shutdown(1);
    return false;
  }
  console.log('[dev] Building the auth login UI…');
  if ((await run('npm', ['run', 'build'], { cwd: authDir })) !== 0) {
    console.error('[dev] Auth build failed.');
    shutdown(1);
    return false;
  }

  spawnTracked('npx', ['wrangler', 'dev', '--port', String(authPort), '--inspector-port', String(authInspectorPort)], {
    cwd: authDir,
    label: 'flaxia-auth',
    exitOnFailure: true,
  });
  if (!(await waitForAuth(authPort))) {
    console.error('[dev] The local auth worker did not start. See the log above.');
    shutdown(1);
    return false;
  }
  return true;
}

async function main() {
  console.log(`[dev] Flaxia: http://localhost:${flaxiaPort}`);
  if (!guest) {
    console.log(`[dev] Auth:   http://localhost:${authPort}  (${authDir})`);
    if (![8787, 8788, 3000].includes(flaxiaPort)) {
      console.warn('[dev] flaxia-auth allowlists return URIs on :8787, :8788 and :3000.');
      console.warn('[dev] Login will fail on this port unless the auth repo is updated.');
    }
  }

  if (await portInUse(flaxiaPort)) {
    console.error(`[dev] Port ${flaxiaPort} is already in use.`);
    console.error('[dev] Stop the existing dev server or set FLAXIA_DEV_PORT.');
    shutdown(1);
    return;
  }

  if (!guest && !(await startAuth())) return;

  console.log('[dev] Applying Flaxia migrations…');
  if ((await run('npm', ['run', 'migrate:local'])) !== 0) {
    console.error('[dev] Flaxia migrations failed.');
    shutdown(1);
    return;
  }
  console.log('[dev] Building Flaxia…');
  if ((await run('npx', ['vite', 'build'])) !== 0) {
    console.error('[dev] Flaxia build failed.');
    shutdown(1);
    return;
  }

  const pagesArgs = [
    'wrangler',
    'pages',
    'dev',
    'dist',
    '--port',
    String(flaxiaPort),
    '--inspector-port',
    String(flaxiaPort + 100),
    '--binding',
    'ADMIN_USERNAMES=remydrescarlet',
    '--binding',
    'ENVIRONMENT=development',
    '--binding',
    'WEB_INDEX_ENABLED=1',
    '--binding',
    `BASE_URL=http://localhost:${flaxiaPort}`,
    '--binding',
    'SANDBOX_ORIGIN=http://localhost:3000',
    '--do',
    'NOTIFICATION_STREAM=NotificationStream@notif-stream',
    '--do',
    'MULTIPLAYER_ROOM=MultiplayerRoom@multiplayer-worker',
    '--do',
    'MATCHMAKER=Matchmaker@multiplayer-worker',
  ];
  if (guest) {
    pagesArgs.push('--binding', 'AUTH_AUTHORITY_MODE=off');
  } else {
    pagesArgs.push(
      '--binding',
      'AUTH_AUTHORITY_MODE=flaxia-auth',
      '--binding',
      `AUTH_UI_ORIGIN=http://localhost:${authPort}`,
      '--service',
      'AUTH_SERVICE=flaxia-auth',
    );
  }

  spawnTracked('npx', pagesArgs, { label: 'flaxia pages dev', exitOnFailure: true });

  if (hot) {
    console.log('[dev] Watching Vite builds…');
    spawnTracked('npx', ['vite', 'build', '--watch'], { label: 'vite build --watch' });
  }
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

void main();
