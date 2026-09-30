import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import i18next from 'i18next';

// Source files that reference session-lifecycle locale keys — the old `unconfirmed*` keys were
// renamed to `incomplete*`, so a stale reference would render a raw key string to the operator.
const SESSIONS_PAGE_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'pages', 'Sessions.tsx'),
  'utf8',
);

// Catalog-level assertions over the real locale files through a real i18next instance — catches
// missing keys (a component would render the raw key), missing plural forms (a count renders the
// wrong number form), and interpolation drift that a JSON diff can't see.

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'locales');
const LOCALE_IDS = readdirSync(LOCALES_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace('.json', ''))
  .sort();

const resources = Object.fromEntries(
  LOCALE_IDS.map(id => [id, { translation: JSON.parse(readFileSync(join(LOCALES_DIR, `${id}.json`), 'utf8')) }]),
);

// No fallbackLng on purpose: a key missing from a locale must surface as the raw key, not as English.
const i18n = i18next.createInstance();
await i18n.init({ lng: 'en', resources, fallbackLng: false, interpolation: { escapeValue: false } });

const SESSION_SCOPE_KEYS = [
  'apiKeys.columns.sessions',
  'apiKeys.sessions.label',
  'apiKeys.sessions.hint',
  'apiKeys.sessions.all',
  'apiKeys.sessions.empty',
  'apiKeys.sessions.restricted',
  'apiKeys.sessions.save',
  'apiKeys.sessions.choose',
  'apiKeys.sessions.leaveAll',
  'apiKeys.actions.edit',
  'apiKeys.edit.title',
  'apiKeys.edit.signedIn',
  'apiKeys.columns.restrictions',
  'apiKeys.restrictions.ips',
  'apiKeys.restrictions.chats',
  'apiKeys.ips.label',
  'apiKeys.chats.label',
  'apiKeys.expiry.label',
];

const NEW_PLUGIN_KEYS = [
  'plugins.catalog.empty',
  'plugins.catalog.install',
  'plugins.catalog.installed',
  'plugins.catalog.noDownload',
  'plugins.catalog.noMatch',
  'plugins.catalog.searchPlaceholder',
  'plugins.catalog.update',
  'plugins.catalog.updateAvailable',
  'plugins.catalog.updated',
  'plugins.installModal.catalogHint',
  'plugins.installModal.catalogTeaser',
  'plugins.installModal.catalogTeaserSuffix',
  'plugins.installModal.tabCatalog',
  'plugins.installModal.tabUpload',
  'plugins.toasts.updateFailed',
];

test('webhooks.filters.badge: count=1 renders singular, count>1 renders plural (en)', () => {
  assert.equal(i18n.t('webhooks.filters.badge', { count: 1 }), '1 filter');
  assert.equal(i18n.t('webhooks.filters.badge', { count: 2 }), '2 filters');
  assert.equal(i18n.t('webhooks.filters.badge', { count: 5 }), '5 filters');
});

test('chats.unreadBadge: count=1 renders singular, count>1 renders plural (en)', () => {
  assert.equal(i18n.t('chats.unreadBadge', { count: 1 }), '1 unread message');
  assert.equal(i18n.t('chats.unreadBadge', { count: 3 }), '3 unread messages');
});

test('chats.channels.subscribers: count=1 renders singular, count>1 renders plural (en)', () => {
  assert.equal(i18n.t('chats.channels.subscribers', { count: 1 }), '1 subscriber');
  assert.equal(i18n.t('chats.channels.subscribers', { count: 4 }), '4 subscribers');
});

