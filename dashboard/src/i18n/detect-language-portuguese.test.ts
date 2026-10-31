// First-visit detection for Portuguese outside Brazil. The browser's preference list is read once, while the module
// initializes, so this lives in its own file (see detect-language.test.ts).
import '../test-helpers/register-hooks.ts';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';

type I18nModule = typeof import('./index.ts');

let i18n: I18nModule['default'];
let resolveSupportedLanguage: I18nModule['resolveSupportedLanguage'];

before(async () => {
  const { installJsdomGlobals } = (await import('../test-helpers/jsdom.ts')) as {
    installJsdomGlobals: typeof installJsdomGlobalsFn;
  };
  await installJsdomGlobals();
  Object.defineProperty(navigator, 'languages', { value: ['pt-PT', 'pt', 'en-US'], configurable: true });
  const module = (await import('./index.ts')) as I18nModule;
  i18n = module.default;
  resolveSupportedLanguage = module.resolveSupportedLanguage;
  await module.i18nReady;
});

test('a Portuguese visitor outside Brazil gets the Portuguese catalogue, not English', () => {
  assert.equal(i18n.language, 'pt-BR');
  assert.equal(localStorage.getItem('openwa_language'), 'pt-BR');
});

test('every Portuguese tag resolves to the one Portuguese catalogue', () => {
  for (const tag of ['pt', 'pt-PT', 'pt-pt', 'pt-AO', 'pt-BR', 'PT-br']) {
    assert.equal(resolveSupportedLanguage(tag), 'pt-BR', tag);
  }
});
