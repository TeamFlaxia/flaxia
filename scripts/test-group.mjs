#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const groups = {
  // Repository guardrails. These need no dev server.
  guardrails: [
    'architecture',
    'csp-hashes',
    'deploy-targets',
    'dev-worker-watch',
    'docs-manifest-build',
    'export-popup-headers',
    'i18n-locale',
    'i18n-scope',
    'lazy-imports',
    'legal-markdown',
    'native-build-config',
    'legacy-adapters',
    'ogp-player-csp',
    'postbuild-docs-asset',
    'postbuild-routes',
    'seo-origin',
    'site-description',
    'ssr-cache',
    'ssr-data',
    'ssr-error-head',
    'ssr-handover',
    'ssr-hooks',
    'ssr-hydration',
    'ssr-security-headers',
    'ssr-session-hydration',
    'ssr-styles',
    'svelte-migration',
    'svelte-shell',
    'tailwind-tokens',
    'thread-session',
    'timeline-pull-to-refresh',
    'media-upload-ports',
    'mail-contract-wiring',
    'no-npm-publish',
    'crowd-node-entry',
    'upload-limits',
    // Click-latency regression suites (no dev server required).
    'async-side-effects',
    'auth-dedupe',
    'click-latency-indexes',
    'crowd-boot-defer',
    'first-click',
    'follow-optimistic',
    'overlay-click-through',
    'shell-boot',
    'ssr-data-cache',
    'text-links-navigation',
    'thread-no-duplicate-fetch',
    'waitUntil-behavior',
    // Click-latency PR A regression suites.
    'click-leak-fixes',
    'nav-progress',
    'query-indexes-0146',
    'ssr-click-anchor',
    'thread-enrichment-parallel',
    // Click-latency PR B regression suites.
    'auth-hot-path',
    'handle-fetch-cache',
    'optimistic-thread',
    // SSR boot data (hydration gate removal).
    'ssr-boot-client',
    'ssr-boot-injection',
    // D1 migration replay safety (no dev server required).
    'migration-idempotency',
  ],
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
    'auth-redirect',
    'flaxia-auth-session',
    'mail-send-seal',
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
    'post-text-helpers',
    'ai-index',
    'chunked-upload',
    'game-upload-e2e',
    'composer-logic',
    'ai-tags',
    'ai-tags-e2e',
    'duplicate-posts',
    'foryou-language-affinity',
    'iframe-reload',
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
    'post-visibility',
    'post-visibility-cache',
    'pending-follow-visibility',
    'quote-notification-visibility',
    'recommendation-visibility',
    'recommendation-action-signals',
    'reply-visibility',
    'visibility-quote-media',
    'visibility-read-paths',
    'federated-api',
    'federated-ondemand',
    'remote-lookup',
    'remote-mentions',
    'zip-range',
    'recommendation',
    'recommended',
    'search',
    'stamp-entitlement',
    'web-index',
    'tags',
    'title-icon',
    'trust-score',
    'titles',
    'unique',
  ],
  'media-games': [
    'arcade-page',
    'arcade-html-title',
    'media-stage-migration',
    'arcade-availability',
    'arcade-events',
    'attachments',
    'bug-reports',
    'clamav-payload',
    'container-result',
    'content-protection-security',
    'crowd',
    'crowd-callback-signature',
    'crowd-killswitch',
    'crowd-nsfw-binding',
    'crowd-scan-file',
    'diagnostics',
    'embedding-outbox',
    'extract-zip-to-r2',
    'file-blocklist',
    'file-extensions',
    'file-features',
    'file-scan-race',
    'file-scan-schema',
    'file-scans',
    'game-loader',
    'game-loader-fallback',
    'games-visibility-fixes',
    'game-sdk',
    'game-sdk-protocol-sync',
    'game-storage-migration',
    'game-titles',
    'game-versions',
    'i18n-bridge',
    'image-dimensions',
    'latest-game-payload',
    'legacy-sandbox-disabled',
    'media-cues',
    'media-editor-args',
    'media-moderation',
    'mime-guard',
    'multiplayer-api',
    'multiplayer-bridge',
    'multiplayer-client',
    'multiplayer-manager',
    'multiplayer-ticket',
    'multiplayer-worker-hibernation',
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
    'translate',
    'wvfs-audio-mute',
    'wvfs-cookie-compat',
    'wvfs-game-url',
    'wvfs-image-cors',
    'wvfs-response-cache',
    'wvfs-source-revision',
    'zip-structure-validation',
    'zip-validation',
  ],
  activitypub: [
    'activitypub-ap-gaps',
    'activitypub-public-alias',
    'ap-dlq-privacy',
    'activitypub-inbound-visibility',
    'federation-activity-shape',
    'handlers-pr512-fixes',
    'post-delete-visibility',
    'ap-pool',
    'activitypub-delivery',
    'activitypub-delivery-guard',
    'engagement-federation',
    'activitypub-discovery',
    'activitypub-dlq-config',
    'activitypub-dlq-provision',
    'activitypub-inbox',
    'activitypub-inbox-handlers',
    'activitypub-attachments',
    'activitypub-inbox-integrity',
    'activitypub-note',
    'activitypub-signature',
    'remote-author-decoration',
    'signature',
  ],
  'platform-ui': [
    'modal-logic',
    'draft-visibility',
    'settings/app-update-notice-model',
    'settings/bottom-nav-model',
    'settings/category-specs',
    'settings/private-notes',
    'settings/svelte-leaves',
    'settings/user-post-list-model',
    'settings/vault-unlock-state',
    'admin-analytics',
    'admin-nsfw',
    'android-origin',
    'android-version-code',
    'api-bridge-methods',
    'app-download',
    'api-origins',
    'app-update',
    'billing',
    'capacitor-security-config',
    'cc-range',
    'cc-webhook',
    'data-saver',
    'dataset-export',
    'deploy-config',
    'device-platform',
    'import-boundary',
    'left-nav-handlers',
    'left-nav-layout',
    'nav-items',
    'mail-routing',
    'mail-search',
    'maps',
    'native-api',
    'native-crowd',
    'native-fetch',
    'federated-ui',
    'profile-route-redirects',
    'remote-profile-p3',
    'remote-profile-ssr',
    'remote-profile-ui',
    'pr512-ui-fixes',
    'ssr',
    'ssr-docs',
    'ssr-error-page',
    'ssr-game-seo',
    'ssr-jsonld',
    'ssr-legal-route',
    'ssr-localization',
    'ssr-meta',
    'ssr-nav',
    'ssr-routing',
    'ssr-share-tags',
    'push-vapid',
    'render-preset',
    'router',
    'status-transition',
    'url-guard',
    'users',
    'view-nav',
    'web-push',
  ],
};

function collectTestNames(dir, prefix = '') {
  const names = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Nested suites are opt-in; render/integration/federation have their own
      // runners and must not be swept into the server-backed groups.
      if (entry.name === 'settings') {
        names.push(...collectTestNames(join(dir, entry.name), `${prefix}${entry.name}/`));
      }
    } else if (entry.name.endsWith('.test.ts')) {
      names.push(prefix + entry.name.slice(0, -'.test.ts'.length));
    }
  }
  return names;
}

const testNames = collectTestNames(join(root, 'tests')).sort();
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
