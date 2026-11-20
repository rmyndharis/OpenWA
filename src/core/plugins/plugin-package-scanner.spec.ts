import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../common/services/logger.service';
import { PluginStorageService } from './plugin-storage.service';
import { PluginPackageScanner } from './plugin-package-scanner';
import { PluginInstance, PluginStatus } from './plugin.interfaces';

/**
 * The boot-scan job, on the collaborator that owns it since the loader split. Construction only is
 * adapted from the loader-level specs these tests moved from — every assertion is unchanged: the
 * scanner shares the loader's registry Map by reference, so reads on `plugins` are the same reads
 * `loader.getPlugin` used to make.
 */
const bootScanner = (config: ConfigService, storage: PluginStorageService, pluginsDir: string) => {
  const plugins = new Map<string, PluginInstance>();
  const scanner = new PluginPackageScanner(
    createLogger('PluginLoaderService'),
    config,
    storage,
    pluginsDir,
    null,
    plugins,
  );
  return { scanner, plugins };
};

describe('PluginPackageScanner — skips dot-prefixed directories on load (crash-leftover .bak)', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let scanner: PluginPackageScanner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-dotskip-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    ({ scanner } = bootScanner(config, new PluginStorageService(config), pluginsDir));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const writePlugin = (dirName: string, id: string): void => {
    const dir = path.join(pluginsDir, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id, name: id, version: '1.0.0', type: 'extension', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
  };

  it('does not scan a crash-leftover .<id>.bak directory (no duplicate-id load race)', () => {
    writePlugin('svc-plg', 'svc-plg');
    writePlugin('.svc-plg.bak', 'svc-plg'); // a leftover update backup carrying the SAME manifest id

    const loadSpy = jest.spyOn(scanner, 'loadPlugin');
    scanner.scanAtBoot();

    const scanned = loadSpy.mock.calls.map(c => c[0]);
    expect(scanned).toContain(path.join(pluginsDir, 'svc-plg'));
    expect(scanned).not.toContain(path.join(pluginsDir, '.svc-plg.bak'));
  });
});

describe('PluginPackageScanner — prunes registry ghosts of removed built-ins', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let scanner: PluginPackageScanner;
  let storage: PluginStorageService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-ghosts-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    storage = new PluginStorageService(config);
    ({ scanner } = bootScanner(config, storage, pluginsDir));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const seedGhost = (id: string): void => {
    // A leftover directory with no manifest (code deleted) + a stale registry entry still claiming
    // the plugin is installed — the ghost state upgrades from <=0.6 are in.
    fs.mkdirSync(path.join(pluginsDir, id), { recursive: true });
    storage.setPluginEntry({
      id,
      type: 'extension',
      name: id,
      version: '1.0.0',
      status: 'installed',
      config: {},
      builtIn: true,
      installedAt: new Date(),
      updatedAt: new Date(),
    } as never);
  };

  it('prunes registry entries of legacy removed built-ins (auto-reply, translation) with no manifest', () => {
    seedGhost('auto-reply');
    seedGhost('translation');

    scanner.scanAtBoot();

    expect(storage.getPluginEntry('auto-reply')).toBeUndefined();
    expect(storage.getPluginEntry('translation')).toBeUndefined();
  });

  it('keeps a manifest-less NON-legacy plugin entry (config survives an unreadable dir)', () => {
    seedGhost('some-other-plugin');

    scanner.scanAtBoot();

    expect(storage.getPluginEntry('some-other-plugin')).toBeDefined();
  });
});

describe('PluginPackageScanner — boot reconciles the registry entry of a plugin it drops', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let storage: PluginStorageService;

  const config = () =>
    ({
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    }) as unknown as ConfigService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-drop-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    storage = new PluginStorageService(config());
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const writePlugin = (id: string, manifest: Record<string, unknown>): void => {
    const dir = path.join(pluginsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
  };

  it('marks the persisted entry ERROR when boot-time manifest validation drops a previously-installed plugin', () => {
    // Boot 1: a valid hand-placed plugin loads and gets its registry entry.
    writePlugin('hand-placed', {
      id: 'hand-placed',
      name: 'Hand',
      version: '1.0.0',
      type: 'extension',
      main: 'index.js',
    });
    bootScanner(config(), storage, pluginsDir).scanner.scanAtBoot();
    expect(storage.getPluginEntry('hand-placed')?.status).toBe(PluginStatus.INSTALLED);
    // The operator's config + standing enable decision live in that entry.
    storage.setPluginConfig('hand-placed', { apiKey: 'keep-me' });
    storage.setPluginEnabledByOperator('hand-placed', true);

    // Boot 2: the manifest was hand-edited into something the installer would have rejected
    // (missing required field) — the plugin is dropped from the runtime...
    writePlugin('hand-placed', { id: 'hand-placed', name: 'Hand', type: 'extension', main: 'index.js' });
    const second = bootScanner(config(), storage, pluginsDir);
    second.scanner.scanAtBoot();
    expect(second.plugins.get('hand-placed')).toBeUndefined();

    // ...and the registry no longer claims it installed. The entry itself (config,
    // enabledByOperator) survives, so fixing the manifest and rebooting re-enables it.
    const entry = storage.getPluginEntry('hand-placed');
    expect(entry?.status).toBe(PluginStatus.ERROR);
    expect(entry?.config).toEqual({ apiKey: 'keep-me' });
    expect(entry?.enabledByOperator).toBe(true);
  });

  it('a hand-placed plugin that fails validation without a registry entry simply does not load', () => {
    writePlugin('never-installed', { id: 'never-installed', name: 'Nope', type: 'extension', main: 'index.js' });

    const { scanner, plugins } = bootScanner(config(), storage, pluginsDir);
    scanner.scanAtBoot();

    expect(plugins.get('never-installed')).toBeUndefined();
    // No entry existed, so the ERROR reconciliation is a no-op — none is invented either.
    expect(storage.getPluginEntry('never-installed')).toBeUndefined();
  });
});