test('common.minAgo and common.hoursAgo agree with the count', () => {
  assert.equal(i18n.t('common.hoursAgo', { count: 1 }), '1 hour ago');
  assert.equal(i18n.t('common.hoursAgo', { count: 2 }), '2 hours ago');
  assert.equal(i18n.t('common.hoursAgo', { lng: 'fr', count: 1 }), 'Il y a 1 heure');
  assert.equal(i18n.t('common.hoursAgo', { lng: 'fr', count: 3 }), 'Il y a 3 heures');
  assert.equal(i18n.t('common.hoursAgo', { lng: 'he', count: 2 }), 'לפני שעתיים');
  // 'पहले' governs the oblique case, so Hindi keeps 'घंटे' for one hour too.
  assert.equal(i18n.t('common.hoursAgo', { lng: 'hi', count: 1 }), '1 घंटे पहले');
  assert.equal(i18n.t('common.minAgo', { lng: 'te', count: 5 }), '5 నిమిషాల క్రితం');
  assert.equal(i18n.t('common.minAgo', { lng: 'ar', count: 3 }), 'منذ 3 دقائق');
});

test('count badges resolve to a non-key, interpolated string in every locale', () => {
  for (const lng of LOCALE_IDS) {
    for (const key of [
      'webhooks.filters.badge',
      'chats.unreadBadge',
      'chats.channels.subscribers',
      'common.minAgo',
      'common.hoursAgo',
    ]) {
      for (const count of [1, 2]) {
        const value = i18n.t(key, { lng, count });
        assert.ok(value && !value.startsWith(key), `${lng} ${key} count=${count} did not resolve (got "${value}")`);
        assert.ok(
          // Hebrew/Arabic dual forms ("two filters") legitimately drop the numeral.
          value.includes(String(count)) || (['he', 'ar'].includes(lng) && count === 2),
          `${lng} ${key} count=${count} lost the count interpolation (got "${value}")`,
        );
      }
    }
  }
});

test('Hebrew dual + Arabic plural categories resolve for the filter badge', () => {
  assert.equal(i18n.t('webhooks.filters.badge', { lng: 'he', count: 2 }), 'שני מסננים');
  assert.equal(i18n.t('webhooks.filters.badge', { lng: 'he', count: 5 }), '5 מסננים');
  assert.equal(i18n.t('webhooks.filters.badge', { lng: 'ar', count: 3 }), '3 عوامل تصفية');
});

test('Arabic takes the singular noun from 100 up and the plural from 3 to 10', () => {
  assert.equal(i18n.t('chats.status.itemCount', { lng: 'ar', count: 100 }), '100 تحديث');
  assert.equal(i18n.t('chats.status.itemCount', { lng: 'ar', count: 3 }), '3 تحديثات');
});

test('every session-scope API key string resolves in every locale', () => {
  for (const lng of LOCALE_IDS) {
    for (const key of SESSION_SCOPE_KEYS) {
      const value = i18n.t(key, { lng, count: 2 });
      assert.ok(value && value !== key, `${lng}: ${key} missing from catalog (component would show a raw fallback)`);
    }
  }
});

test('English session-scope copy explains the empty-allowlist default', () => {
  assert.equal(i18n.t('apiKeys.sessions.all'), 'All sessions');
  assert.equal(i18n.t('apiKeys.sessions.choose'), 'Choose sessions');
  assert.equal(i18n.t('apiKeys.sessions.leaveAll'), 'Leave for all sessions');
  assert.match(i18n.t('apiKeys.sessions.restricted', { count: 3 }), /3/);
});

test('every new plugins.* key resolves in every locale', () => {
  for (const lng of LOCALE_IDS) {
    for (const key of NEW_PLUGIN_KEYS) {
      const value = i18n.t(key, { lng });
      assert.ok(value && value !== key, `${lng}: ${key} missing from catalog (component would show a raw fallback)`);
    }
  }
});

test('new plugins.* keys carry the expected English copy', () => {
  assert.equal(i18n.t('plugins.installModal.tabCatalog'), 'Catalog');
  assert.equal(i18n.t('plugins.installModal.tabUpload'), 'Upload .zip');
  assert.equal(i18n.t('plugins.catalog.installed'), 'Installed');
  assert.equal(i18n.t('plugins.toasts.updateFailed'), 'Update failed');
});

