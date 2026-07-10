import mainDataSource from './data-source-main';

// The app runs the MAIN connection (auth/audit) as a separate always-SQLite connection. The
// default data-source.ts CLI only manages the DATA connection's migrations, so this standalone
// DataSource exists so the CLI can run/generate the main-owned migrations too.
describe('main CLI DataSource', () => {
  it('targets the always-SQLite main connection', () => {
    expect(mainDataSource.options.type).toBe('sqlite');
  });

  it('uses the main-owned migrations dir, not the data migrations dir', () => {
    const migrations = (mainDataSource.options.migrations as string[]).join(' ');
    expect(migrations).toContain('migrations-main');
  });

  it('covers the auth and audit entities (the main connection owns them)', () => {
    const entities = (mainDataSource.options.entities as string[]).join(' ');
    expect(entities).toContain('auth');
    expect(entities).toContain('audit');
  });

  // jest.resetModules() + a typed require forces a fresh evaluation of the module with the env var
  // we set, proving MAIN_DATABASE_NAME flows into the DataSource options (not just the cached
  // top-level import, which was evaluated with whatever env existed at spec load).
  it("defaults to './data/main.sqlite' when MAIN_DATABASE_NAME is unset", () => {
    const previous = process.env.MAIN_DATABASE_NAME;
    delete process.env.MAIN_DATABASE_NAME;
    jest.resetModules();
    try {
      // require() (not dynamic import()) — the relative specifier trips TS2835 under
      // moduleResolution:nodenext; jest.resetModules() above still forces a fresh evaluation.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./data-source-main') as typeof import('./data-source-main');
      expect(String(mod.default.options.database)).toBe('./data/main.sqlite');
    } finally {
      if (previous !== undefined) process.env.MAIN_DATABASE_NAME = previous;
    }
  });

  it('honors MAIN_DATABASE_NAME when set (mirrors configuration.ts)', () => {
    const previous = process.env.MAIN_DATABASE_NAME;
    process.env.MAIN_DATABASE_NAME = '/tmp/test-main.sqlite';
    jest.resetModules();
    try {
      // require() (not dynamic import()) — the relative specifier trips TS2835 under
      // moduleResolution:nodenext; jest.resetModules() above still forces a fresh evaluation.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./data-source-main') as typeof import('./data-source-main');
      expect(String(mod.default.options.database)).toBe('/tmp/test-main.sqlite');
    } finally {
      if (previous !== undefined) process.env.MAIN_DATABASE_NAME = previous;
      else delete process.env.MAIN_DATABASE_NAME;
    }
  });
});
