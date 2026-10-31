#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const groups = {
  'auth-vault': [
    'auth',
    'auth-cache',
    'auth-credential-retry',
    'auth-deletion-retry',
    'auth-direct-credential-retry',
    'auth-direct-email-retry',
    'auth-direct-session',
    'auth-grant-introspection',
    'auth-guard',
    'auth-local-purge',
    'auth-logout-revocation',
    'auth-provision-guard',
    'auth-rate-limit-fail-closed',
    'auth-vault',
    'email-normalization',
    'flaxia-auth-login',
    'flaxia-auth-session',
    'market-auth-session',
    'password-policy',
    'security-guards',
    'security-review-regressions',
    'srp',
    'srp-auth-e2e',
    'srp-copy',
    'srp-kdf',
    'vault',
    'vault-devices',
    'vault-pairing',
    'vault-primitives',
    'vault-session',
  ],
  'posts-feeds': [
    'activitypub-dlq-config',
    'activitypub-dlq-provision',
    'activitypub-inbox-integrity',
    'ai-index',
    'duplicate-posts',
    'link-preview',
    'link-preview-integration',
    'linucb',
    'notifications',
    'notifications-api',
    'pagination',
    'poll-state',
    'post-colors',
    'post-colors-api',
    'posts',
    'recommended',
    'stamp-entitlement',
    'tags',
    'title-icon',
    'trust-score',
    'titles',
  ],
  'media-games': [
    'arcade-availability',
    'arcade-events',
    'attachments',
    'clamav-payload',
    'container-result',
    'content-protection-security',
    'crowd',
    'crowd-callback-signature',
    'crowd-killswitch',
    'crowd-nsfw-binding',
    'crowd-scan-file',
    'extract-zip-to-r2',
    'file-blocklist',
    'file-extensions',
    'file-features',
    'file-scan-race',
    'file-scan-schema',
    'file-scans',
    'game-loader',
    'game-loader-fallback',
    'game-storage-migration',
    'game-versions',
    'image-dimensions',
    'legacy-sandbox-disabled',
    'media-editor-args',
    'media-moderation',
    'mime-guard',
    'multiplayer-api',
    'multiplayer-bridge',
    'multiplayer-client',
    'multiplayer-manager',
    'multiplayer-ticket',
    'nsfw',
    'offline-client',
    'offline-games',
    'pdf-viewer',
    'pending-reap',
    'phash',
    'profile-media-reap',
    'rescreen-quarantined',
    'sandbox-preview-bridge',
    'sandbox-response-policy',
    'wvfs-cookie-compat',
    'wvfs-game-url',
    'wvfs-image-cors',
    'wvfs-response-cache',
    'wvfs-source-revision',
    'zip-structure-validation',
    'zip-validation',
  ],
  'platform-ui': [
    'admin-analytics',
    'admin-nsfw',
    'android-origin',
    'android-version-code',
    'app-download',
    'api-origins',
    'app-update',
    'billing',
    'capacitor-security-config',
    'dataset-export',
    'deploy-config',
    'device-platform',
    'left-nav-handlers',
    'native-api',
    'native-crowd',
    'native-fetch',
    'page-loader',
    'push-vapid',
    'render-preset',
    'router',
    'signature',
    'spa-history',
    'ssr-security-headers',
    'status-transition',
    'url-guard',
    'users',
    'view-nav',
    'web-push',
  ],
};

const testNames = readdirSync(join(root, 'tests'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => name.slice(0, -'.test.ts'.length))
  .sort();
const known = new Set(testNames);
const assigned = new Map();

for (const [group, files] of Object.entries(groups)) {
  for (const file of files) {
    if (!known.has(file)) {
      console.error(`Unknown test file in ${group}: tests/${file}.test.ts`);
      process.exit(1);
    }
    if (assigned.has(file)) {
      console.error(`tests/${file}.test.ts is assigned to both ${assigned.get(file)} and ${group}`);
      process.exit(1);
    }
    assigned.set(file, group);
  }
}

const missing = testNames.filter((file) => !assigned.has(file));
if (missing.length > 0) {
  console.error(`Unassigned test files: ${missing.join(', ')}`);
  process.exit(1);
}

const groupName = process.argv[2];
if (!groupName) {
  console.error(`Usage: npm run test:group -- <${Object.keys(groups).join('|')}>`);
  process.exit(1);
}

const files = groups[groupName];
if (!files) {
  console.error(`Unknown test group: ${groupName}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--experimental-strip-types',
    '--test-concurrency=1',
    ...process.argv.slice(3),
    ...files.map((file) => `tests/${file}.test.ts`),
  ],
  { cwd: root, stdio: 'inherit' },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
