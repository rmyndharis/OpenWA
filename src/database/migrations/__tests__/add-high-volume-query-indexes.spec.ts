import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { AddHighVolumeQueryIndexes1791900000000 } from '../1791900000000-AddHighVolumeQueryIndexes';

const EXPECTED_INDEXES = {
  messages: [
    'IDX_messages_sessionId_status',
    'IDX_messages_sessionId_direction_createdAt',
    'IDX_messages_status_createdAt',
  ],
  webhook_delivery_failures: [
    'IDX_webhook_delivery_failures_createdAt',
    'IDX_webhook_delivery_failures_sessionId_createdAt',
  ],
  message_batches: ['IDX_message_batches_status_created_at', 'IDX_message_batches_session_id_status'],
  integration_delivery_failures: [
    'IDX_integration_delivery_failures_createdAt',
    'IDX_integration_delivery_failures_sessionId',
    'IDX_integration_delivery_failures_redrive',
  ],
} as const;

const migrationsBeforeTarget = (): unknown[] => {
  const dir = join(__dirname, '..');
  const out: unknown[] = [];
  for (const file of readdirSync(dir)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts') && f < '1791900000000-AddHighVolumeQueryIndexes.ts')
    .sort()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(join(dir, file)) as Record<string, unknown>;
    const Ctor = Object.values(mod).find(
      (v): v is new () => { up: (runner: never) => Promise<void> } =>
        typeof v === 'function' && (v as { prototype?: { up?: unknown } }).prototype?.up !== undefined,
    );
    if (Ctor) out.push(Ctor);
  }
  return out;
};

