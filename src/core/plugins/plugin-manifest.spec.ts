import {
  dropMalformedConfigFields,
  validatePluginManifest,
  RESERVED_PLUGIN_IDS,
  INSTALLABLE_TYPES,
} from './plugin-manifest';

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

  it('rejects a list field that is not an array of strings', () => {
    // `.includes` also works on a string, so `sessions: 'sales-team'` would match session 'sales'.
    for (const field of ['permissions', 'sessions', 'hooks']) {
      for (const value of ['sales-team', [1], {}]) {
        expect(() => validatePluginManifest({ ...valid, [field]: value })).toThrow(
          `manifest.json ${field} must be an array of strings`,
        );
      }
    }
    expect(() => validatePluginManifest({ ...valid, net: { allow: 'api.example.com' } })).toThrow(
      'manifest.json net.allow must be an array of strings',
    );
    expect(() => validatePluginManifest({ ...valid, net: { allowConfigHosts: 'baseUrl' } })).toThrow(
      'manifest.json net.allowConfigHosts must be an array of strings',
    );
    expect(() => validatePluginManifest({ ...valid, net: ['api.example.com'] })).toThrow(
      'manifest.json net must be an object',
    );
  });

  it('accepts absent, null or string-array list fields', () => {
    expect(() =>
      validatePluginManifest({
        ...valid,
        permissions: ['net:fetch'],
        sessions: null,
        hooks: [],
        net: { allow: ['api.example.com'], allowConfigHosts: null },
      }),
    ).not.toThrow();
    expect(() => validatePluginManifest({ ...valid, net: null })).not.toThrow();
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

  describe('minOpenWAVersion', () => {
    const host = '0.23.7';

    it('accepts an absent or null floor', () => {
      expect(() => validatePluginManifest({ ...valid }, host)).not.toThrow();
      expect(() => validatePluginManifest({ ...valid, minOpenWAVersion: null }, host)).not.toThrow();
    });

    it('accepts a floor at or below the running host', () => {
      for (const min of ['0.23.7', '0.8.16', '0.0.1']) {
        expect(() => validatePluginManifest({ ...valid, minOpenWAVersion: min }, host)).not.toThrow();
      }
    });

    it('rejects a floor above the running host, naming both versions', () => {
      expect(() => validatePluginManifest({ ...valid, minOpenWAVersion: '0.24.0' }, host)).toThrow(
        /my-plg requires OpenWA >= 0\.24\.0 \(running 0\.23\.7\)/,
      );
    });

    it('rejects a malformed floor instead of reading it as 0.0.0', () => {
      for (const min of ['v1.0.0', '1.2', 'garbage', 5, '']) {
        expect(() => validatePluginManifest({ ...valid, minOpenWAVersion: min }, host)).toThrow(/minOpenWAVersion/);
      }
    });

    it('lets a prerelease host satisfy its own release floor', () => {
      expect(() => validatePluginManifest({ ...valid, minOpenWAVersion: '0.24.0' }, '0.24.0-rc.1')).not.toThrow();
    });

    it('checks against the running package version by default', () => {
      expect(() => validatePluginManifest({ ...valid, minOpenWAVersion: '0.0.1' })).not.toThrow();
      expect(() => validatePluginManifest({ ...valid, minOpenWAVersion: '999.0.0' })).toThrow(/requires OpenWA/);
    });
  });
});

describe('dropMalformedConfigFields', () => {
  it('drops a property or an items entry that is not a field object, at any depth', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
        gone: null,
        word: 'text',
        list: [],
        outer: { type: 'object', properties: { key: { type: 'string', secret: true }, inner: 5 } },
        rows: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, bad: null } } },
        tags: { type: 'array', items: null },
        odd: { type: 'object', properties: 'none' },
      },
    };

    dropMalformedConfigFields(schema);

    expect(schema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
        outer: { type: 'object', properties: { key: { type: 'string', secret: true } } },
        rows: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' } } } },
        tags: { type: 'array' },
        odd: { type: 'object' },
      },
    });
  });

  it('leaves a well-formed schema as it is and ignores an absent or non-object schema', () => {
    const schema = { type: 'object', properties: { url: { type: 'string', default: 'https://a.example' } } };
    const copy = structuredClone(schema);

    dropMalformedConfigFields(schema);
    for (const value of [undefined, null, 'x', []]) dropMalformedConfigFields(value);

    expect(schema).toEqual(copy);
  });
});
