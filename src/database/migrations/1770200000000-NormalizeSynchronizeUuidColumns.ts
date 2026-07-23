import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Normalizes a PostgreSQL schema previously bootstrapped with DATABASE_SYNCHRONIZE=true.
 *
 * Under synchronize, `@PrimaryGeneratedColumn('uuid')` creates NATIVE uuid id/FK columns, and every
 * `@ManyToOne(() => Session)` FK column is derived as uuid too. The canonical migration chain, however,
 * builds the schema with varchar ids. The two strategies are not interchangeable on Postgres:
 * `AddUuidDefaultsForPostgres` (1779235200000) is the first migration to touch a uuid column — its
 * `gen_random_uuid()::varchar` DEFAULT on a uuid column is rejected — and later CREATE TABLE migrations
 * (AddTemplates, AddBaileysStoredMessages) cannot add a varchar FK referencing the uuid sessions(id).
 * Because `migrationsRun: true` is hardcoded for the Postgres data connection, this crash-loops boot.
 *
 * Ordered immediately after the baseline (1770108659848) and before that first collision, this migration
 * converts the 9 generated-uuid PKs + 3 session-FK columns to varchar in lockstep (dropping/recreating
 * the CASCADE FKs), then sets the `gen_random_uuid()::varchar` DEFAULTs. It is a no-op on SQLite and on
 * an already-varchar (healthy) Postgres schema via a single information_schema probe.
 *
 * See issue #690. Operational note: `ALTER COLUMN ... TYPE varchar` is a full-table rewrite under an
 * ACCESS EXCLUSIVE lock; for very large `messages` tables, run via the CLI (`npm run migration:run`)
 * against the stopped app during a maintenance window.
 */
export class NormalizeSynchronizeUuidColumns1770200000000 implements MigrationInterface {
  name = 'NormalizeSynchronizeUuidColumns1770200000000';

  // The 9 generated-uuid PKs on the DATA connection. api_keys/audit_logs live on the sqlite 'main'
  // connection (immune). lid_mappings/ingress_events/plugin_instances use a varchar @PrimaryColumn by
  // design — do NOT add them here.
  private readonly uuidPkTables = [
    'sessions',
    'webhooks',
    'messages',
    'message_batches',
    'templates',
    'baileys_stored_messages',
    'webhook_delivery_failures',
    'conversation_mappings',
    'integration_delivery_failures',
  ];

