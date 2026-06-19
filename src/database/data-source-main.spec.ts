import mainDataSource from './data-source-main';

// The app runs the MAIN connection (auth + audit) as a separate always-SQLite connection. The
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
});
