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

test('count badges resolve to a non-key, interpolated string in every locale', () => {
  for (const lng of LOCALE_IDS) {
    for (const key of ['webhooks.filters.badge', 'chats.unreadBadge', 'chats.channels.subscribers']) {
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

test('English start teardown-pending copy is a retryable warning, not an error', () => {
  const title = i18n.t('sessions.start.teardownPendingTitle', { lng: 'en' });
  const body = i18n.t('sessions.start.teardownPending', { lng: 'en' });
  assert.ok(/try again/i.test(body), `teardown-pending copy lost the retry guidance: "${body}"`);
  assert.ok(title && title !== 'sessions.start.teardownPendingTitle');
});