describe('PluginPackageScanner — loadPlugin seeds configSchema defaults', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let scanner: PluginPackageScanner;
  let storage: PluginStorageService;
  let plugins: Map<string, PluginInstance>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-seed-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    storage = new PluginStorageService(config);
    ({ scanner, plugins } = bootScanner(config, storage, pluginsDir));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('seeds defaults into the runtime instance and the persisted registry entry at load', () => {
    const dir = path.join(pluginsDir, 'seeded-plg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'seeded-plg',
        name: 'seeded-plg',
        version: '1.0.0',
        type: 'extension',
        main: 'index.js',
        configSchema: {
          type: 'object',
          properties: { timezone: { type: 'string', default: 'UTC' } },
        },
      }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');

    scanner.scanAtBoot();

    expect(plugins.get('seeded-plg')?.config).toEqual({ timezone: 'UTC' });
    expect(storage.getPluginEntry('seeded-plg')?.config).toEqual({ timezone: 'UTC' });
  });
});

describe('PluginPackageScanner — boot-time manifest validation parity with install', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let scanner: PluginPackageScanner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-bootval-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    ({ scanner } = bootScanner(config, new PluginStorageService(config), pluginsDir));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const writePlugin = (id: string, manifest: unknown, withMain = true): string => {
    const dir = path.join(pluginsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    );
    if (withMain) fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
    return dir;
  };
  const baseManifest = (id: string): Record<string, unknown> => ({
    id,
    name: id,
    version: '1.0.0',
    type: 'extension',
    main: 'index.js',
  });

  it('rejects the same invalid manifests install rejects (fields, id, reserved, type)', () => {
    // Missing a required field.
    const noName = baseManifest('no-name');
    delete noName.name;
    expect(() => scanner.loadPlugin(writePlugin('no-name', noName))).toThrow(/required field: name/i);
    // A non-string required field (truthy — passed the old bare falsy check).
    expect(() => scanner.loadPlugin(writePlugin('num-main', { ...baseManifest('num-main'), main: 123 }))).toThrow(
      /invalid required field/i,
    );
    // Unsafe id.
    expect(() => scanner.loadPlugin(writePlugin('bad id', { ...baseManifest('bad id'), id: 'bad id' }))).toThrow(
      /invalid plugin id/i,
    );
    // Reserved built-in id (would shadow the baileys engine).
    expect(() => scanner.loadPlugin(writePlugin('baileys', baseManifest('baileys')))).toThrow(/reserved/i);
    // A non-extension tier (engines are built-in, never directory-loadable).
    expect(() => scanner.loadPlugin(writePlugin('my-eng', { ...baseManifest('my-eng'), type: 'engine' }))).toThrow(
      /not installable/i,
    );
    // A non-object manifest document.
    expect(() => scanner.loadPlugin(writePlugin('arr-plg', '[]'))).toThrow(/must be a JSON object/i);
  });

  it('rejects a manifest whose main escapes the plugin directory', () => {
    const dir = writePlugin('trav-plg', { ...baseManifest('trav-plg'), main: '../other/evil.js' });
    expect(() => scanner.loadPlugin(dir)).toThrow(/escapes the plugin directory/i);
  });

  it('rejects a manifest whose main file is missing from the directory', () => {
    const dir = writePlugin('gone-main', { ...baseManifest('gone-main'), main: 'gone.js' });
    expect(() => scanner.loadPlugin(dir)).toThrow(/main file not found/i);
  });

  it('rejects a plugin that declares ingress routes but omits the webhook:ingress permission', () => {
    // loadPlugin must run validateIngressManifest, so a malformed ingress declaration fails to load
    // rather than silently loading and becoming provisionable.
    const dir = writePlugin('bad-ingress', {
      ...baseManifest('bad-ingress'),
      ingress: [{ route: 'events', signature: { headerName: 'X-Sig', scheme: 'hmac-sha256' } }],
      // permissions intentionally omitted → validateIngressManifest must reject
    });
    expect(() => scanner.loadPlugin(dir)).toThrow(/webhook:ingress/i);
  });

  it('names the field when ingress is not a list or an hmac contentTemplate is not a string', () => {
    // These used to fail inside a load-time warning, with an engine message such as "object is not iterable".
    const permissions = ['webhook:ingress'];
    const route = { route: 'events', signature: { scheme: 'hmac-sha256', header: 'X-Sig', contentTemplate: 5 } };
    expect(() =>
      scanner.loadPlugin(writePlugin('one-route', { ...baseManifest('one-route'), permissions, ingress: route })),
    ).toThrow('Plugin one-route: ingress must be a list of routes');
    expect(() =>
      scanner.loadPlugin(writePlugin('true-ingress', { ...baseManifest('true-ingress'), permissions, ingress: true })),
    ).toThrow('Plugin true-ingress: ingress must be a list of routes');
    expect(() =>
      scanner.loadPlugin(
        writePlugin('number-template', { ...baseManifest('number-template'), permissions, ingress: [route] }),
      ),
    ).toThrow("Plugin number-template: route 'events' signature.contentTemplate must be a string");
  });
});

