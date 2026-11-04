/* istanbul ignore file -- PG-gated: only runs under DATABASE_TYPE=postgres with pg_dump and psql on PATH. */
import 'reflect-metadata';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { createBootDataSource } from '../../pg-boot-migrations';
import { BuiltInFtsProvider } from '../../../modules/search/providers/builtin-fts.provider';

const POSTGRES_ENABLED = process.env.DATABASE_TYPE === 'postgres';
const hasTool = (tool: string): boolean => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0;

/**
 * A POSTGRES_SCHEMA provisioned by another role (docs/05: "a schema provisioned by the provider", or `CREATE SCHEMA`
 * run by an administrator), with the app's role granted USAGE and CREATE on it. The app runs there, contains search
 * builds its trigram index with pg_trgm and unaccent in that schema, and backup.sh archives the schema. The index
 * expression runs as the table owner, which pg_dump grants USAGE on the schema only in its closing ACL pass, so the
 * archive has to create the index after that pass, or no role can load it.
 */
(POSTGRES_ENABLED && hasTool('pg_dump') && hasTool('psql') ? describe : describe.skip)(
  'scoped backup of a schema another role owns',
  () => {
    const repo = path.join(__dirname, '..', '..', '..', '..');
    const host = process.env.DATABASE_HOST || 'localhost';
    const port = Number(process.env.DATABASE_PORT || 5432);
    const superuser = {
      username: process.env.DATABASE_USERNAME || 'openwa',
      password: process.env.DATABASE_PASSWORD || 'openwa',
    };
    const schema = 'granted_app';
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

    const connect = (database: string) =>
      new DataSource({ type: 'postgres', host, port, ...superuser, database }).initialize();
    const boot = (role: string, database: string) =>
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
    /** What the restored schema must hold: its row, a valid trigram index, and the search extensions in it. */
    const state = async (database: string): Promise<unknown> => {
      const ds = await connect(database);
      try {
        const [row] = await ds.query<unknown[]>(
          `SELECT (SELECT count(*)::int FROM "${schema}".messages) AS messages,
                  (SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('"${schema}".idx_messages_body_trgm'))
                    AS trigram,
                  (SELECT count(*)::int FROM pg_extension WHERE extnamespace = to_regnamespace($1)) AS extensions,
                  (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE $1 || '_pre_restore_%') AS aside`,
          [schema],
        );
        return row;
      } finally {
        await ds.destroy();
      }
    };

    it('loads into an empty database and in place once contains search has built its index', async () => {
      const role = `granted_role_${process.pid}`;
      const source = `granted_src_${process.pid}`;
      const target = `granted_dst_${process.pid}`;
      const work = mkdtempSync(path.join(tmpdir(), 'openwa-granted-backup-'));
      try {
        await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${role}'`);
        await admin.query(`CREATE DATABASE "${source}"`);
        await admin.query(`CREATE DATABASE "${target}"`);
        await admin.query(`GRANT CREATE ON DATABASE "${source}" TO "${role}"`);
        const setup = await connect(source);
        // Owned by the superuser that ran it, not by the app's role.
        await setup.query(`CREATE SCHEMA "${schema}"`);
        await setup.query(`GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "${role}"`);
        await setup.destroy();

        const app = await boot(role, source);
        await app.query(`INSERT INTO sessions (id, name, status, config) VALUES ('s-1', 'one', 'disconnected', '{}')`);
        await app.query(
          `INSERT INTO messages (id, "sessionId", "waMessageId", "chatId", "from", "to", body, type, direction, status)
           VALUES ('m-1', 's-1', 'wa-1', 'c@c.us', 'c@c.us', 'me@c.us', 'searchable words', 'text', 'incoming', 'read')`,
        );
        const provider = new BuiltInFtsProvider(app, new ConfigService({ search: { containsEnabled: true } }));
        await provider.buildContainsIndex();
        provider.onModuleDestroy();
        await app.destroy();
        expect(await state(source)).toEqual({ messages: 1, trigram: true, extensions: 2, aside: 0 });

        mkdirSync(path.join(work, 'src', 'data'), { recursive: true });
        writeFileSync(path.join(work, 'src', 'data', 'main.sqlite'), '');
        const backup = spawnSync('bash', [path.join(repo, 'scripts', 'backup.sh')], {
          cwd: path.join(work, 'src'),
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
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
        expect(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })).toContain('./database.schema');
        mkdirSync(path.join(work, 'dst'));
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

        // The superuser: into an empty database, the disaster-recovery load the runbook prints, then into the
        // database the dump came from, where the schema is moved aside first.
        for (const [database, aside] of [
          [target, 0],
          [source, 1],
        ] as const) {
          const run = spawnSync('bash', ['-c', load!], {
            cwd: path.join(work, 'dst'),
            encoding: 'utf8',
            env: {
              PATH: process.env.PATH,
              DATABASE_URL: `postgres://${superuser.username}:${superuser.password}@${host}:${port}/${database}`,
            },
          });
          const errors = run.stderr.split('\n').filter(line => line.includes('ERROR'));
          expect({ database, status: run.status, errors }).toEqual({ database, status: 0, errors: [] });
          expect(await state(database)).toEqual({ messages: 1, trigram: true, extensions: 2, aside });

          // The app boots on the result as its own role and its contains search reads the restored index.
          const restored = await boot(role, database);
          try {
            const [{ hits }] = await restored.query<Array<{ hits: number }>>(
              `SELECT count(*)::int AS hits FROM messages WHERE openwa_unaccent(body) LIKE '%earchab%'`,
            );
            expect(hits).toBe(1);
          } finally {
            await restored.destroy();
          }
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
        await admin.query(`DROP DATABASE IF EXISTS "${source}" WITH (FORCE)`);
        await admin.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`);
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      }
    }, 240_000);
  },
);