// Mirrors the `status` and `type` unions on `Plugin` in services/api.ts. The plugin card renders
// both through these keys; a missing one falls back to the raw English value.
const PLUGIN_STATUSES = ['installed', 'enabled', 'disabled', 'error'];
const PLUGIN_TYPES = ['engine', 'storage', 'queue', 'auth', 'extension'];

test('every plugin status and type label resolves in every locale', () => {
  for (const lng of LOCALE_IDS) {
    for (const [group, values] of [
      ['statuses', PLUGIN_STATUSES],
      ['types', PLUGIN_TYPES],
    ] as const) {
      for (const value of values) {
        const key = `plugins.${group}.${value}`;
        const label = i18n.t(key, { lng });
        assert.ok(
          label && label !== key && label !== value,
          `${lng}: ${key} missing, card would render raw "${value}"`,
        );
      }
    }
  }
  assert.equal(i18n.t('plugins.statuses.installed'), 'Installed');
  assert.equal(i18n.t('plugins.types.extension'), 'Extension');
});

test('sessionStatus.failed and sessionStatus.authenticating resolve in every locale', () => {
  for (const lng of LOCALE_IDS) {
    for (const status of ['failed', 'authenticating']) {
      const key = `sessionStatus.${status}`;
      const value = i18n.t(key, { lng });
      assert.ok(
        value && value !== key && value !== status,
        `${lng}: ${key} missing — status pill would render raw "${status}"`,
      );
    }
  }
  assert.equal(i18n.t('sessionStatus.failed'), 'Failed');
  assert.equal(i18n.t('sessionStatus.authenticating'), 'Authenticating...');
});

// ── Session lifecycle reconciliation keys (renamed unconfirmed* → incomplete* + new start keys) ──
// A missing key would render the raw key to the operator; these are driven directly by Sessions.tsx.

const LIFECYCLE_KEYS = [
  'sessions.unlink.success',
  'sessions.unlink.successTitle',
  'sessions.unlink.incomplete',
  'sessions.unlink.incompleteTitle',
  'sessions.unlink.failed',
  'sessions.unlink.failedTitle',
  'sessions.start.teardownPending',
  'sessions.start.teardownPendingTitle',
];

test('every session lifecycle key resolves in every locale', () => {
  for (const lng of LOCALE_IDS) {
    for (const key of LIFECYCLE_KEYS) {
      const value = i18n.t(key, { lng });
      assert.ok(value && value !== key, `${lng}: ${key} missing (component would render a raw key)`);
    }
  }
});

test('the old unconfirmed* locale keys are gone from every locale', () => {
  for (const lng of LOCALE_IDS) {
    for (const key of ['sessions.unlink.unconfirmed', 'sessions.unlink.unconfirmedTitle']) {
      // With fallbackLng disabled, a present key resolves to its value while a removed key renders
      // the raw key string back out — which is what a stale locale file would surface too.
      const value = i18n.t(key, { lng });
      assert.equal(value, key, `${lng}: stale ${key} still present`);
    }
  }
});

test('the page source no longer references any old unconfirmed* locale key', () => {
  for (const key of ['sessions.unlink.unconfirmedTitle', 'sessions.unlink.unconfirmed']) {
    assert.ok(
      !SESSIONS_PAGE_SOURCE.includes(`t('${key}')`) && !SESSIONS_PAGE_SOURCE.includes(`t("${key}")`),
      `Sessions.tsx still references renamed key ${key}`,
    );
  }
});

