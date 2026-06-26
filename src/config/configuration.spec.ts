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

describe('configuration — Puppeteer args delimiter', () => {
  const orig = process.env.PUPPETEER_ARGS;
  afterEach(() => {
    if (orig === undefined) delete process.env.PUPPETEER_ARGS;
    else process.env.PUPPETEER_ARGS = orig;
  });

  // The dashboard Infrastructure form persists browser args space-separated, while .env/compose
  // use commas. The parser must accept both so each flag reaches Chromium as a discrete argv token
  // (a single glued token like "--no-sandbox --disable-gpu" silently neuters --no-sandbox).
  it('splits space-separated PUPPETEER_ARGS into discrete flags (dashboard-written form)', () => {
    process.env.PUPPETEER_ARGS = '--no-sandbox --disable-gpu';
    expect(configuration().engine.puppeteer.args).toEqual(['--no-sandbox', '--disable-gpu']);
  });

  it('still splits comma-separated PUPPETEER_ARGS (.env / docker-compose form)', () => {
    process.env.PUPPETEER_ARGS = '--no-sandbox,--disable-setuid-sandbox';
    expect(configuration().engine.puppeteer.args).toEqual(['--no-sandbox', '--disable-setuid-sandbox']);
  });

  it('defaults to discrete sandbox flags when unset', () => {
    delete process.env.PUPPETEER_ARGS;
    expect(configuration().engine.puppeteer.args).toEqual(['--no-sandbox', '--disable-setuid-sandbox']);
  });
});

describe('configuration — Postgres pool timeouts', () => {
  const keys = ['DATABASE_STATEMENT_TIMEOUT_MS', 'DATABASE_IDLE_TIMEOUT_MS', 'DATABASE_CONNECTION_TIMEOUT_MS'];
  const orig: Record<string, string | undefined> = {};
  beforeEach(() => keys.forEach(k => (orig[k] = process.env[k])));
  afterEach(() =>
    keys.forEach(k => {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }),
  );

  it('defaults to sane pool timeouts (30s statement, 30s idle, 10s connection)', () => {
    keys.forEach(k => delete process.env[k]);
    const cfg = configuration().dataDatabase;
    expect(cfg.statementTimeoutMs).toBe(30000);
    expect(cfg.idleTimeoutMs).toBe(30000);
    expect(cfg.connectionTimeoutMs).toBe(10000);
  });

  it('honors env overrides (incl. 0 to disable a timeout)', () => {
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = '0';
    process.env.DATABASE_IDLE_TIMEOUT_MS = '15000';
    process.env.DATABASE_CONNECTION_TIMEOUT_MS = '2000';
    const cfg = configuration().dataDatabase;
    expect(cfg.statementTimeoutMs).toBe(0);
    expect(cfg.idleTimeoutMs).toBe(15000);
    expect(cfg.connectionTimeoutMs).toBe(2000);
  });
});

describe('configuration — plugin download cap is fail-safe', () => {
  const orig = process.env.PLUGIN_DOWNLOAD_MAX_BYTES;
  afterEach(() => {
    if (orig === undefined) delete process.env.PLUGIN_DOWNLOAD_MAX_BYTES;
    else process.env.PLUGIN_DOWNLOAD_MAX_BYTES = orig;
  });

  it('uses the env value when it is a valid positive integer', () => {
    process.env.PLUGIN_DOWNLOAD_MAX_BYTES = '1048576';
    expect(configuration().plugins.downloadMaxBytes).toBe(1048576);
  });

  it('falls back to the 5 MB default when the env value is non-numeric or non-positive', () => {
    for (const bad of ['abc', 'unlimited', '0', '-1']) {
      process.env.PLUGIN_DOWNLOAD_MAX_BYTES = bad;
      expect(configuration().plugins.downloadMaxBytes).toBe(5 * 1024 * 1024);
    }
  });
});
