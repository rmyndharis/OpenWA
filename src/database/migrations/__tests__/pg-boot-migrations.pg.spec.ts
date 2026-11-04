/* istanbul ignore file -- PG-gated: only runs under DATABASE_TYPE=postgres (test-postgres CI job);
   skipped in the default test job, so its lines would be unread and skew the global coverage gate. */
import 'reflect-metadata';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { createBootDataSource } from '../../pg-boot-migrations';
import { BuiltInFtsProvider } from '../../../modules/search/providers/builtin-fts.provider';

/**
 * Postgres runtime coverage for the boot-migration advisory lock. Two "replicas" (independent
 * boot paths sharing nothing but the database) start migrating CONCURRENTLY; without the lock
 * both would see an empty migrations ledger and race DDL (duplicate tables / deadlocks). With the
 * lock, one applies the chain while the other blocks in pg_advisory_lock, then applies nothing.
 *
 * Gating: mirrors the repo's PG harness convention exactly (scripts/pg-uuid-smoke.js + the
 * "Test (PostgreSQL migrations)" CI job + 1782400000000-AddMessagesFts.pg.spec.ts) — skip the
 * whole suite unless DATABASE_TYPE=postgres is set; the CI job runs it against a postgres:16
 * service, locally it skips cleanly.
 */
const POSTGRES_ENABLED = process.env.DATABASE_TYPE === 'postgres';

(POSTGRES_ENABLED ? describe : describe.skip)('postgres boot migrations (advisory lock)', () => {
  const schema = process.env.POSTGRES_SCHEMA || 'public';
  const useCustomSearchPath = schema !== 'public';
  let admin: DataSource;

  const connectionOptions = {
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'openwa',
    password: process.env.DATABASE_PASSWORD || 'openwa',
    database: process.env.DATABASE_NAME || 'openwa',
  };

  // The exact options shape app.module.ts hands to createBootDataSource for the postgres data
  // connection: full migration chain, non-public schema via pg's startup search_path (see
  // pg-uuid-smoke.js for why the `options` parameter — not TypeORM's `schema` — is what routes
  // raw DDL to the schema).
  const bootMigratorOptions = (): DataSourceOptions => ({
    type: 'postgres',
    ...connectionOptions,
    migrations: [path.join(__dirname, '..', '*{.ts,.js}')],
    ...(useCustomSearchPath ? { extra: { options: `-c search_path=${schema},public` } } : {}),
  });

  beforeEach(async () => {
    admin = new DataSource({ type: 'postgres', ...connectionOptions });
    await admin.initialize();
    // Fresh schema each test: the CI job shares one service across steps, so wipe whatever the
    // pg-smoke step (or a previous test) left behind — tables AND the migrations ledger.
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${schema}"`);
  });

  afterEach(async () => {
    if (admin && admin.isInitialized) {
      await admin.destroy();
    }
  });

  it('serializes two concurrent boot migrators: both resolve, ledger holds one row per migration', async () => {
    // Promise.all starts both boot paths before either can finish — the exact race replicas
    // hit when a deployment scales up against one shared Postgres.
    const [a, b] = await Promise.all([
      createBootDataSource(bootMigratorOptions()),
      createBootDataSource(bootMigratorOptions()),
    ]);

    try {
      const expected = a.migrations.length; // the full chain, loaded from the same glob
      // Unqualified name: resolves through the same session search_path the ledger was written
      // under, exactly like the raw migration SQL.
      const ledger: Array<{ name: string }> = await a.query(`SELECT name FROM "migrations"`);
      expect(ledger).toHaveLength(expected);
      // No migration applied twice — the double-apply shape concurrent migrationsRun produces.
      expect(new Set(ledger.map(row => row.name)).size).toBe(expected);
    } finally {
      await a.destroy();
      await b.destroy();
    }
  }, 120_000);
});