// The success copy must NOT claim the dashboard observes the handset's Linked Devices — Task 7's 200
// contract is "unlink operation + local cleanup completed", not an independent handset observation.
test('English unlink success/incomplete copy does not claim handset Linked-Devices observation', () => {
  const success = i18n.t('sessions.unlink.success', { lng: 'en' });
  assert.ok(!/Linked Devices/i.test(success), `success copy claims handset observation: "${success}"`);
  assert.ok(!/removed the device from/i.test(success), `success copy claims handset removal: "${success}"`);
  // The incomplete copy may still mention "linked" as a *possibility* (the device may still be linked),
  // which is accurate — only the SUCCESS copy must not assert it as observed.
  const incomplete = i18n.t('sessions.unlink.incomplete', { lng: 'en' });
  assert.ok(/incomplete/i.test(incomplete), `incomplete copy lost the "incomplete" framing: "${incomplete}"`);
});

// The data export drops webhook secrets and headers and strips proxy userinfo, but carries
// integration instance secrets as-is (src/modules/infra/export-tables.ts). The hint must say which.
test('English backup hint says which credentials the export leaves out and which it carries', () => {
  const hint = i18n.t('infrastructure.migration.backupHint', { lng: 'en' });
  assert.ok(!/contains webhook secrets/i.test(hint), `hint claims webhook secrets are exported: "${hint}"`);
  assert.ok(/webhook signing secrets[^.]*not included/i.test(hint), `hint lost the webhook omission: "${hint}"`);
  assert.ok(
    /integration instance secrets[^.]*included in plaintext/i.test(hint),
    `hint lost the plaintext note: "${hint}"`,
  );
});

test('English start teardown-pending copy is a retryable warning, not an error', () => {
  const title = i18n.t('sessions.start.teardownPendingTitle', { lng: 'en' });
  const body = i18n.t('sessions.start.teardownPending', { lng: 'en' });
  assert.ok(/try again/i.test(body), `teardown-pending copy lost the retry guidance: "${body}"`);
  assert.ok(title && title !== 'sessions.start.teardownPendingTitle');
});

// A locale JSON file is only reachable in the UI once it is wired into index.ts. The catalogues are
// loaded by a dynamic import whose specifier is built from the language id, which reaches every file
// in the directory at once, so what is left to get wrong by hand is the pair of lists: a locale
// absent from `supportedLanguages` is refused by i18next, and one absent from `languageOptions`
// cannot be picked. `check-i18n-parity.mjs` scans the locales DIRECTORY and never opens index.ts, so
// a fully translated catalogue can pass that gate while being unreachable. Read index.ts as text
// (the same technique this file already uses for Sessions.tsx) rather than importing it, which would
// pull in `i18next-browser-languagedetector` and `document`; `lazy-locales.test.ts` is where the
// module is imported for real, under JSDOM, to exercise what it does at runtime.
const I18N_INDEX_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');

const section = (start: string, source = I18N_INDEX_SOURCE): string => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `index.ts no longer contains "${start}" — update this test's anchors`);
  const end = source.indexOf('];', from);
  assert.notEqual(end, -1, `could not find the end of "${start}" in index.ts`);
  return source.slice(from, end);
};

