import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import i18next from 'i18next';

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
      assert.ok(value && value !== key && value !== status, `${lng}: ${key} missing — status pill would render raw "${status}"`);
    }
  }
  assert.equal(i18n.t('sessionStatus.failed'), 'Failed');
  assert.equal(i18n.t('sessionStatus.authenticating'), 'Authenticating...');
});