(POSTGRES_ENABLED ? describe : describe.skip)('docs/05 index maintenance queries on a chain-built database', () => {
  // The REINDEX line of the same block rewrites a real table and needs no check of its column names.
  const selects = (): string[] => {
    const doc = readFileSync(path.join(__dirname, '..', '..', '..', '..', 'docs', '05-database-design.md'), 'utf8');
    const block = /```sql\n([\s\S]*?)```/.exec(doc.slice(doc.indexOf('### Index Maintenance')))?.[1] ?? '';
    return block
      .split(';')
      .map(statement => statement.replace(/^\s*--.*$/gm, '').trim())
      .filter(statement => statement.startsWith('SELECT'));
  };

  it('runs every SELECT the block hands operators, as written', async () => {
    const ds = await createBootDataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'openwa',
      password: process.env.DATABASE_PASSWORD || 'openwa',
      database: process.env.DATABASE_NAME || 'openwa',
      migrations: [path.join(__dirname, '..', '*{.ts,.js}')],
    });
    try {
      const statements = selects();
      expect(statements).toHaveLength(2);
      for (const statement of statements) {
        await expect(ds.query(statement)).resolves.toEqual(expect.any(Array));
      }
    } finally {
      await ds.destroy();
    }
  }, 120_000);
});

/**
 * The session settings the data connection relies on, read back on every pooled connection: the runtime
 * statement_timeout, the configured search_path and the UTC zone. Directly against PostgreSQL, and through
 * PgBouncer in session mode when PGBOUNCER_PORT names one in front of the same server (docs/05 allows a
 * session-mode pooler; PgBouncer refuses statement_timeout in the startup packet).
 */
(POSTGRES_ENABLED ? describe : describe.skip)('data connection session settings on every pooled connection', () => {
  const host = process.env.DATABASE_HOST || 'localhost';
  const credentials = {
    username: process.env.DATABASE_USERNAME || 'openwa',
    password: process.env.DATABASE_PASSWORD || 'openwa',
  };
  const directPort = Number(process.env.DATABASE_PORT || 5432);
  const poolerPort = process.env.PGBOUNCER_PORT ? Number(process.env.PGBOUNCER_PORT) : undefined;
  let admin: DataSource;

  beforeAll(async () => {
    admin = await new DataSource({
      type: 'postgres',
      host,
      port: directPort,
      ...credentials,
      database: process.env.DATABASE_NAME || 'openwa',
    }).initialize();
  });

  afterAll(async () => {
    await admin?.destroy();
  });

  // The options app.module.ts builds for the data connection.
  const appOptions = (port: number, database: string, schema: string): DataSourceOptions => ({
    type: 'postgres',
    schema,
    host,
    port,
    ...credentials,
    database,
    migrations: [path.join(__dirname, '..', '*{.ts,.js}')],
    migrationsRun: true,
    extra: {
      max: 10,
      statement_timeout: 30000,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ...(schema !== 'public' ? { options: `-c search_path=${schema},public` } : {}),
    },
  });

  /** What four connections held at once report, so four pooled clients answer. */
  const settings = async (ds: DataSource): Promise<unknown[]> => {
    const runners = await Promise.all(
      [0, 1, 2, 3].map(async () => {
        const runner = ds.createQueryRunner();
        await runner.connect();
        return runner;
      }),
    );
    try {
      return await Promise.all(
        runners.map(async runner => {
          const [row] = (await runner.query(
            `SELECT current_setting('statement_timeout') AS timeout, current_setting('search_path') AS path,
                    current_setting('TimeZone') AS zone, to_regclass('messages') IS NOT NULL AS messages`,
          )) as unknown[];
          return row;
        }),
      );
    } finally {
      await Promise.all(runners.map(runner => runner.release()));
    }
  };

  const cases: Array<[string, number | undefined, string]> = [
    ['directly', directPort, 'public'],
    ['directly', directPort, 'boot_settings_schema'],
    ['through PgBouncer in session mode', poolerPort, 'public'],
    ['through PgBouncer in session mode', poolerPort, 'boot_settings_schema'],
  ];

  it.each(cases)(
    '%s (port %s), schema %s: boots, and every connection carries them, also after a reconnect',
    async (_how, port, schema) => {
      if (port === undefined) return; // no pooler configured for this run
      const database = `boot_settings_${process.pid}_${port}_${schema}`.slice(0, 63);
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${database}"`);
      if (schema !== 'public') {
        const scoped = await new DataSource({
          type: 'postgres',
          host,
          port: directPort,
          ...credentials,
          database,
        }).initialize();
        await scoped.query(`CREATE SCHEMA "${schema}"`);
        await scoped.destroy();
      }
      const expected = {
        timeout: '30s',
        path: schema === 'public' ? '"$user", public' : `${schema},public`,
        zone: 'UTC',
        messages: true,
      };
      const ds = await createBootDataSource(appOptions(port, database, schema));
      try {
        expect(await settings(ds)).toEqual([expected, expected, expected, expected]);
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database],
        );
        await new Promise(resolve => setTimeout(resolve, 300));
        let after: unknown[] = [];
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            after = await settings(ds);
            break;
          } catch {
            // A pooled client still holding a terminated backend fails once and leaves the pool.
          }
        }
        expect(after).toEqual([expected, expected, expected, expected]);
      } finally {
        await ds.destroy();
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      }
    },
    120_000,
  );

  it('keeps the runtime bound on the connection the contains index build lifted it on', async () => {
    const database = `boot_settings_${process.pid}_trigram`;
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${database}"`);
    const ds = await createBootDataSource(appOptions(directPort, database, 'public'));
    try {
      const provider = new BuiltInFtsProvider(ds, new ConfigService({ search: { containsEnabled: true } }));
      await provider.buildContainsIndex();
      const [{ valid }] = await ds.query<Array<{ valid: boolean }>>(
        `SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass('idx_messages_body_trgm')`,
      );
      expect(valid).toBe(true);
      // The pool hands out its last released connection first, so the build's own is among these.
      const timeouts = (await settings(ds)).map(row => (row as { timeout: string }).timeout);
      expect(timeouts).toEqual(['30s', '30s', '30s', '30s']);
      provider.onModuleDestroy();
    } finally {
      await ds.destroy();
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    }
  }, 120_000);
});