  // The 3 @ManyToOne(() => Session) FK-bearing tables. `name` is the CANONICAL re-add name matching the
  // hasTable-guarded CREATE TABLE migrations (which no-op on a sync-built DB, so they do NOT re-add the
  // FK — this migration owns it). The DROP name is DISCOVERED at runtime: synchronize names constraints
  // with a TypeORM hash, not these canonical names.
  private readonly sessionFks = [
    { table: 'webhooks', column: 'sessionId', name: 'FK_d209715bb62b12255e825580af6' },
    { table: 'templates', column: 'sessionId', name: 'FK_templates_sessionId' },
    { table: 'baileys_stored_messages', column: 'sessionId', name: 'FK_baileys_stored_messages_sessionId' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;
    // Gate: synchronize builds the WHOLE schema atomically (all-uuid, or synchronize itself errors), so a
    // single representative probe on sessions.id is sufficient to detect a drifted schema. Per-column
    // guards inside the loops below add defense-in-depth for the (non-reachable) partial-drift case.
    if (!(await this.columnIsUuid(queryRunner, 'sessions', 'id'))) return;

    await queryRunner.query(`SET LOCAL statement_timeout = 0`);
    await this.ensureGenRandomUuid(queryRunner);

    // 1. Drop FKs referencing sessions(id) FIRST — a uuid FK blocks ALTER of the referenced PK.
    for (const fk of this.sessionFks) {
      if (!(await queryRunner.hasTable(fk.table))) continue;
      for (const c of await this.fkConstraintNames(queryRunner, fk.table, fk.column, 'sessions')) {
        await queryRunner.query(`ALTER TABLE "${fk.table}" DROP CONSTRAINT IF EXISTS "${c}"`);
      }
    }

    // 2. PK uuid -> varchar. DROP DEFAULT first: gen_random_uuid() (native uuid) is not assignment-coercible
    //    to varchar, so Postgres rejects ALTER TYPE while the default is still attached.
    for (const t of this.uuidPkTables) {
      if (!(await queryRunner.hasTable(t))) continue;
      if (!(await this.columnIsUuid(queryRunner, t, 'id'))) continue; // per-column idempotency
      await queryRunner.query(`ALTER TABLE "${t}" ALTER COLUMN "id" DROP DEFAULT`);
      await queryRunner.query(`ALTER TABLE "${t}" ALTER COLUMN "id" TYPE varchar USING "id"::text`);
    }

    // 3. Session-FK columns uuid -> varchar.
    for (const fk of this.sessionFks) {
      if (!(await queryRunner.hasTable(fk.table))) continue;
      if (!(await this.columnIsUuid(queryRunner, fk.table, fk.column))) continue;
      await queryRunner.query(
        `ALTER TABLE "${fk.table}" ALTER COLUMN "${fk.column}" TYPE varchar USING "${fk.column}"::text`,
      );
    }

    // 4. Recreate the 3 CASCADE FKs with canonical names.
    for (const fk of this.sessionFks) {
      if (!(await queryRunner.hasTable(fk.table))) continue;
      await queryRunner.query(
        `ALTER TABLE "${fk.table}" ADD CONSTRAINT "${fk.name}" ` +
          `FOREIGN KEY ("${fk.column}") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
      );
    }

    // 5. gen_random_uuid()::varchar DEFAULT on every existing PK. Mandatory for tables whose CREATE TABLE
    //    migration no-op'd on the sync-built DB; idempotent SET DEFAULT for the rest.
    for (const t of this.uuidPkTables) {
      if (!(await queryRunner.hasTable(t))) continue;
      await queryRunner.query(`ALTER TABLE "${t}" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort inverse (varchar -> native uuid); only meaningful to re-enable synchronize. USING id::uuid
    // validates every value — Postgres aborts on non-uuid strings (no silent corruption).
    if (queryRunner.dataSource.options.type !== 'postgres') return;
    if (await this.columnIsUuid(queryRunner, 'sessions', 'id')) return; // already native uuid: nothing to revert

    await queryRunner.query(`SET LOCAL statement_timeout = 0`);
    await this.ensureGenRandomUuid(queryRunner);

    // Drop FKs (discovered, same as up — robust to either hash or canonical names).
    for (const fk of this.sessionFks) {
      if (!(await queryRunner.hasTable(fk.table))) continue;
      for (const c of await this.fkConstraintNames(queryRunner, fk.table, fk.column, 'sessions')) {
        await queryRunner.query(`ALTER TABLE "${fk.table}" DROP CONSTRAINT IF EXISTS "${c}"`);
      }
    }

    for (const t of this.uuidPkTables) {
      if (!(await queryRunner.hasTable(t))) continue;
      await queryRunner.query(`ALTER TABLE "${t}" ALTER COLUMN "id" DROP DEFAULT`);
      await queryRunner.query(`ALTER TABLE "${t}" ALTER COLUMN "id" TYPE uuid USING "id"::uuid`);
    }

    for (const fk of this.sessionFks) {
      if (!(await queryRunner.hasTable(fk.table))) continue;
      await queryRunner.query(
        `ALTER TABLE "${fk.table}" ALTER COLUMN "${fk.column}" TYPE uuid USING "${fk.column}"::uuid`,
      );
    }

    for (const fk of this.sessionFks) {
      if (!(await queryRunner.hasTable(fk.table))) continue;
      await queryRunner.query(
        `ALTER TABLE "${fk.table}" ADD CONSTRAINT "${fk.name}" ` +
          `FOREIGN KEY ("${fk.column}") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
      );
    }

    for (const t of this.uuidPkTables) {
      if (!(await queryRunner.hasTable(t))) continue;
      await queryRunner.query(`ALTER TABLE "${t}" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()`);
    }
  }

  // --- helpers ---

  private async columnIsUuid(queryRunner: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT udt_name FROM information_schema.columns ` +
        `WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
      [table, column],
    )) as { udt_name?: string }[] | undefined;
    return rows?.[0]?.udt_name === 'uuid';
  }

  // Schema-scoped on BOTH sides so a custom POSTGRES_SCHEMA (search_path `<schema>,public`) does not match
  // a namesake table in public. current_schema() returns the first existing schema in the path.
  private async fkConstraintNames(
    queryRunner: QueryRunner,
    table: string,
    column: string,
    referenced: string,
  ): Promise<string[]> {
    const rows = (await queryRunner.query(
      `SELECT c.conname FROM pg_constraint c ` +
        `JOIN pg_class cl ON c.conrelid = cl.oid JOIN pg_namespace n ON cl.relnamespace = n.oid ` +
        `JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = ANY(c.conkey) ` +
        `JOIN pg_class ref ON c.confrelid = ref.oid JOIN pg_namespace rn ON ref.relnamespace = rn.oid ` +
        `WHERE c.contype = 'f' AND n.nspname = current_schema() AND cl.relname = $1 ` +
        `AND a.attname = $2 AND rn.nspname = current_schema() AND ref.relname = $3`,
      [table, column, referenced],
    )) as { conname: string }[] | undefined;
    return (rows ?? []).map(r => r.conname);
  }

  // gen_random_uuid() is core on PG13+; pgcrypto on <=12. This migration sets varchar DEFAULTs before
  // AddUuidDefaultsForPostgres/AddIntegrationUuidDefaults, so it owns the gate (mirrors their logic).
  private async ensureGenRandomUuid(queryRunner: QueryRunner): Promise<void> {
    const v = (await queryRunner.query(`SELECT current_setting('server_version_num')::int AS num`)) as
      { num?: number | string }[] | undefined;
    const num = Number(v?.[0]?.num ?? 0);
    if (num > 0 && num < 130000) {
      const installed = (await queryRunner.query(`SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto'`)) as
        unknown[] | undefined;
      if (!installed?.length) {
        try {
          await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
        } catch (err) {
          throw new Error(
            `PostgreSQL ${num} (< 13) needs the pgcrypto extension for gen_random_uuid(), but it is ` +
              `not installed and this database role cannot create it. Have a superuser run ` +
              `"CREATE EXTENSION pgcrypto;" once, then restart.`,
            { cause: err },
          );
        }
      }
    }
  }
}