describe('AddHighVolumeQueryIndexes migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      migrations: migrationsBeforeTarget() as never,
    });
    await ds.initialize();
    await ds.runMigrations({ transaction: 'all' });

    // Seed representative traffic across all four tables so query plans reflect realistic distributions.
    await ds.query(
      `INSERT INTO "sessions" ("id", "name", "status") VALUES ('s1', 's1', 'ready'), ('s2', 's2', 'ready')`,
    );

    const msgRows: string[] = [];
    for (let i = 0; i < 100; i++) {
      const sess = i % 2 === 0 ? 's1' : 's2';
      const dir = i % 2 === 0 ? 'outgoing' : 'incoming';
      const status = i % 10 === 0 ? 'pending' : i % 7 === 0 ? 'failed' : 'sent';
      msgRows.push(
        `('m${i}', '${sess}', 'wa${i}', 'c${i % 5}@c.us', 'from', 'to', 'body', 'text', '${dir}', ${1700000000 + i}, '${status}', '2026-01-01 00:00:${String(i % 60).padStart(2, '0')}')`,
      );
    }
    await ds.query(
      `INSERT INTO "messages" ("id","sessionId","waMessageId","chatId","from","to","body","type","direction","timestamp","status","createdAt") VALUES ${msgRows.join(',')}`,
    );

    const whRows: string[] = [];
    for (let i = 0; i < 60; i++) {
      const sess = i % 2 === 0 ? 's1' : 's2';
      whRows.push(
        `('wdf${i}', 'wh1', '${sess}', 'message.received', 'https://example.test/hook', 'k${i}', 'd${i}', 3, 500, 'err', '2026-01-01 00:00:${String(i % 60).padStart(2, '0')}')`,
      );
    }
    await ds.query(
      `INSERT INTO "webhook_delivery_failures" ("id","webhookId","sessionId","event","url","idempotencyKey","deliveryId","attempts","lastStatusCode","lastError","createdAt") VALUES ${whRows.join(',')}`,
    );

    const batchRows: string[] = [];
    for (let i = 0; i < 40; i++) {
      const sess = i % 2 === 0 ? 's1' : 's2';
      const status = i % 4 === 0 ? 'pending' : i % 4 === 1 ? 'processing' : 'completed';
      batchRows.push(
        `('b${i}', 'batch-${i}', '${sess}', '${status}', '[]', '2026-01-01 00:00:${String(i % 60).padStart(2, '0')}')`,
      );
    }
    await ds.query(
      `INSERT INTO "message_batches" ("id","batch_id","session_id","status","messages","created_at") VALUES ${batchRows.join(',')}`,
    );

    const intRows: string[] = [];
    for (let i = 0; i < 60; i++) {
      const sess = i % 2 === 0 ? 's1' : 's2';
      const redriven = i % 3 === 0 ? 1 : 0;
      intRows.push(
        `('idf${i}', 'inbound', 'plug', 'inst', '${sess}', 'del${i}', ${i % 5}, 'err', ${redriven}, '2026-01-01 00:00:${String(i % 60).padStart(2, '0')}')`,
      );
    }
    await ds.query(
      `INSERT INTO "integration_delivery_failures" ("id","direction","pluginId","instanceId","sessionId","deliveryId","attempts","lastError","redriven","createdAt") VALUES ${intRows.join(',')}`,
    );
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const indexNames = async (table: string): Promise<string[]> => {
    const rows = await ds.query<{ name: string }[]>(`PRAGMA index_list("${table}")`);
    return rows.map(r => r.name);
  };

  const explain = async (sql: string, params: unknown[] = []): Promise<string> => {
    const rows = await ds.query<{ detail: string }[]>(`EXPLAIN QUERY PLAN ${sql}`, params);
    return rows.map(r => r.detail).join(' | ');
  };

  it('creates all ten indexes across the four tables, is idempotent, and down() drops them all', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddHighVolumeQueryIndexes1791900000000();
    try {
      await migration.up(runner);
      await expect(migration.up(runner)).resolves.toBeUndefined();

      for (const [table, expected] of Object.entries(EXPECTED_INDEXES)) {
        const present = await indexNames(table);
        for (const name of expected) {
          expect(present).toContain(name);
        }
      }

      await migration.down(runner);
      for (const [table, expected] of Object.entries(EXPECTED_INDEXES)) {
        const present = await indexNames(table);
        for (const name of expected) {
          expect(present).not.toContain(name);
        }
      }
    } finally {
      await runner.release();
    }
  });

  it('skips missing tables cleanly when up() runs on an empty database', async () => {
    const emptyDs = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await emptyDs.initialize();
    const runner = emptyDs.createQueryRunner();
    try {
      await expect(new AddHighVolumeQueryIndexes1791900000000().up(runner)).resolves.toBeUndefined();
      await expect(new AddHighVolumeQueryIndexes1791900000000().down(runner)).resolves.toBeUndefined();
    } finally {
      await runner.release();
      await emptyDs.destroy();
    }
  });

  it('lifts statement_timeout inside the transaction on PostgreSQL', async () => {
    const queries: string[] = [];
    const runner = {
      dataSource: { options: { type: 'postgres' } },
      hasTable: jest.fn().mockResolvedValue(true),
      query: jest.fn((sql: string) => {
        queries.push(sql);
        return Promise.resolve();
      }),
    };

    await new AddHighVolumeQueryIndexes1791900000000().up(runner as never);

    expect(queries[0]).toBe('SET LOCAL statement_timeout = 0');
    expect(queries.filter(q => q.startsWith('CREATE INDEX IF NOT EXISTS'))).toHaveLength(10);
  });

  it('serves high-volume message, webhook failure, batch, and integration failure queries from the new indexes', async () => {
    // Baseline checks before up(): retention prune and recovery queries scan without the new indexes.
    expect(
      await explain(`SELECT "id" FROM "webhook_delivery_failures" WHERE "createdAt" < ? LIMIT 500`, [
        '2026-01-01 00:00:30',
      ]),
    ).toContain('SCAN webhook_delivery_failures');
    expect(
      await explain(`SELECT "id", "session_id" FROM "message_batches" WHERE "status" IN (?, ?)`, [
        'pending',
        'processing',
      ]),
    ).toContain('SCAN message_batches');
    expect(await explain(`SELECT "id" FROM "integration_delivery_failures" WHERE "sessionId" = ?`, ['s1'])).toContain(
      'SCAN integration_delivery_failures',
    );

    const runner = ds.createQueryRunner();
    try {
      await new AddHighVolumeQueryIndexes1791900000000().up(runner);
    } finally {
      await runner.release();
    }

    // messages: per-session status count
    const msgSessionStatus = await explain(`SELECT COUNT(*) FROM "messages" WHERE "sessionId" = ? AND "status" = ?`, [
      's1',
      'failed',
    ]);
    expect(msgSessionStatus).toContain('IDX_messages_sessionId_status');
    expect(msgSessionStatus).not.toContain('SCAN');

    // messages: send-pacing daily outgoing count
    const msgPacing = await explain(
      `SELECT COUNT(*) FROM "messages" WHERE "sessionId" = ? AND "direction" = ? AND "createdAt" >= ?`,
      ['s1', 'outgoing', '2026-01-01 00:00:00'],
    );
    expect(msgPacing).toContain('IDX_messages_sessionId_direction_createdAt');
    expect(msgPacing).not.toContain('SCAN');

    // messages: pending-message reaper scan ordered by createdAt
    const msgPendingReap = await explain(
      `SELECT "id" FROM "messages" WHERE "direction" = ? AND "status" = ? AND "createdAt" < ? ORDER BY "createdAt" ASC LIMIT 100`,
      ['outgoing', 'pending', '2026-01-01 00:00:30'],
    );
    expect(msgPendingReap).toContain('IDX_messages_status_createdAt');
    expect(msgPendingReap).not.toContain('USE TEMP B-TREE FOR ORDER BY');

    // webhook_delivery_failures: retention prune by createdAt
    const whPrune = await explain(`SELECT "id" FROM "webhook_delivery_failures" WHERE "createdAt" < ? LIMIT 500`, [
      '2026-01-01 00:00:30',
    ]);
    expect(whPrune).toContain('IDX_webhook_delivery_failures_createdAt');
    expect(whPrune).not.toContain('SCAN');

    // webhook_delivery_failures: session-scoped list ordered by createdAt DESC
    const whSessionList = await explain(
      `SELECT "id" FROM "webhook_delivery_failures" WHERE "sessionId" = ? ORDER BY "createdAt" DESC LIMIT 50`,
      ['s1'],
    );
    expect(whSessionList).toContain('IDX_webhook_delivery_failures_sessionId_createdAt');
    expect(whSessionList).not.toContain('USE TEMP B-TREE FOR ORDER BY');

    // message_batches: startup orphan recovery and retention prune
    const batchRecovery = await explain(`SELECT "id", "session_id" FROM "message_batches" WHERE "status" IN (?, ?)`, [
      'pending',
      'processing',
    ]);
    expect(batchRecovery).toContain('IDX_message_batches_status_created_at');
    expect(batchRecovery).not.toContain('SCAN');

    const batchPrune = await explain(
      `SELECT "id" FROM "message_batches" WHERE "status" IN (?, ?, ?) AND "created_at" < ? LIMIT 500`,
      ['completed', 'cancelled', 'failed', '2026-01-01 00:00:30'],
    );
    expect(batchPrune).toContain('IDX_message_batches_status_created_at');
    expect(batchPrune).not.toContain('SCAN');

    // message_batches: per-session unfinished batch reap
    const batchSessionReap = await explain(
      `SELECT "id" FROM "message_batches" WHERE "session_id" = ? AND "status" IN (?, ?)`,
      ['s1', 'pending', 'processing'],
    );
    expect(batchSessionReap).toContain('IDX_message_batches_session_id_status');
    expect(batchSessionReap).not.toContain('SCAN');

    // integration_delivery_failures: retention prune by createdAt
    const intPrune = await explain(`SELECT "id" FROM "integration_delivery_failures" WHERE "createdAt" < ? LIMIT 500`, [
      '2026-01-01 00:00:30',
    ]);
    expect(intPrune).toContain('IDX_integration_delivery_failures_createdAt');
    expect(intPrune).not.toContain('SCAN');

    // integration_delivery_failures: session deletion lookup
    const intSessionDelete = await explain(`SELECT "id" FROM "integration_delivery_failures" WHERE "sessionId" = ?`, [
      's1',
    ]);
    expect(intSessionDelete).toContain('IDX_integration_delivery_failures_sessionId');
    expect(intSessionDelete).not.toContain('SCAN');

    // integration_delivery_failures: redrive batch ordered by attempts ASC, createdAt ASC
    const intRedrive = await explain(
      `SELECT "id" FROM "integration_delivery_failures" WHERE "pluginId" = ? AND "instanceId" = ? AND "direction" = ? AND "redriven" = ? ORDER BY "attempts" ASC, "createdAt" ASC LIMIT 50`,
      ['plug', 'inst', 'inbound', 0],
    );
    expect(intRedrive).toContain('IDX_integration_delivery_failures_redrive');
    expect(intRedrive).not.toContain('USE TEMP B-TREE FOR ORDER BY');
  });
});
