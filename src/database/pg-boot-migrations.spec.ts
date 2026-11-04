import { EventEmitter } from 'events';
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

/** The statements a pool's connect hook issues on a fresh connection. */
async function connectStatements(options: DataSourceOptions): Promise<string[]> {
  const query = jest.fn<Promise<unknown>, [{ text: string }]>().mockResolvedValue({});
  await (options.extra as { onConnect: (client: never) => Promise<unknown> }).onConnect({ query } as never);
  return query.mock.calls.map(([sent]) => sent.text);
}

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
    // One fake stands in for both the migration pool (torn down after the chain) and the runtime one.
    expect(calls).toEqual([
      'initialize',
      'connect',
      'SET statement_timeout = 0',
      'SET idle_session_timeout = 0',
      'SELECT pg_advisory_lock($1, $2)',
      'runMigrations',
      'SELECT pg_advisory_unlock($1, $2)',
      'end',
      'destroy',
      'initialize',
    ]);
    // Same key for acquire and release, in the (key1, key2) form.
    expect(lockClient.query).toHaveBeenNthCalledWith(3, 'SELECT pg_advisory_lock($1, $2)', [
      ...POSTGRES_BOOT_MIGRATION_LOCK_KEYS,
    ]);
    expect(lockClient.query).toHaveBeenNthCalledWith(4, 'SELECT pg_advisory_unlock($1, $2)', [
      ...POSTGRES_BOOT_MIGRATION_LOCK_KEYS,
    ]);
    // Migration execution preserves the built-in migrationsRun transaction mode, and only the
    // migration pool is torn down on success.
    expect(dataSource.runMigrations).toHaveBeenCalledWith({ transaction: 'all' });
    expect(dataSource.destroy).toHaveBeenCalledTimes(1);
  });

  it('constructs the DataSource with migrationsRun disabled and never mutates the config', async () => {
    const { deps } = makeFakes();

    await createBootDataSource(PG_OPTIONS, deps);

    // The UTC pin rides along with the pool settings the config already carries, rather than replacing
    // them; statement_timeout leaves the startup packet for the connect hook (the migrator sets none).
    expect(deps.createDataSource).toHaveBeenNthCalledWith(1, {
      ...PG_OPTIONS,
      migrationsRun: false,
      extra: { connectionTimeoutMillis: 10000, types: utcTimestampTypes, onConnect: postgresUtcExtra().onConnect },
    });
    expect(deps.createDataSource).toHaveBeenNthCalledWith(2, {
      ...PG_OPTIONS,
      migrationsRun: false,
      extra: { connectionTimeoutMillis: 10000, types: utcTimestampTypes, onConnect: expect.any(Function) as unknown },
    });
    // The resolved config object itself is untouched — the flag stays as the built-in fallback.
    expect(PG_OPTIONS.migrationsRun).toBe(true);
    expect(PG_OPTIONS.extra).toEqual({ statement_timeout: 30000, connectionTimeoutMillis: 10000 });
  });

  it('runs the chain on its own pool without the runtime statement_timeout, then returns one that keeps it', async () => {
    // pg sends statement_timeout in the startup packet, so every statement on a pool built with it
    // inherits the limit: a backfill or index build over a large table was cancelled at 30 s, the
    // whole 'all' transaction rolled back, and every retry of the boot failed the same way.
    const migrator = makeFakes();
    const runtime = makeFakes();
    const createDataSource = jest
      .fn<DataSource, [DataSourceOptions]>()
      .mockReturnValueOnce(migrator.dataSource as unknown as DataSource)
      .mockReturnValueOnce(runtime.dataSource as unknown as DataSource);

    const returned = await createBootDataSource(PG_OPTIONS, {
      createDataSource,
      createLockClient: migrator.deps.createLockClient,
    });

    expect(returned).toBe(runtime.dataSource);
    expect(migrator.calls).toEqual([
      'initialize',
      'connect',
      'SET statement_timeout = 0',
      'SET idle_session_timeout = 0',
      'SELECT pg_advisory_lock($1, $2)',
      'runMigrations',
      'SELECT pg_advisory_unlock($1, $2)',
      'end',
      'destroy',
    ]);
    expect(runtime.calls).toEqual(['initialize']);
    const [[migratorOptions], [runtimeOptions]] = createDataSource.mock.calls;
    expect(migratorOptions.extra).not.toHaveProperty('statement_timeout');
    expect(migratorOptions.extra).toMatchObject({ connectionTimeoutMillis: 10000 });
    expect(runtimeOptions.extra).not.toHaveProperty('statement_timeout');
    expect(runtimeOptions.extra).toMatchObject({ connectionTimeoutMillis: 10000 });
    expect(await connectStatements(migratorOptions)).toEqual(["SET TIME ZONE 'UTC'"]);
    expect(await connectStatements(runtimeOptions)).toEqual(["SET TIME ZONE 'UTC'; SET statement_timeout = 30000"]);
    expect(runtime.dataSource.query).toHaveBeenCalled(); // the runtime pool's UTC pin is verified too
  });

  it('tears the runtime DataSource down when its session is not on UTC, after the chain is applied', async () => {
    const migrator = makeFakes();
    const runtime = makeFakes(jest.fn(), 25200);
    const createDataSource = jest
      .fn<DataSource, [DataSourceOptions]>()
      .mockReturnValueOnce(migrator.dataSource as unknown as DataSource)
      .mockReturnValueOnce(runtime.dataSource as unknown as DataSource);

    await expect(
      createBootDataSource(PG_OPTIONS, { createDataSource, createLockClient: migrator.deps.createLockClient }),
    ).rejects.toThrow(/not on UTC/);

    expect(runtime.calls).toEqual(['initialize', 'destroy']);
  });

  it('builds the lock client without a statement timeout (pg_advisory_lock must survive the wait)', async () => {
    const { calls, deps } = makeFakes();

    await createBootDataSource(PG_OPTIONS, deps);

    // statement_timeout applies to any command, the lock wait included. It is turned off by a SET right
    // after connect, before the lock is taken, and never in the startup packet, which PgBouncer refuses.
    expect(deps.createLockClient).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'db',
        port: 5432,
        user: 'openwa',
        password: 'secret',
        database: 'openwa',
        connectionTimeoutMillis: 10000,
      }),
      expect.any(Function),
    );
    const [[config]] = (deps.createLockClient as jest.Mock<AdvisoryLockClient, [ClientConfig]>).mock.calls;
    expect(config).not.toHaveProperty('options');
    expect(config).not.toHaveProperty('statement_timeout');
    expect(calls.slice(1, 4)).toEqual(['connect', 'SET statement_timeout = 0', 'SET idle_session_timeout = 0']);
  });

  it('fails the boot, without taking the lock, when the lock session refuses to lift its timeout', async () => {
    const { calls, lockClient, deps } = makeFakes();
    (lockClient.query as jest.Mock).mockImplementation((text: string) => {
      calls.push(text);
      return text === 'SET statement_timeout = 0' ? Promise.reject(new Error('permission denied')) : Promise.resolve();
    });

    await expect(createBootDataSource(PG_OPTIONS, deps)).rejects.toThrow('permission denied');

    expect(calls).not.toContain('SELECT pg_advisory_lock($1, $2)');
    expect(calls).not.toContain('runMigrations');
    expect(lockClient.end).toHaveBeenCalledTimes(1);
  });

  it('sets a non-public schema search_path on connect instead of in the startup packet, on both pools', async () => {
    const { deps } = makeFakes();
    const custom: DataSourceOptions = {
      ...PG_OPTIONS,
      schema: 'openwa',
      extra: { statement_timeout: 30000, connectionTimeoutMillis: 10000, options: '-c search_path=openwa,public' },
    };

    await createBootDataSource(custom, deps);

    const [[migrator], [runtime]] = (deps.createDataSource as jest.Mock<DataSource, [DataSourceOptions]>).mock.calls;
    expect(migrator.extra).not.toHaveProperty('options');
    expect(runtime.extra).not.toHaveProperty('options');
    expect(await connectStatements(migrator)).toEqual([
      "SET TIME ZONE 'UTC'; SELECT set_config('search_path', 'openwa,public', false)",
    ]);
    expect(await connectStatements(runtime)).toEqual([
      "SET TIME ZONE 'UTC'; SET statement_timeout = 30000; SELECT set_config('search_path', 'openwa,public', false)",
    ]);
    expect(custom.extra).toEqual({
      statement_timeout: 30000,
      connectionTimeoutMillis: 10000,
      options: '-c search_path=openwa,public',
    });
  });

  it('keeps the startup options of a public-schema connection, which carry no search_path', async () => {
    const { deps } = makeFakes();

    await createBootDataSource({ ...PG_OPTIONS, schema: 'public', extra: { options: '-c application_name=x' } }, deps);

    const [[migrator]] = (deps.createDataSource as jest.Mock<DataSource, [DataSourceOptions]>).mock.calls;
    expect(migrator.extra).toMatchObject({ options: '-c application_name=x' });
  });

  // The holder sits idle on its lock connection for the whole chain, so a role- or database-level
  // idle_session_timeout (PostgreSQL 14+) would end the session mid-migration on every boot retry.
  // PostgreSQL 12 and 13 do not know the setting, which is why it is not in the startup packet.
  it('turns idle_session_timeout off on the lock session before taking the lock, tolerating old servers', async () => {
    const { calls, dataSource, lockClient, deps } = makeFakes();
    (lockClient.query as jest.Mock).mockImplementation((text: string) => {
      calls.push(text);
      return text.includes('idle_session_timeout')
        ? Promise.reject(new Error('unrecognized configuration parameter "idle_session_timeout"'))
        : Promise.resolve();
    });

    const returned = await createBootDataSource(PG_OPTIONS, deps);

    expect(returned).toBe(dataSource);
    expect(calls.slice(1, 6)).toEqual([
      'connect',
      'SET statement_timeout = 0',
      'SET idle_session_timeout = 0',
      'SELECT pg_advisory_lock($1, $2)',
      'runMigrations',
    ]);
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
      'SET statement_timeout = 0',
      'SET idle_session_timeout = 0',
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
      'SET statement_timeout = 0',
      'SET idle_session_timeout = 0',
      'SELECT pg_advisory_lock($1, $2)',
      'runMigrations',
      'SELECT pg_advisory_unlock($1, $2)',
      'end',
      'destroy',
      'initialize',
    ]);
    expect(dataSource.destroy).toHaveBeenCalledTimes(1); // the migration pool only
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
      'SET statement_timeout = 0',
      'SET idle_session_timeout = 0',
      'SELECT pg_advisory_lock($1, $2)',
      'runMigrations',
      'SELECT pg_advisory_unlock($1, $2)',
      'end',
      'destroy',
      'initialize',
    ]);
    expect(dataSource.destroy).toHaveBeenCalledTimes(1); // the migration pool only
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
      'SET statement_timeout = 0',
      'SET idle_session_timeout = 0',
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
      expect.objectContaining({ connectionTimeoutMillis: 10000 }),
      expect.any(Function),
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

  it('bounds the UTC pin of the migration and the runtime pool with that connect timeout', async () => {
    const { deps } = makeFakes();

    await createBootDataSource({ ...PG_OPTIONS, extra: { connectionTimeoutMillis: 2500 } }, deps);

    const built = (deps.createDataSource as jest.Mock<DataSource, [DataSourceOptions]>).mock.calls;
    expect(built).toHaveLength(2);
    for (const [options] of built) {
      const query = jest.fn().mockResolvedValue({});
      await (options.extra as { onConnect: (client: never) => Promise<unknown> }).onConnect({ query } as never);
      expect(query).toHaveBeenCalledWith({ text: "SET TIME ZONE 'UTC'", query_timeout: 2500 });
    }
  });

  it('falls back to the real DataSource and pg Client constructors when no deps are injected', async () => {
    // The production path. Only the spots that would touch the outside world are stubbed — the
    // DataSource lifecycle methods (initialize would open a pool) and the pg Client constructor
    // (connect would open a socket) — so both default factories run as shipped.
    const lockClient: AdvisoryLockClient = Object.assign(new EventEmitter(), {
      connect: jest.fn(() => Promise.resolve()),
      query: jest.fn(() => Promise.resolve()),
      end: jest.fn(() => Promise.resolve()),
    });
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
        expect.objectContaining({ host: 'db', user: 'openwa', database: 'openwa' }),
      );
      expect(clientCtor.mock.calls[0][0]).not.toHaveProperty('options');
      expect(lockClient.query).toHaveBeenNthCalledWith(3, 'SELECT pg_advisory_lock($1, $2)', [
        ...POSTGRES_BOOT_MIGRATION_LOCK_KEYS,
      ]);
      expect(lockClient.query).toHaveBeenNthCalledWith(4, 'SELECT pg_advisory_unlock($1, $2)', [
        ...POSTGRES_BOOT_MIGRATION_LOCK_KEYS,
      ]);
      expect(runMigrations).toHaveBeenCalledWith({ transaction: 'all' });
      // The migration pool is torn down; the returned runtime one sets the statement timeout on connect.
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(await connectStatements(returned.options)).toEqual(["SET TIME ZONE 'UTC'; SET statement_timeout = 30000"]);
    } finally {
      clientCtor.mockRestore();
      initialize.mockRestore();
      query.mockRestore();
      runMigrations.mockRestore();
      destroy.mockRestore();
    }
  });

  // pg emits 'error' on the client when its socket drops outside the client's own end() (failover,
  // pg_terminate_backend, an idle-timeout on the silent wait inside pg_advisory_lock). With no
  // listener that emit throws from the socket handler and kills the process before the failed lock
  // query can reject into the factory's cleanup and Nest's retry loop.
  it('listens for lock-client errors so a dropped connection cannot crash the process', async () => {
    const lockClient = Object.assign(new EventEmitter(), {
      connect: jest.fn(() => Promise.resolve()),
      query: jest.fn(() => Promise.resolve()),
      end: jest.fn(() => Promise.resolve()),
    });
    const clientCtor = jest.spyOn(pg, 'Client').mockImplementation(() => lockClient as unknown as PgClient);
    const { deps } = makeFakes();
    try {
      await createBootDataSource(PG_OPTIONS, { createDataSource: deps.createDataSource });

      expect(lockClient.listenerCount('error')).toBeGreaterThan(0);
      expect(() => lockClient.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
    } finally {
      clientCtor.mockRestore();
    }
  });

  // The lock is session-scoped, so a holder whose lock connection drops has lost it: another replica
  // can start the same chain. The holder must stop migrating and fail the boot, which the retry loop
  // then reruns under a new lock.
  it('stops migrating and fails the boot when the held lock connection drops', async () => {
    let finishChain: () => void = () => undefined;
    const chain = new Promise<void>(resolve => (finishChain = resolve));
    const { calls, deps } = makeFakes(() => chain);
    let onLost: (error: Error) => void = () => undefined;
    const createLockClient = deps.createLockClient as jest.Mock;
    const lockClient = createLockClient.getMockImplementation()!() as AdvisoryLockClient;
    createLockClient.mockImplementation((_config: ClientConfig, lost: (error: Error) => void) => {
      onLost = lost;
      return lockClient;
    });

    const boot = createBootDataSource(PG_OPTIONS, deps);
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toContain('runMigrations');

    onLost(new Error('Connection terminated unexpectedly'));
    expect(calls.filter(c => c === 'destroy')).toHaveLength(1);
    finishChain();

    await expect(boot).rejects.toThrow(/lock connection lost while migrating/);
    // The runtime DataSource is never built on a chain that ran partly unlocked.
    expect(calls.filter(c => c === 'initialize')).toHaveLength(1);
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
