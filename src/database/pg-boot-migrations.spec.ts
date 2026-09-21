import { DataSource, DataSourceOptions } from 'typeorm';
// Default import (not `import * as`) on purpose: it binds straight to pg's module.exports, so the
// constructor spy below reaches the same object pg-boot-migrations reads `Client` from at call time.
import pg, { Client as PgClient, ClientConfig } from 'pg';
import {
  AdvisoryLockClient,
  BootDataSourceDeps,
  POSTGRES_BOOT_MIGRATION_LOCK_KEYS,
  createBootDataSource,
} from './pg-boot-migrations';
import { postgresUtcExtra, utcTimestampTypes } from './postgres-utc';

// Protocol wiring of the boot-migration advisory lock: the lock must be taken BEFORE runMigrations
// starts and dropped after it finishes (on success AND on migration failure), and the DataSource
// handed back to Nest must never carry migrationsRun (it would re-run the chain unsynchronized).
// The pg client and the DataSource constructor are injected as fakes; the PG-gated companion spec
// (pg-boot-migrations.pg.spec.ts) proves the same protocol against a real Postgres.

const PG_OPTIONS: DataSourceOptions = {
  type: 'postgres',
  host: 'db',
  port: 5432,
  username: 'openwa',
  password: 'secret',
  database: 'openwa',
  // The app config still carries this; the factory takes over execution and must neutralize it.
  migrationsRun: true,
  migrationsTransactionMode: 'all',
  extra: { statement_timeout: 30000, connectionTimeoutMillis: 10000 },
};

