import { validatePluginManifest, RESERVED_PLUGIN_IDS, INSTALLABLE_TYPES } from './plugin-manifest';

/**
 * The shared manifest contract enforced identically at install time (parsePluginPackage) and at
 * boot time (PluginLoaderService.loadPlugin): a plugin that could never be installed must never be
 * boot-loaded from a hand-placed directory either.
 */
describe('validatePluginManifest', () => {
  const valid = { id: 'my-plg', name: 'My Plugin', version: '1.0.0', type: 'extension', main: 'index.js' };

  it('accepts a valid manifest', () => {
    expect(() => validatePluginManifest({ ...valid })).not.toThrow();
  });

  it('rejects a non-object manifest (null / array / scalar)', () => {
    for (const body of [null, [], 'x', 5, true]) {
      expect(() => validatePluginManifest(body)).toThrow(/must be a JSON object/i);
    }
  });

  it('rejects a missing required field', () => {
    const bad = { ...valid, main: undefined } as unknown;
    expect(() => validatePluginManifest(bad)).toThrow(/required field: main/i);
  });

  it('rejects a non-string required field (numeric main)', () => {
    expect(() => validatePluginManifest({ ...valid, main: 123 })).toThrow(/invalid required field/i);
  });

  it('rejects an unsafe plugin id', () => {
    expect(() => validatePluginManifest({ ...valid, id: '../evil' })).toThrow(/invalid plugin id/i);
    expect(() => validatePluginManifest({ ...valid, id: 'has space' })).toThrow(/invalid plugin id/i);
  });

  it('rejects a reserved id, case-insensitively', () => {
    for (const id of RESERVED_PLUGIN_IDS) {
      expect(() => validatePluginManifest({ ...valid, id })).toThrow(/reserved/i);
    }
    expect(() => validatePluginManifest({ ...valid, id: 'Auto-Reply' })).toThrow(/reserved/i);
  });

  it('rejects a non-installable type (engines and unknown tiers alike)', () => {
    for (const type of ['engine', 'storage', 'wormhole']) {
      expect(() => validatePluginManifest({ ...valid, id: `plg-${type}`, type })).toThrow(/not installable/i);
    }
    expect(INSTALLABLE_TYPES.has('extension')).toBe(true);
  });

  it('rejects a main that escapes the plugin directory', () => {
    for (const main of ['../evil.js', '../../etc/passwd', '..', '/etc/passwd', 'a/../../b.js', '..\\evil.js']) {
      expect(() => validatePluginManifest({ ...valid, main })).toThrow(/escapes the plugin directory/i);
    }
  });

  it('accepts nested and dot-relative mains inside the plugin directory', () => {
    expect(() => validatePluginManifest({ ...valid, main: 'dist/main.js' })).not.toThrow();
    expect(() => validatePluginManifest({ ...valid, main: './index.js' })).not.toThrow();
    expect(() => validatePluginManifest({ ...valid, main: 'dist/../index.js' })).not.toThrow();
  });
});