// Permissive on purpose: matches 'pt-BR' and "zh-CN" alike so a Prettier reflow or a quote-style
// change cannot break the assertion.
const localeIdsIn = (text: string): string[] => [
  ...new Set([...text.matchAll(/['"]([a-z]{2}(?:-[A-Za-z]{2,4})?)['"]/g)].map(m => m[1])),
];

test('every locale file is registered in both hand-maintained index.ts sites', () => {
  const registrations: Array<[string, string[]]> = [
    ['supportedLanguages', localeIdsIn(section('export const supportedLanguages = ['))],
    ['languageOptions', localeIdsIn(section('export const languageOptions:'))],
  ];

  for (const [site, found] of registrations) {
    assert.deepEqual(
      [...found].sort(),
      LOCALE_IDS,
      `${site} in index.ts does not match the locale files on disk — a locale here is unreachable in the UI`,
    );
  }
});

// The variable dynamic import is the third registration site, and the only one that covers a new
// locale file for free. It is also what makes the build split one chunk per language: Vite can only
// do that while the directory and the extension around the variable stay literal, so a specifier
// assembled further up would quietly stop splitting while still loading correctly in dev.
test('the locale loader imports the whole locales directory by variable', () => {
  assert.match(
    I18N_INDEX_SOURCE,
    /import\(\s*`\.\/locales\/\$\{\s*\w+\s*\}\.json`\s*\)/,
    'index.ts no longer loads locales through a variable dynamic import over ./locales/*.json',
  );
});

// Every catalogue used to be imported statically, which put all of them in one chunk the page
// preloaded to read a single language. A reinstated import would restore that quietly: the build
// stays green, the parity gates stay green, and only the byte count moves.
//
// Scanned across the whole source tree rather than index.ts alone, because the bundler does not care
// which module reaches a catalogue eagerly — one static import anywhere on a path the entry can
// follow pulls that JSON back into a preloaded chunk. Matching `from '…'` covers default, named,
// namespace and re-export forms including the ones Prettier wraps onto a second line, and bare
// `import '…'` covers the side-effect form. Requiring whitespace after the keyword is what excludes
// the loader's own `import(` — that one is a call, with a template literal rather than a quote.
// Test files are exempt: they are outside the app build, so a catalogue they import eagerly costs
// the bundle nothing.
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_LOCALE_IMPORT = /(?:^|[\s{,])(?:from|import)\s+['"][^'"]*locales\/[^'"]*\.json['"]/;

test('no locale catalogue is imported statically, anywhere in the dashboard source', () => {
  const offenders = readdirSync(SRC_DIR, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts'))
    .map(entry => join(entry.parentPath, entry.name))
    .filter(file => STATIC_LOCALE_IMPORT.test(readFileSync(file, 'utf8')))
    .map(file => file.slice(SRC_DIR.length + 1))
    .sort();

  assert.deepEqual(offenders, [], 'a static locale import is back — those languages are on the critical path again');
});

// rtlLanguages is deliberately a SUBSET (only he/ar today), so it is checked for validity, not parity:
// an id here that is not a shipped locale would set dir="rtl" for a language that cannot be selected.
test('rtlLanguages only names shipped locales', () => {
  const rtl = localeIdsIn(section('export const rtlLanguages:'));
  assert.ok(rtl.length > 0, 'rtlLanguages parsed as empty — the anchor or the pattern has drifted');
  for (const id of rtl) assert.ok(LOCALE_IDS.includes(id), `rtlLanguages names "${id}", which has no locale file`);
});

// The parity checker flags a value identical to English only from 20 characters up, so a short label
// left in English passes it. These pin the ones that sit next to translated text on a translated screen.
const NON_EN_LOCALES = LOCALE_IDS.filter(id => id !== 'en');

test('the proxy modal Save button is translated in every locale', () => {
  for (const lng of NON_EN_LOCALES) {
    assert.notEqual(i18n.t('common.save', { lng }), 'Save', `${lng} common.save is still English`);
  }
});

test('the session proxy button uses the same script as the modal title it opens', () => {
  const latin = /[A-Za-z]/;
  for (const lng of LOCALE_IDS) {
    // Latin-script locales, and he, whose title writes "proxy" too, keep the Latin term.
    if (latin.test(i18n.t('sessions.proxy.title', { lng }))) continue;
    const label = i18n.t('sessions.actions.proxy', { lng });
    assert.ok(!latin.test(label), `${lng} sessions.actions.proxy is "${label}", the modal title is translated`);
  }
});

test('the webhook filter chat-kind field is translated in every locale', () => {
  for (const lng of NON_EN_LOCALES) {
    const label = i18n.t('webhooks.filters.fields.kind', { lng });
    assert.notEqual(label, 'Chat kind', `${lng} webhooks.filters.fields.kind is still English`);
  }
});

test('the Templates nav item reads the same as the page it opens in every locale', () => {
  for (const lng of LOCALE_IDS) {
    assert.equal(i18n.t('nav.templates', { lng }), i18n.t('templates.title', { lng }), `${lng} nav.templates`);
  }
});