describe('PluginPackageScanner — interrupted-update recovery at boot', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let scanner: PluginPackageScanner;
  let plugins: Map<string, PluginInstance>;
  let storage: PluginStorageService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-uprec-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    storage = new PluginStorageService(config);
    ({ scanner, plugins } = bootScanner(config, storage, pluginsDir));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const writePluginTree = (dirName: string, id: string, version = '1.0.0'): void => {
    const dir = path.join(pluginsDir, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id, name: id, version, type: 'extension', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
  };

  it('restores the backup as the live dir when a crash mid-swap lost the live dir', () => {
    // Crash between `rename(live → backup)` and `rename(staging → live)`: the live dir is gone, the
    // backup holds the previous version, and staging never landed.
    writePluginTree('.svc-plg.bak', 'svc-plg');
    writePluginTree('.svc-plg.new', 'svc-plg', '2.0.0');

    scanner.scanAtBoot();

    // The previous version is back as the live dir and loads normally — the plugin no longer
    // silently vanishes while its registry entry still claims it is installed.
    expect(plugins.get('svc-plg')?.manifest.version).toBe('1.0.0');
    expect(fs.existsSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false);
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.new'))).toBe(false);
  });

  it('drops a stale backup when the live dir exists (crash after the swap completed)', () => {
    writePluginTree('svc-plg', 'svc-plg', '2.0.0'); // the swapped-in new version
    writePluginTree('.svc-plg.bak', 'svc-plg'); // leftover backup of the old one

    scanner.scanAtBoot();

    expect(plugins.get('svc-plg')?.manifest.version).toBe('2.0.0');
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false);
  });

  it('drops a stale staging tree (crash before the swap ever started)', () => {
    writePluginTree('svc-plg', 'svc-plg');
    writePluginTree('.svc-plg.new', 'svc-plg', '2.0.0');

    scanner.scanAtBoot();

    expect(plugins.get('svc-plg')?.manifest.version).toBe('1.0.0');
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.new'))).toBe(false);
  });

  it('leaves an unrelated dot-prefixed directory alone', () => {
    writePluginTree('svc-plg', 'svc-plg');
    fs.mkdirSync(path.join(pluginsDir, '.gitkeep.d'), { recursive: true });

    scanner.scanAtBoot();

    expect(fs.existsSync(path.join(pluginsDir, '.gitkeep.d'))).toBe(true);
    expect(plugins.get('svc-plg')).toBeDefined();
  });

  // The dot-name alone does not make a directory an update leftover: an operator can keep a `.cache.bak` of their own
  // in this directory, and it was renamed to `cache` (no live directory) or deleted (one beside it) at boot.
  it.each([
    ['a backup with no live directory', ['.cache.bak']],
    ['a backup beside a directory of the same name', ['.cache.bak', 'cache']],
    ['a staging directory', ['.cache.new']],
    ['a staging directory beside a directory of the same name', ['.cache.new', 'cache']],
  ])('leaves %s alone when it holds no plugin', (_label, names) => {
    for (const name of names) {
      fs.mkdirSync(path.join(pluginsDir, name));
      fs.writeFileSync(path.join(pluginsDir, name, 'notes.txt'), name);
    }

    scanner.scanAtBoot();

    expect(fs.readdirSync(pluginsDir).sort()).toEqual([...names].sort());
    for (const name of names) expect(fs.readFileSync(path.join(pluginsDir, name, 'notes.txt'), 'utf8')).toBe(name);
  });

  // A crash while the package is being staged can leave a tree that has not got to its manifest.json. The registry
  // entry of an installed plugin vouches for its staging name; a directory of that shape for no installed plugin
  // is the `.cache.new` case above.
  it('drops a staging tree cut short before its manifest was written, for an installed plugin', () => {
    writePluginTree('svc-plg', 'svc-plg');
    fs.mkdirSync(path.join(pluginsDir, '.svc-plg.new'));
    fs.writeFileSync(path.join(pluginsDir, '.svc-plg.new', 'index.js'), 'module.exports = class {};');
    storage.setPluginEntry({
      id: 'svc-plg',
      type: 'extension',
      name: 'svc-plg',
      version: '1.0.0',
      status: PluginStatus.INSTALLED,
      config: {},
      builtIn: false,
      installedAt: new Date(),
      updatedAt: new Date(),
    } as never);

    scanner.scanAtBoot();

    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.new'))).toBe(false);
    expect(plugins.get('svc-plg')?.manifest.version).toBe('1.0.0');
  });

  it('does not let the registry vouch for a backup that holds no manifest', () => {
    fs.mkdirSync(path.join(pluginsDir, '.svc-plg.bak'));
    fs.writeFileSync(path.join(pluginsDir, '.svc-plg.bak', 'notes.txt'), 'operator data');
    storage.setPluginEntry({
      id: 'svc-plg',
      type: 'extension',
      name: 'svc-plg',
      version: '1.0.0',
      status: PluginStatus.INSTALLED,
      config: {},
      builtIn: false,
      installedAt: new Date(),
      updatedAt: new Date(),
    } as never);

    scanner.scanAtBoot();

    expect(fs.readFileSync(path.join(pluginsDir, '.svc-plg.bak', 'notes.txt'), 'utf8')).toBe('operator data');
    expect(fs.existsSync(path.join(pluginsDir, 'svc-plg'))).toBe(false);
  });

  it('leaves a leftover alone when the plugin its manifest names is another one', () => {
    writePluginTree('svc-plg', 'svc-plg');
    writePluginTree('.svc-plg.bak', 'someone-else'); // a copy of a different plugin
    writePluginTree('.svc-plg.new', 'someone-else', '2.0.0');

    scanner.scanAtBoot();

    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.new', 'manifest.json'))).toBe(true);
    expect(plugins.get('svc-plg')?.manifest.version).toBe('1.0.0');
  });
});