describe('createBootDataSource (postgres boot migrations)', () => {
  // Fakes keep their inferred jest.Mock types (casts live only at the injection boundary) and
  // record every step in `calls`, so ordering is asserted on one linear trace.
  function makeFakes(runMigrations: () => Promise<unknown> = jest.fn(), sessionOffsetSeconds = 0) {
    const calls: string[] = [];
    const dataSource = {
      // The UTC pin's boot assertion reads the session's effective zone. It is not part of the lock
      // protocol these tests trace, so it stays out of `calls`.
      query: jest.fn(() =>
        Promise.resolve([
          { zone: 'UTC', offset_seconds: sessionOffsetSeconds, offset_seconds_later: sessionOffsetSeconds },
        ]),
      ),
      initialize: jest.fn(() => {
        calls.push('initialize');
        return Promise.resolve();
      }),
      runMigrations: jest.fn(() => {
        calls.push('runMigrations');
        return runMigrations();
      }),
      destroy: jest.fn(() => {
        calls.push('destroy');
        return Promise.resolve();
      }),
    };
    const lockClient: AdvisoryLockClient = {
      connect: jest.fn(() => {
        calls.push('connect');
        return Promise.resolve();
      }),
      query: jest.fn((text: string) => {
        calls.push(text);
        return Promise.resolve();
      }),
      end: jest.fn(() => {
        calls.push('end');
        return Promise.resolve();
      }),
    };
    const deps: BootDataSourceDeps = {
      createDataSource: jest.fn(() => dataSource as unknown as DataSource),
      createLockClient: jest.fn(() => lockClient),
    };
    return { calls, dataSource, lockClient, deps };
  }

  it('initializes, then migrates strictly between advisory lock acquire and release', async () => {
    const { calls, dataSource, lockClient, deps } = makeFakes();

    const returned = await createBootDataSource(PG_OPTIONS, deps);

    expect(returned).toBe(dataSource);
    expect(calls).toEqual([
      'initialize',
      'connect',
      'SELECT pg_advisory_lock($1, $2)',
      'runMigrations',
      'SELECT pg_advisory_unlock($1, $2)',
      'end',
    ]);
    // Same key for acquire and release, in the (key1, key2) form.
    expect(lockClient.query).toHaveBeenNthCalledWith(1, 'SELECT pg_advisory_lock($1, $2)', [
      ...POSTGRES_BOOT_MIGRATION_LOCK_KEYS,
    ]);
    expect(lockClient.query).toHaveBeenNthCalledWith(2, 'SELECT pg_advisory_unlock($1, $2)', [
      ...POSTGRES_BOOT_MIGRATION_LOCK_KEYS,
    ]);
    // Migration execution preserves the built-in migrationsRun transaction mode, and the boot
    // error path (destroy) never fires on success.
    expect(dataSource.runMigrations).toHaveBeenCalledWith({ transaction: 'all' });
    expect(dataSource.destroy).not.toHaveBeenCalled();
  });

  it('constructs the DataSource with migrationsRun disabled and never mutates the config', async () => {
    const { deps } = makeFakes();

    await createBootDataSource(PG_OPTIONS, deps);

    expect(deps.createDataSource).toHaveBeenCalledWith({
      ...PG_OPTIONS,
      migrationsRun: false,
      // The UTC pin rides along with the pool settings the config already carries, rather than
      // replacing them.
      extra: {
        ...(PG_OPTIONS.extra as Record<string, unknown>),
        types: utcTimestampTypes,
        onConnect: postgresUtcExtra().onConnect,
      },
    });
    // The resolved config object itself is untouched — the flag stays as the built-in fallback.
    expect(PG_OPTIONS.migrationsRun).toBe(true);
    expect(PG_OPTIONS.extra).toEqual({ statement_timeout: 30000, connectionTimeoutMillis: 10000 });
  });

  it('builds the lock client without a statement timeout (pg_advisory_lock must survive the wait)', async () => {
    const { deps } = makeFakes();

    await createBootDataSource(PG_OPTIONS, deps);

    // statement_timeout applies to any command — including the lock wait — and a config value of 0
    // is dropped by pg as falsy, so the only correct disable is the startup `options` string.
    expect(deps.createLockClient).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'db',
        port: 5432,
        user: 'openwa',
        password: 'secret',
        database: 'openwa',
        connectionTimeoutMillis: 10000,
        options: '-c statement_timeout=0',
      }),
    );
  });

  it('releases the lock and surfaces the error when a migration fails', async () => {
    const failure = new Error('duplicate table: messages');
    const { calls, lockClient, deps } = makeFakes(jest.fn(() => Promise.reject(failure)));

    await expect(createBootDataSource(PG_OPTIONS, deps)).rejects.toBe(failure);

    // Failure semantics: the lock still gets released, the client returned, and the DataSource is
    // torn down exactly like DataSource.initialize()'s own migrate-step error path — a retrying
    // boot must not stack initialized pools of failed attempts.
    expect(calls).toEqual([
      'initialize',
      'connect',
      'SELECT pg_advisory_lock($1, $2)',
      'runMigrations',
      'SELECT pg_advisory_unlock($1, $2)',
      'end',
      'destroy',
    ]);
    expect(lockClient.end).toHaveBeenCalledTimes(1);
  });

  it('tears the DataSource down when the lock client cannot connect', async () => {
    const { dataSource, lockClient, deps } = makeFakes();
    (lockClient.connect as jest.Mock).mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(createBootDataSource(PG_OPTIONS, deps)).rejects.toThrow('ECONNREFUSED');

    expect(lockClient.query).not.toHaveBeenCalled();
    expect(lockClient.end).toHaveBeenCalledTimes(1);
    expect(dataSource.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps the default @nestjs/typeorm path for non-postgres options (no lock, no initialize)', async () => {
    const sqliteOptions: DataSourceOptions = { type: 'better-sqlite3', database: './data/openwa.sqlite' };
    const dataSource = {
      initialize: jest.fn(() => Promise.resolve()),
      runMigrations: jest.fn(() => Promise.resolve()),
      destroy: jest.fn(() => Promise.resolve()),
    };
    const deps: BootDataSourceDeps = {
      createDataSource: jest.fn(() => dataSource as unknown as DataSource),
      createLockClient: jest.fn(),
    };

    const returned = await createBootDataSource(sqliteOptions, deps);

    // Untouched options, uninitialized DataSource (the wrapper's initialize keeps running the
    // connection's own migrationsRun), and no advisory-lock client is ever built.
    expect(returned).toBe(dataSource);
    expect(deps.createDataSource).toHaveBeenCalledWith(sqliteOptions);
    expect(deps.createLockClient).not.toHaveBeenCalled();
    expect(dataSource.initialize).not.toHaveBeenCalled();
  });

  it('still resolves when the advisory unlock fails: end() below drops the session and the lock', async () => {
    const { calls, dataSource, lockClient, deps } = makeFakes();
    (lockClient.query as jest.Mock).mockImplementation((text: string) => {
      calls.push(text);
      // Postgres killing the connection right after the last migration statement — the unlock
      // call itself fails, which must never turn a finished boot into a failed one.
      return text.includes('unlock') ? Promise.reject(new Error('connection terminated')) : Promise.resolve();
    });

    const returned = await createBootDataSource(PG_OPTIONS, deps);

    expect(returned).toBe(dataSource);
    expect(calls).toEqual([
      'initialize',
      'connect',
      'SELECT pg_advisory_lock($1, $2)',
      'runMigrations',
      'SELECT pg_advisory_unlock($1, $2)',
      'end',
    ]);
    expect(dataSource.destroy).not.toHaveBeenCalled();
  });

  it('still resolves when lock-client end() fails: the boot result does not depend on client teardown', async () => {
    const { calls, dataSource, lockClient, deps } = makeFakes();
    (lockClient.end as jest.Mock).mockImplementation(() => {
      calls.push('end');
      return Promise.reject(new Error('socket hang up'));
    });

    const returned = await createBootDataSource(PG_OPTIONS, deps);

    expect(returned).toBe(dataSource);
    expect(calls).toEqual([
      'initialize',
      'connect',
      'SELECT pg_advisory_lock($1, $2)',
      'runMigrations',
      'SELECT pg_advisory_unlock($1, $2)',
      'end',
    ]);
    expect(dataSource.destroy).not.toHaveBeenCalled();
  });

  it('surfaces the migration error, not the teardown error, when destroy() rejects too', async () => {
    const migrationFailure = new Error('duplicate table: messages');
    const { calls, dataSource, lockClient, deps } = makeFakes(jest.fn(() => Promise.reject(migrationFailure)));
    (dataSource.destroy as jest.Mock).mockImplementation(() => {
      calls.push('destroy');
      return Promise.reject(new Error('pool already destroyed'));
    });

    // The original boot failure wins; the destroy() rejection it triggered is swallowed so it
    // cannot mask what actually went wrong.
    await expect(createBootDataSource(PG_OPTIONS, deps)).rejects.toBe(migrationFailure);

    expect(calls).toEqual([
      'initialize',
      'connect',
      'SELECT pg_advisory_lock($1, $2)',
      'runMigrations',
      'SELECT pg_advisory_unlock($1, $2)',
      'end',
      'destroy',
    ]);
    expect(lockClient.end).toHaveBeenCalledTimes(1);
  });

  it('defaults the lock-client connect timeout to 10s when options carry no extra block', async () => {
    const { deps } = makeFakes();

    await createBootDataSource({ ...PG_OPTIONS, extra: undefined }, deps);

    expect(deps.createLockClient).toHaveBeenCalledWith(
      expect.objectContaining({ connectionTimeoutMillis: 10000, options: '-c statement_timeout=0' }),
    );
  });

  it('takes the connect timeout from extra and forwards ssl by reference', async () => {
    const ssl = { rejectUnauthorized: false };
    const { deps } = makeFakes();

    await createBootDataSource({ ...PG_OPTIONS, ssl, extra: { connectionTimeoutMillis: 2500 } }, deps);

    // A value distinct from the 10s default proves the timeout comes from extra, and identity on
    // ssl proves the TLS shape is passed through untouched — the same object the driver built.
    const createLockClient = deps.createLockClient as jest.Mock<AdvisoryLockClient, [ClientConfig]>;
    const config = createLockClient.mock.calls[0][0];
    expect(config.connectionTimeoutMillis).toBe(2500);
    expect(config.ssl).toBe(ssl);
  });

  it('falls back to the real DataSource and pg Client constructors when no deps are injected', async () => {
    // The production path. Only the spots that would touch the outside world are stubbed — the
    // DataSource lifecycle methods (initialize would open a pool) and the pg Client constructor
    // (connect would open a socket) — so both default factories run as shipped.
    const lockClient: AdvisoryLockClient = {
      connect: jest.fn(() => Promise.resolve()),
      query: jest.fn(() => Promise.resolve()),
      end: jest.fn(() => Promise.resolve()),
    };
    const clientCtor = jest.spyOn(pg, 'Client').mockImplementation(() => lockClient as unknown as PgClient);
    const initialize = jest.spyOn(DataSource.prototype, 'initialize').mockImplementation(function (this: DataSource) {
      return Promise.resolve(this);
    });
    const query = jest
      .spyOn(DataSource.prototype, 'query')
      .mockResolvedValue([{ zone: 'UTC', offset_seconds: 0, offset_seconds_later: 0 }] as never);
    const runMigrations = jest.spyOn(DataSource.prototype, 'runMigrations').mockResolvedValue([]);
    const destroy = jest.spyOn(DataSource.prototype, 'destroy').mockResolvedValue(undefined);
    try {
      const returned = await createBootDataSource(PG_OPTIONS);

      expect(returned).toBeInstanceOf(DataSource);
      // The default factory path still neutralizes migrationsRun before construction.
      expect(returned.options.migrationsRun).toBe(false);
      // The real Client constructor received the same lock-client config the fakes assert above.
      expect(clientCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'db',
          user: 'openwa',
          database: 'openwa',
          options: '-c statement_timeout=0',
        }),
      );
      expect(lockClient.query).toHaveBeenNthCalledWith(1, 'SELECT pg_advisory_lock($1, $2)', [
        ...POSTGRES_BOOT_MIGRATION_LOCK_KEYS,
      ]);
      expect(lockClient.query).toHaveBeenNthCalledWith(2, 'SELECT pg_advisory_unlock($1, $2)', [
        ...POSTGRES_BOOT_MIGRATION_LOCK_KEYS,
      ]);
      expect(runMigrations).toHaveBeenCalledWith({ transaction: 'all' });
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      clientCtor.mockRestore();
      initialize.mockRestore();
      query.mockRestore();
      runMigrations.mockRestore();
      destroy.mockRestore();
    }
  });

  it('refuses to migrate on a connection whose session is not on UTC', async () => {
    // A pin that did not take (a pooler dropping the SET, a server-side default re-applied after it)
    // would have the driver read every naive timestamp as UTC while the server keeps writing its own
    // zone. Migrating on that connection would bake the mismatch into the data it rewrites.
    const { calls, dataSource, deps } = makeFakes(jest.fn(), 25200);

    await expect(createBootDataSource(PG_OPTIONS, deps)).rejects.toThrow(/not on UTC/);

    expect(dataSource.runMigrations).not.toHaveBeenCalled();
    expect(deps.createLockClient).not.toHaveBeenCalled();
    expect(calls).toEqual(['initialize', 'destroy']);
  });
});
