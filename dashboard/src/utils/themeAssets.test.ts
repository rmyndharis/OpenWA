import assert from 'node:assert/strict';
import { test } from 'node:test';
import { darkThemeLogoUrl, lightThemeLogoUrl, resolveThemeLogoUrl } from './themeAssets.ts';

test('selects the logo that matches an explicit theme', () => {
  assert.equal(resolveThemeLogoUrl('light', true), lightThemeLogoUrl);
  assert.equal(resolveThemeLogoUrl('dark', false), darkThemeLogoUrl);
});

test('selects the logo from the operating system preference in system mode', () => {
  assert.equal(resolveThemeLogoUrl('system', false), lightThemeLogoUrl);
  assert.equal(resolveThemeLogoUrl('system', true), darkThemeLogoUrl);
});
