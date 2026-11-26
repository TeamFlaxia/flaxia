// Wiring guards for the Federated tab: route + nav + component + copy.
//
// The page is a thin Svelte shell around the existing card host, so these
// checks keep the ranked feed from silently turning into a second
// chronological timeline or losing its guest support.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { navItemsFor } from '../src/lib/nav-items.ts';
import { pageDescription, pageTitle } from '../src/lib/page-title.ts';
import { parseRoute } from '../src/lib/router.ts';
import { viewToBottomNavId } from '../src/lib/view-nav.ts';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const REQUIRED_KEYS = [
  'nav.federated',
  'federated.title',
  'federated.subtitle',
  'federated.empty',
  'federated.load_failed',
  'federated.popular_label',
  'federated.hide_hint',
] as const;

describe('federated navigation and routing', () => {
  it('exposes a public Federated item in both rails', () => {
    for (const signedIn of [false, true]) {
      const item = navItemsFor(signedIn).find((entry) => entry.id === 'federated');
      assert.ok(item, `federated missing from ${signedIn ? 'signed-in' : 'guest'} rail`);
      assert.equal(item.labelKey, 'nav.federated');
      assert.equal(item.icon, 'explore');
    }
  });

  it('parses /federated as its own view and highlights the discovery tab', () => {
    assert.equal(parseRoute('/federated', '')?.view, 'federated');
    assert.equal(parseRoute('/federated/', '')?.view, 'federated');
    assert.equal(viewToBottomNavId('federated'), 'explore');
  });

  it('keeps the remote-profile title behaviour and adds a Federated title', async () => {
    const titleSource = await read('src/lib/page-title.ts');
    assert.ok(
      titleSource.includes("[/^\\/federated/, () => t('federated.title')]"),
      'federated needs its own document title',
    );
    assert.match(titleSource, /function profileLabel\(pathname: string\)/);
    assert.match(titleSource, /remote_profile\.title/);
    assert.ok(
      titleSource.indexOf('profileLabel(pathname)') < titleSource.indexOf('for (const [pattern, label]'),
      'remote profiles still win over generic patterns',
    );

    const descriptionSource = titleSource.slice(titleSource.indexOf('export function pageDescription'));
    assert.match(descriptionSource, /t\('federated\.subtitle'\)/);
    assert.match(descriptionSource, /t\('site\.description'\)/);
    // Locale files are browser/SSR assets; in Node t() falls back to the key.
    assert.equal(pageTitle('/federated'), 'Flaxia - federated.title');
    assert.equal(pageDescription('/federated'), 'federated.subtitle');
    assert.equal(pageDescription('/@remote.example/alice'), 'site.description');
  });
});

describe('federated page wiring', () => {
  it('renders the public page inside the shell for guests and signed-in users', async () => {
    const route = await read('src/routes/federated/+page.svelte');
    assert.match(route, /<ShellLayout navProps=\{\{ activeItem: 'federated', currentUser \}\}>/);
    assert.match(route, /<FederatedPage[\s\S]*\/>/);
    assert.match(route, /getSessionUser\(\)/);
    assert.match(route, /currentUser = \$state<[\s\S]*\| null>\(null\)/, 'must start as a guest');
    assert.match(route, /sandboxOrigin=\{import\.meta\.env\.VITE_SANDBOX_ORIGIN/);
    assert.match(route, /pageDescription\('\/federated'\)/);
  });

  it('feeds the existing card host from the ranked API without re-sorting', async () => {
    const component = await read('src/lib/svelte/FederatedPage.svelte');
    assert.match(component, /import CardHost from ['"]\.\.\/timeline\/CardHost\.svelte['"]/);
    assert.match(component, /import type \{ CardOptions \} from ['"]\.\.\/timeline\/cards\.ts['"]/);
    assert.match(component, /<CardHost item=\{post\} options=\{cardOptions\} \/>/);
    assert.match(component, /\/api\/federated\/posts/);
    assert.match(component, /IntersectionObserver/);
    assert.match(component, /t\('federated\.empty'\)/);
    assert.match(component, /t\('federated\.load_failed'\)/);
    assert.match(component, /t\('federated\.popular_label'\)/);
    assert.match(component, /t\('federated\.hide_hint'\)/);
    assert.doesNotMatch(component, /\.sort\(/, 'the server ranking is authoritative');
    assert.doesNotMatch(component, /created_at/, 'no client-side chronological ordering');
  });

  it('mounts the API router without dropping the existing mounts', async () => {
    const entry = await read('functions/api/[[route]].ts');
    assert.match(entry, /import federatedRouter from '\.\/routes\/federated'/);
    assert.match(entry, /app\.route\('\/api', federatedRouter\)/);
    for (const mount of ['postsRouter', 'usersRouter', 'searchRouter', 'activitypubRouter']) {
      assert.match(entry, new RegExp(`app\\.route\\([^\\n]*${mount}\\)`), `${mount} must stay mounted`);
    }
    const api = await read('functions/api/routes/federated.ts');
    assert.match(api, /ORDER BY pm\.score DESC, p\.created_at DESC/);
    assert.match(api, /JOIN ap_pool_metrics pm ON pm\.post_id = p\.id/);
    assert.match(api, /resolveRequestUser\(c, c\.get\('user'\)\)/);
    assert.match(api, /enrichFeedPosts\(/);
    assert.match(api, /next_cursor/);
  });
});

describe('federated locale strings', () => {
  it('ships the same keys in English and Japanese', async () => {
    const en = JSON.parse(await read('public/locales/en.json')) as Record<string, string>;
    const ja = JSON.parse(await read('public/locales/ja.json')) as Record<string, string>;
    for (const key of REQUIRED_KEYS) {
      assert.ok(typeof en[key] === 'string' && en[key].length > 0, `${key} missing from en.json`);
      assert.ok(typeof ja[key] === 'string' && ja[key].length > 0, `${key} missing from ja.json`);
    }
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ja).sort());
  });
});