/**
 * scripts/backup.sh on a database shared with another application through POSTGRES_SCHEMA, run as a role that
 * cannot read the neighbour's schema, then the load restore.sh prints for that archive, into an empty database
 * and, as that role, into the database it came from, and the boot chain over the result. Contains search is on,
 * with its extensions in public and, installed by the app itself, in the app's own schema; the neighbour indexes
 * with the same pg_trgm. Needs pg_dump and psql on PATH.
 */
const hasTool = (tool: string): boolean => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0;
(POSTGRES_ENABLED && hasTool('pg_dump') && hasTool('psql') ? describe : describe.skip)(
  'backup.sh and restore.sh on a schema of a shared database',
  () => {
    const repo = path.join(__dirname, '..', '..', '..', '..');
    const host = process.env.DATABASE_HOST || 'localhost';
    const port = Number(process.env.DATABASE_PORT || 5432);
    const superuser = {
      username: process.env.DATABASE_USERNAME || 'openwa',
      password: process.env.DATABASE_PASSWORD || 'openwa',
    };
    const schema = 'shared_app';
    let admin: DataSource;

    beforeAll(async () => {
      admin = await new DataSource({
        type: 'postgres',
        host,
        port,
        ...superuser,
        database: process.env.DATABASE_NAME || 'openwa',
      }).initialize();
    });

    afterAll(async () => {
      await admin?.destroy();
    });

    const boot = (role: string, database: string): Promise<DataSource> =>
      createBootDataSource({
        type: 'postgres',
        schema,
        host,
        port,
        username: role,
        password: role,
        database,
        migrations: [path.join(__dirname, '..', '*{.ts,.js}')],
        migrationsRun: true,
        extra: { statement_timeout: 30000, connectionTimeoutMillis: 10000 },
      });
    /** What a restore has to bring back. */
    const fingerprint = async (ds: DataSource): Promise<unknown> => {
      const [row] = await ds.query<unknown[]>(
        `SELECT (SELECT count(*)::int FROM migrations) AS ledger,
                (SELECT count(*)::int FROM pg_constraint WHERE contype = 'f' AND connamespace = to_regnamespace($1)) AS fks,
                (SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('idx_messages_body_trgm')) AS trigram,
                (SELECT count(*)::int FROM messages WHERE body_ts @@ plainto_tsquery('simple', 'searchable')) AS hits,
                (SELECT count(*)::int FROM messages WHERE openwa_unaccent(body) LIKE '%earchab%') AS contains`,
        [schema],
      );
      return row;
    };

    it.each(['public', 'app'])(
      'with the search extensions in the %s schema: backs up, and loads into an empty and into its own database',
      async placement => {
        const role = `shared_role_${process.pid}_${placement}`;
        const source = `shared_src_${process.pid}_${placement}`;
        const target = `shared_dst_${process.pid}_${placement}`;
        const work = mkdtempSync(path.join(tmpdir(), 'openwa-schema-backup-'));
        const scoped = async (database: string): Promise<DataSource> =>
          new DataSource({ type: 'postgres', host, port, ...superuser, database }).initialize();
        try {
          await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${role}'`);
          await admin.query(`CREATE DATABASE "${source}"`);
          await admin.query(`CREATE DATABASE "${target}"`);
          const setup = await scoped(source);
          await setup.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${role}"`);
          await setup.query(`CREATE SCHEMA other_app`);
          await setup.query(`CREATE TABLE other_app.ledger (id int PRIMARY KEY, note text)`);
          await setup.query(`INSERT INTO other_app.ledger VALUES (1)`);
          if (placement === 'public') {
            // Installed, and so owned, by another role before the app starts.
            await setup.query(`CREATE EXTENSION pg_trgm`);
            await setup.query(`CREATE EXTENSION unaccent`);
          }
          // The role may create schemas and extensions, as the in-place load needs. With none in public yet, the
          // app's own CREATE EXTENSION lands in the first schema of its search_path.
          await setup.query(`GRANT CREATE ON DATABASE "${source}" TO "${role}"`);
          await setup.destroy();

          const app = await boot(role, source);
          await app.query(
            `INSERT INTO sessions (id, name, status, config) VALUES ('s-1', 'one', 'disconnected', '{}')`,
          );
          await app.query(
            `INSERT INTO messages (id, "sessionId", "waMessageId", "chatId", "from", "to", body, type, direction, status)
             VALUES ('m-1', 's-1', 'wa-1', 'c@c.us', 'c@c.us', 'me@c.us', 'searchable words', 'text', 'incoming', 'read')`,
          );
          const provider = new BuiltInFtsProvider(app, new ConfigService({ search: { containsEnabled: true } }));
          await provider.buildContainsIndex();
          provider.onModuleDestroy();
          const [{ home }] = await app.query<Array<{ home: string }>>(
            `SELECT extnamespace::regnamespace::text AS home FROM pg_extension WHERE extname = 'pg_trgm'`,
          );
          expect(home).toBe(placement === 'public' ? 'public' : schema);
          const expected = await fingerprint(app);
          expect(expected).toMatchObject({ trigram: true, hits: 1, contains: 1 });
          await app.destroy();
          // Extensions are per database, so the neighbour can index with the pg_trgm wherever the app found it.
          const otherApp = await scoped(source);
          await otherApp.query(
            `CREATE INDEX ledger_note_trgm ON other_app.ledger USING gin (note "${home}".gin_trgm_ops)`,
          );
          await otherApp.destroy();

          mkdirSync(path.join(work, 'src', 'data'), { recursive: true });
          mkdirSync(path.join(work, 'dst'));
          // An empty file is an empty SQLite database, for both sqlite3 .backup and the copy without it.
          writeFileSync(path.join(work, 'src', 'data', 'main.sqlite'), '');
          const backup = spawnSync('bash', [path.join(repo, 'scripts', 'backup.sh')], {
            cwd: path.join(work, 'src'),
            encoding: 'utf8',
            env: {
              PATH: process.env.PATH,
              HOME: work,
              PG_HOST_PORT: process.env.PG_HOST_PORT,
              BACKUP_DIR: path.join(work, 'out'),
              DATABASE_TYPE: 'postgres',
              POSTGRES_SCHEMA: schema,
              DATABASE_HOST: host,
              DATABASE_PORT: String(port),
              DATABASE_USERNAME: role,
              DATABASE_PASSWORD: role,
              DATABASE_NAME: source,
            },
          });
          expect(backup.stderr + backup.stdout).toContain('Backup complete');
          const [archive] = readdirSync(path.join(work, 'out')).map(name => path.join(work, 'out', name));
          const dump = execFileSync('tar', ['-xzOf', archive, './database.sql'], { encoding: 'utf8' });
          expect(dump).not.toContain('other_app');

          const restore = spawnSync('bash', [path.join(repo, 'scripts', 'restore.sh'), archive], {
            cwd: path.join(work, 'dst'),
            encoding: 'utf8',
            env: { PATH: process.env.PATH, HOME: work },
          });
          const load = restore.stdout
            .split('\n')
            .find(line => line.includes('psql --single-transaction'))
            ?.replace(/^\[restore\]\s+/, '');
          expect(load).toBeDefined();
          const loadAs = (user: string, password: string, database: string) =>
            spawnSync('bash', ['-c', load!], {
              cwd: path.join(work, 'dst'),
              encoding: 'utf8',
              env: {
                PATH: process.env.PATH,
                PG_HOST_PORT: process.env.PG_HOST_PORT,
                DATABASE_URL: `postgres://${user}:${password}@${host}:${port}/${database}`,
              },
            });

          if (placement === 'app') {
            // The neighbour's index stands on the pg_trgm that would move aside with the app's schema: the load
            // refuses to drop it and changes nothing. Without that index it goes through below.
            const refused = loadAs(role, role, source);
            const check = await scoped(source);
            const [state] = await check.query<unknown[]>(
              `SELECT to_regnamespace($1::text) IS NOT NULL AS schema,
                      (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE $1::text || '_pre_restore_%') AS aside,
                      (SELECT count(*)::int FROM pg_extension WHERE extnamespace::regnamespace::text = $1) AS extensions,
                      to_regclass('other_app.ledger_note_trgm') IS NOT NULL AS neighbour`,
              [schema],
            );
            await check.query(`DROP INDEX IF EXISTS other_app.ledger_note_trgm`);
            await check.destroy();
            expect({
              status: refused.status,
              refused: /cannot drop extension pg_trgm because other objects depend on it/.test(refused.stderr),
              state,
            }).toEqual({ status: 3, refused: true, state: { schema: true, aside: 0, extensions: 2, neighbour: true } });
          }

          // Into an empty database as the superuser, and into its own database as the app's role.
          for (const [user, password, database] of [
            [superuser.username, superuser.password, target],
            [role, role, source],
          ]) {
            const run = loadAs(user, password, database);
            const errors = run.stderr.split('\n').filter(line => line.includes('ERROR'));
            expect({ database, status: run.status, errors }).toEqual({ database, status: 0, errors: [] });
            const restored = await boot(role, database);
            try {
              expect(await fingerprint(restored)).toEqual(expected);
            } finally {
              await restored.destroy();
            }
          }
          const after = await scoped(source);
          try {
            const [{ rows }] = await after.query<Array<{ rows: number }>>(
              `SELECT count(*)::int AS rows FROM other_app.ledger`,
            );
            const aside = await after.query<Array<{ nspname: string }>>(
              `SELECT nspname FROM pg_namespace WHERE nspname LIKE '${schema}_pre_restore_%'`,
            );
            expect(rows).toBe(1);
            expect(aside).toHaveLength(1);
            // The copy keeps its rows. Its trigram index goes only with a pg_trgm that moved aside with it, and the
            // neighbour's index on the pg_trgm in public stays.
            const [copy] = await after.query<unknown[]>(
              `SELECT (SELECT count(*)::int FROM "${aside[0].nspname}".messages) AS messages,
                      to_regclass('"${aside[0].nspname}".idx_messages_body_trgm') IS NOT NULL AS trigram,
                      to_regclass('other_app.ledger_note_trgm') IS NOT NULL AS neighbour`,
            );
            const kept = placement === 'public';
            expect(copy).toEqual({ messages: 1, trigram: kept, neighbour: kept });
          } finally {
            await after.destroy();
          }
          const empty = await scoped(target);
          const [{ neighbour }] = await empty.query<Array<{ neighbour: string | null }>>(
            `SELECT to_regnamespace('other_app')::text AS neighbour`,
          );
          await empty.destroy();
          expect(neighbour).toBeNull();
        } finally {
          rmSync(work, { recursive: true, force: true });
          await admin.query(`DROP DATABASE IF EXISTS "${source}" WITH (FORCE)`);
          await admin.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`);
          await admin.query(`DROP ROLE IF EXISTS "${role}"`);
        }
      },
      180_000,
    );

    // pgcrypto in the app schema is the PostgreSQL 12 layout; one in a schema of its own (a platform's `extensions`)
    // is unused from 13 on, and the archive must load without it, as it did before pgcrypto was ever dumped.
    it.each(['app', 'extensions'])(
      'with pgcrypto in the %s schema: loads into an empty and into its own database',
      async placement => {
        const inApp = placement === 'app';
        const role = `shared_role_${process.pid}_pgcrypto_${placement}`;
        const source = `shared_src_${process.pid}_pgcrypto_${placement}`;
        const target = `shared_dst_${process.pid}_pgcrypto_${placement}`;
        const work = mkdtempSync(path.join(tmpdir(), 'openwa-schema-backup-'));
        const scoped = async (database: string): Promise<DataSource> =>
          new DataSource({ type: 'postgres', host, port, ...superuser, database }).initialize();
        const tools = { PATH: process.env.PATH, PG_HOST_PORT: process.env.PG_HOST_PORT };
        try {
          await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${role}'`);
          await admin.query(`CREATE DATABASE "${source}"`);
          await admin.query(`CREATE DATABASE "${target}"`);
          const setup = await scoped(source);
          await setup.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${role}"`);
          await setup.query(`GRANT CREATE ON DATABASE "${source}" TO "${role}"`);
          if (!inApp) {
            await setup.query(`CREATE SCHEMA extensions`);
            await setup.query(`CREATE EXTENSION pgcrypto WITH SCHEMA extensions`);
          }
          await setup.destroy();

          const app = await boot(role, source);
          if (inApp) {
            // Before PostgreSQL 13 gen_random_uuid() is pgcrypto's, and the migrations create pgcrypto under the app's
            // search_path, in its schema, so every id default calls that schema's copy by name. Rebuilt here on 13+.
            await app.query(`CREATE EXTENSION pgcrypto WITH SCHEMA "${schema}"`);
            const ids = await app.query<Array<{ name: string }>>(
              `SELECT table_name AS name FROM information_schema.columns
              WHERE table_schema = $1 AND column_name = 'id' AND column_default LIKE '%gen_random_uuid()%'`,
              [schema],
            );
            expect(ids.length).toBeGreaterThan(0);
            for (const { name } of ids) {
              await app.query(
                `ALTER TABLE "${schema}"."${name}" ALTER COLUMN id SET DEFAULT "${schema}".gen_random_uuid()::varchar`,
              );
            }
          }
          await app.query(`INSERT INTO sessions (name, status, config) VALUES ('one', 'disconnected', '{}')`);
          await app.destroy();

          mkdirSync(path.join(work, 'src', 'data'), { recursive: true });
          mkdirSync(path.join(work, 'dst'));
          writeFileSync(path.join(work, 'src', 'data', 'main.sqlite'), '');
          const backup = spawnSync('bash', [path.join(repo, 'scripts', 'backup.sh')], {
            cwd: path.join(work, 'src'),
            encoding: 'utf8',
            env: {
              ...tools,
              HOME: work,
              BACKUP_DIR: path.join(work, 'out'),
              DATABASE_TYPE: 'postgres',
              POSTGRES_SCHEMA: schema,
              DATABASE_HOST: host,
              DATABASE_PORT: String(port),
              DATABASE_USERNAME: role,
              DATABASE_PASSWORD: role,
              DATABASE_NAME: source,
            },
          });
          expect(backup.stderr + backup.stdout).toContain('Backup complete');
          const [archive] = readdirSync(path.join(work, 'out')).map(name => path.join(work, 'out', name));
          const restore = spawnSync('bash', [path.join(repo, 'scripts', 'restore.sh'), archive], {
            cwd: path.join(work, 'dst'),
            encoding: 'utf8',
            env: { PATH: process.env.PATH, HOME: work },
          });
          const load = restore.stdout
            .split('\n')
            .find(line => line.includes('psql --single-transaction'))
            ?.replace(/^\[restore\]\s+/, '');
          expect(load).toBeDefined();

          // Into an empty database as the superuser, and into its own database as the app's role. The empty database
          // has no `extensions` schema.
          for (const [user, password, database] of [
            [superuser.username, superuser.password, target],
            [role, role, source],
          ]) {
            const run = spawnSync('bash', ['-c', load!], {
              cwd: path.join(work, 'dst'),
              encoding: 'utf8',
              env: { ...tools, DATABASE_URL: `postgres://${user}:${password}@${host}:${port}/${database}` },
            });
            const errors = run.stderr.split('\n').filter(line => line.includes('ERROR'));
            expect({ database, status: run.status, errors }).toEqual({ database, status: 0, errors: [] });
            const check = await scoped(database);
            try {
              const [row] = await check.query<unknown[]>(
                `SELECT (SELECT count(*)::int FROM "${schema}".sessions) AS sessions,
                      (SELECT column_default FROM information_schema.columns
                        WHERE table_schema = $1 AND table_name = 'sessions' AND column_name = 'id') AS "default",
                      (SELECT extnamespace::regnamespace::text FROM pg_extension WHERE extname = 'pgcrypto') AS home`,
                [schema],
              );
              const [inserted] = await check.query<Array<{ id: number }>>(
                `INSERT INTO "${schema}".sessions (name, status, config) VALUES ('two', 'disconnected', '{}')
               RETURNING length(id) AS id`,
              );
              expect({ database, ...(row as object), inserted: inserted.id }).toEqual({
                database,
                sessions: 1,
                default: inApp
                  ? `(${schema}.gen_random_uuid())::character varying`
                  : '(gen_random_uuid())::character varying',
                home: inApp ? schema : database === source ? 'extensions' : null,
                inserted: 36,
              });
            } finally {
              await check.destroy();
            }
            const restored = await boot(role, database);
            await restored.destroy();
          }
          // The copy moved aside keeps its rows. With pgcrypto in the schema its id defaults went with the pgcrypto it
          // held, as nothing else could take the dump's own pgcrypto into the schema; otherwise they stay.
          const after = await scoped(source);
          try {
            const [{ aside }] = await after.query<Array<{ aside: string }>>(
              `SELECT nspname AS aside FROM pg_namespace WHERE nspname LIKE '${schema}_pre_restore_%'`,
            );
            const [copy] = await after.query<unknown[]>(
              `SELECT (SELECT count(*)::int FROM "${aside}".sessions) AS sessions,
                    (SELECT column_default FROM information_schema.columns
                      WHERE table_schema = $1 AND table_name = 'sessions' AND column_name = 'id') AS "default"`,
              [aside],
            );
            expect(copy).toEqual({ sessions: 1, default: inApp ? null : '(gen_random_uuid())::character varying' });
          } finally {
            await after.destroy();
          }
          const dump = execFileSync('tar', ['-xzOf', archive, './database.sql'], { encoding: 'utf8' });
          expect(dump.match(/^CREATE EXTENSION IF NOT EXISTS pgcrypto\b.*$/m)?.[0] ?? null).toBe(
            inApp ? `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA ${schema};` : null,
          );
        } finally {
          rmSync(work, { recursive: true, force: true });
          await admin.query(`DROP DATABASE IF EXISTS "${source}" WITH (FORCE)`);
          await admin.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`);
          await admin.query(`DROP ROLE IF EXISTS "${role}"`);
        }
      },
      180_000,
    );
  },
);

/**
 * On PostgreSQL 12 and older gen_random_uuid() is pgcrypto's, and the migrations call it unqualified. A pgcrypto a
 * platform installed in a schema of its own, off the connection's search_path, passes the presence check, so a fresh
 * install has to stop with the schema and the fix named rather than with "function gen_random_uuid() does not exist".
 * From 13 on the function is core and the same layouts boot. A database that ran the chain keeps booting after
 * pgcrypto moves: its defaults are bound to the function, not to its name, and no pending migration asks for it.
 * Written for PostgreSQL 12 as well (no DROP DATABASE ... WITH (FORCE)).
 */
(POSTGRES_ENABLED ? describe : describe.skip)('boot with pgcrypto in a schema off the search_path', () => {
  const connection = {
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'openwa',
    password: process.env.DATABASE_PASSWORD || 'openwa',
  };
  const database = `pgcrypto_elsewhere_${process.pid}`;
  const REFUSAL =
    /pgcrypto extension, which is installed in schema "extensions".*ALTER EXTENSION pgcrypto SET SCHEMA public/;
  let admin: DataSource;
  let serverVersion: number;

  const dropDatabase = async (): Promise<void> => {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  };

  const onDatabase = async (...statements: string[]): Promise<void> => {
    const setup = await new DataSource({ type: 'postgres', ...connection, database }).initialize();
    try {
      for (const statement of statements) await setup.query(statement);
    } finally {
      await setup.destroy();
    }
  };

  // The options app.module.ts hands createBootDataSource for the data connection.
  const boot = (schema: string): Promise<DataSource> =>
    createBootDataSource({
      type: 'postgres',
      ...connection,
      database,
      migrations: [path.join(__dirname, '..', '*{.ts,.js}')],
      ...(schema !== 'public' ? { schema, extra: { options: `-c search_path=${schema},public` } } : {}),
    });

  const bootAndInsert = async (schema: string): Promise<void> => {
    const app = await boot(schema);
    try {
      const [row] = await app.query<Array<{ id: string }>>(
        `INSERT INTO sessions (name, status, config) VALUES ('one', 'disconnected', '{}') RETURNING id`,
      );
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await app.destroy();
    }
  };

  beforeAll(async () => {
    admin = await new DataSource({
      type: 'postgres',
      ...connection,
      database: process.env.DATABASE_NAME || 'openwa',
    }).initialize();
    const [{ num }] = await admin.query<Array<{ num: number }>>(
      `SELECT current_setting('server_version_num')::int AS num`,
    );
    serverVersion = num;
  });

  beforeEach(async () => {
    await dropDatabase();
    await admin.query(`CREATE DATABASE "${database}"`);
  });

  afterAll(async () => {
    await dropDatabase();
    await admin.destroy();
  });

  it.each([
    ['public', 'the server default'],
    ['app', 'a database search_path that names the extension schema, which the app schema replaces'],
  ])(
    'a fresh install with POSTGRES_SCHEMA=%s and %s: refused naming the schema before 13, boots from 13',
    async schema => {
      await onDatabase(
        'CREATE SCHEMA extensions',
        'CREATE EXTENSION pgcrypto WITH SCHEMA extensions',
        ...(schema !== 'public'
          ? [`CREATE SCHEMA ${schema}`, `ALTER DATABASE "${database}" SET search_path = "$user", public, extensions`]
          : []),
      );
      if (serverVersion < 130000) {
        await expect(boot(schema)).rejects.toThrow(REFUSAL);
        // The fix the message names.
        await onDatabase('ALTER EXTENSION pgcrypto SET SCHEMA public');
      }
      await bootAndInsert(schema);
    },
    180_000,
  );

  it('a fresh install whose database search_path reaches the extension schema boots', async () => {
    await onDatabase(
      'CREATE SCHEMA extensions',
      'CREATE EXTENSION pgcrypto WITH SCHEMA extensions',
      `ALTER DATABASE "${database}" SET search_path = "$user", public, extensions`,
    );
    await bootAndInsert('public');
  }, 120_000);

  it('a migrated database whose pgcrypto moved off the search_path still boots and fills ids', async () => {
    await onDatabase('CREATE EXTENSION pgcrypto WITH SCHEMA public');
    await (await boot('public')).destroy();
    await onDatabase('CREATE SCHEMA extensions', 'ALTER EXTENSION pgcrypto SET SCHEMA extensions');
    await bootAndInsert('public');
  }, 180_000);
});
