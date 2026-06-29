import { DataSource } from 'typeorm';
import { ScopeBatchIdUniqueToSession1781800000000 } from '../1781800000000-ScopeBatchIdUniqueToSession';

/**
 * The baseline (1770108659848) created `message_batches` with a GLOBAL `UNIQUE(batch_id)`, so a
 * batch id used by one session denied it to every other session — and, after the app-level check was
 * scoped to the session, that denial surfaced as an unhandled 500 instead of a clean 4xx. This
 * migration scopes the constraint to `(session_id, batch_id)`. The spec drives a real in-memory
 * SQLite schema (the baseline DDL) so it exercises the actual constraint, not a mocked repository.
 */
describe('ScopeBatchIdUniqueToSession migration', () => {
  let ds: DataSource;

  // Exact baseline SQLite DDL for message_batches (1770108659848), including the global UNIQUE.
  const BASELINE_DDL =
    `CREATE TABLE "message_batches" ("id" varchar PRIMARY KEY NOT NULL, "batch_id" varchar NOT NULL, ` +
    `"session_id" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "messages" text NOT NULL, ` +
    `"options" text, "progress" text, "results" text, "current_index" integer NOT NULL DEFAULT (0), ` +
    `"created_at" datetime NOT NULL DEFAULT (datetime('now')), "updated_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
    `"started_at" datetime, "completed_at" datetime, CONSTRAINT "UQ_ff274470c0dbaff6c7d1f9795f5" UNIQUE ("batch_id"))`;

  const insertBatch = (id: string, batchId: string, sessionId: string): Promise<unknown> =>
    ds.query(`INSERT INTO "message_batches" ("id","batch_id","session_id","messages") VALUES (?,?,?,'[]')`, [
      id,
      batchId,
      sessionId,
    ]);

  beforeEach(async () => {
    ds = new DataSource({ type: 'sqlite', database: ':memory:' });
    await ds.initialize();
    await ds.query(BASELINE_DDL);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('allows the same batch_id across sessions but still rejects it within one session', async () => {
    const runner = ds.createQueryRunner();
    await new ScopeBatchIdUniqueToSession1781800000000().up(runner);

    await insertBatch('id1', 'campaign', 's1');
    // Different session, same batch_id — the old global UNIQUE rejected this; the composite allows it.
    await expect(insertBatch('id2', 'campaign', 's2')).resolves.toBeDefined();
    // Same session reusing the batch_id is still a violation — the DB backstop for the app-level check.
    await expect(insertBatch('id3', 'campaign', 's1')).rejects.toThrow();
  });

  it('is idempotent on re-run', async () => {
    const runner = ds.createQueryRunner();
    const migration = new ScopeBatchIdUniqueToSession1781800000000();
    await migration.up(runner);
    await expect(migration.up(runner)).resolves.toBeUndefined();
  });

  it('down() restores the global batch_id uniqueness', async () => {
    const runner = ds.createQueryRunner();
    const migration = new ScopeBatchIdUniqueToSession1781800000000();
    await migration.up(runner);
    await migration.down(runner);

    await insertBatch('id1', 'campaign', 's1');
    // Global uniqueness restored: a different session can no longer reuse the batch_id.
    await expect(insertBatch('id2', 'campaign', 's2')).rejects.toThrow();
  });
});