describe('PluginPackageScanner: a plugin directory that is a symbolic link', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
  let plugins: Map<string, PluginInstance>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-symlink-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    plugins = new Map();
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const writePackage = (dir: string, id: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id, name: id, version: '1.0.0', type: 'extension', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
  };
  const scan = (): void => {
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    new PluginPackageScanner(
      logger as unknown as ReturnType<typeof createLogger>,
      config,
      new PluginStorageService(config),
      pluginsDir,
      null,
      plugins,
    ).scanAtBoot();
  };
  const warnings = (): string[] => (logger.warn.mock.calls as unknown[][]).map(call => String(call[0]));

  // A link is not a directory to the directory listing, so such a plugin was skipped without a word in the log.
  it('is not loaded, and the log names the link', () => {
    writePackage(path.join(tmpDir, 'elsewhere', 'linked-plg'), 'linked-plg');
    fs.symlinkSync(path.join(tmpDir, 'elsewhere', 'linked-plg'), path.join(pluginsDir, 'linked-plg'));
    writePackage(path.join(pluginsDir, 'real-plg'), 'real-plg');

    scan();

    expect([...plugins.keys()]).toEqual(['real-plg']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipped linked-plg: it is a symbolic link'),
      expect.objectContaining({ action: 'plugin_symlink_skipped', pluginPath: path.join(pluginsDir, 'linked-plg') }),
    );
    expect(warnings().filter(w => w.includes('symbolic link'))).toHaveLength(1);
  });

  it('says nothing about a link to a file, a dangling link or a dot-named link', () => {
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'notes');
    fs.symlinkSync(path.join(tmpDir, 'notes.txt'), path.join(pluginsDir, 'notes.txt'));
    fs.symlinkSync(path.join(tmpDir, 'gone'), path.join(pluginsDir, 'dangling'));
    fs.mkdirSync(path.join(tmpDir, 'elsewhere'));
    fs.symlinkSync(path.join(tmpDir, 'elsewhere'), path.join(pluginsDir, '.hidden'));

    scan();

    expect(warnings().filter(w => w.includes('symbolic link'))).toEqual([]);
    expect(plugins.size).toBe(0);
  });
});
