import { readDataDbConfig, readMainDbConfig } from './database.config';

/**
 * Single source of truth for DB connection params (consolidated from the former
 * triplication across data-source.ts / configuration.ts / app.module.ts).
 * These tests lock in the defaults so the runtime and migration CLI can't drift.
 */
describe('readDataDbConfig', () => {
  const DB_KEYS = [
    'DATABASE_TYPE',
    'DATABASE_NAME',
    'DATABASE_HOST',
    'DATABASE_PORT',
    'DATABASE_USERNAME',
    'DATABASE_PASSWORD',
    'DATABASE_SYNCHRONIZE',
    'DATABASE_LOGGING',
    'DATABASE_POOL_SIZE',
    'DATABASE_SSL',
    'DATABASE_SSL_REJECT_UNAUTHORIZED',
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of DB_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of DB_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('defaults to a local SQLite file', () => {
    const cfg = readDataDbConfig();
    expect(cfg.type).toBe('sqlite');
    expect(cfg.database).toBe('./data/openwa.sqlite');
    expect(cfg.synchronize).toBe(false);
    expect(cfg.logging).toBe(false);
  });

  it('uses the Postgres database name "openwa" by default (not the SQLite path)', () => {
    process.env.DATABASE_TYPE = 'postgres';
    const cfg = readDataDbConfig();
    expect(cfg.type).toBe('postgres');
    expect(cfg.database).toBe('openwa');
    expect(cfg.host).toBe('localhost');
    expect(cfg.port).toBe(5432);
    expect(cfg.poolSize).toBe(10);
    expect(cfg.ssl).toBe(false);
    expect(cfg.sslRejectUnauthorized).toBe(true);
  });

  it('honors explicit overrides', () => {
    Object.assign(process.env, {
      DATABASE_TYPE: 'postgres',
      DATABASE_NAME: 'mydb',
      DATABASE_HOST: 'db.example.com',
      DATABASE_PORT: '6543',
      DATABASE_USERNAME: 'u',
      DATABASE_PASSWORD: 'p',
      DATABASE_SYNCHRONIZE: 'true',
      DATABASE_LOGGING: 'true',
      DATABASE_POOL_SIZE: '25',
      DATABASE_SSL: 'true',
      DATABASE_SSL_REJECT_UNAUTHORIZED: 'false',
    });
    const cfg = readDataDbConfig();
    expect(cfg).toEqual({
      type: 'postgres',
      database: 'mydb',
      host: 'db.example.com',
      port: 6543,
      username: 'u',
      password: 'p',
      synchronize: true,
      logging: true,
      poolSize: 25,
      ssl: true,
      sslRejectUnauthorized: false,
    });
  });
});

describe('readMainDbConfig', () => {
  it('is always embedded SQLite with synchronize on', () => {
    const cfg = readMainDbConfig();
    expect(cfg.type).toBe('sqlite');
    expect(cfg.database).toBe('./data/main.sqlite');
    expect(cfg.synchronize).toBe(true);
  });
});
