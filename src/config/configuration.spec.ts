import configuration from './configuration';

describe('configuration — main DB synchronize', () => {
  const orig = process.env.MAIN_DATABASE_SYNCHRONIZE;

  afterEach(() => {
    if (orig === undefined) delete process.env.MAIN_DATABASE_SYNCHRONIZE;
    else process.env.MAIN_DATABASE_SYNCHRONIZE = orig;
  });

  it('defaults main synchronize ON (zero-config first boot)', () => {
    delete process.env.MAIN_DATABASE_SYNCHRONIZE;
    expect(configuration().database.synchronize).toBe(true);
  });

  it('disables synchronize only when MAIN_DATABASE_SYNCHRONIZE="false"', () => {
    process.env.MAIN_DATABASE_SYNCHRONIZE = 'false';
    expect(configuration().database.synchronize).toBe(false);
    process.env.MAIN_DATABASE_SYNCHRONIZE = 'true';
    expect(configuration().database.synchronize).toBe(true);
  });
});

describe('configuration — Postgres database name', () => {
  const orig = process.env.DATABASE_NAME;
  afterEach(() => {
    if (orig === undefined) delete process.env.DATABASE_NAME;
    else process.env.DATABASE_NAME = orig;
  });

  it('resolves dataDatabase.name from DATABASE_NAME (matches the migration CLI), default openwa', () => {
    delete process.env.DATABASE_NAME;
    expect(configuration().dataDatabase.name).toBe('openwa');
    process.env.DATABASE_NAME = 'prod_db';
    expect(configuration().dataDatabase.name).toBe('prod_db');
  });
});
