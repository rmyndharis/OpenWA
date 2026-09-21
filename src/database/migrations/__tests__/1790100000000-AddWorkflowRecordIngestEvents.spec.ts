import { DataSource } from 'typeorm';
import { AddWorkflowRecordIngestEvents1790100000000 } from '../1790100000000-AddWorkflowRecordIngestEvents';

describe('AddWorkflowRecordIngestEvents1790100000000', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await dataSource.initialize();
    await dataSource.query('PRAGMA foreign_keys = ON');
    await dataSource.query('CREATE TABLE "workflow_instances" ("id" varchar PRIMARY KEY NOT NULL)');
    await dataSource.query('CREATE TABLE "workflow_records" ("id" varchar PRIMARY KEY NOT NULL)');
  });

  afterEach(async () => dataSource.destroy());

  it('repairs a partial table without losing its rows', async () => {
    const migration = new AddWorkflowRecordIngestEvents1790100000000();
    const runner = dataSource.createQueryRunner();
    await dataSource.query(`INSERT INTO "workflow_instances" ("id") VALUES ('flow-old')`);
    await dataSource.query(
      'CREATE TABLE "workflow_record_ingest_events" ("id" varchar PRIMARY KEY NOT NULL, "instanceId" varchar NOT NULL, "eventKey" varchar NOT NULL, "payloadHash" varchar NOT NULL, "contactId" varchar NOT NULL)',
    );
    await dataSource.query(
      `INSERT INTO "workflow_record_ingest_events" ("id", "instanceId", "eventKey", "payloadHash", "contactId") VALUES ('old', 'flow-old', 'old-key', 'old-hash', 'old-contact')`,
    );

    await migration.up(runner);

    const table = await runner.getTable('workflow_record_ingest_events');
    expect(table?.columns.map(column => column.name)).toEqual(
      expect.arrayContaining([
        'id',
        'instanceId',
        'eventKey',
        'payloadHash',
        'recordId',
        'versionNumber',
        'contactId',
        'createdAt',
        'updatedAt',
      ]),
    );
    expect(await dataSource.query(`SELECT "id" FROM "workflow_record_ingest_events"`)).toEqual([{ id: 'old' }]);
    await runner.release();
  });

  it('is incremental, enforces the scoped event key, and has an idempotent up/down', async () => {
    const migration = new AddWorkflowRecordIngestEvents1790100000000();
    const runner = dataSource.createQueryRunner();
    await migration.up(runner);
    await migration.up(runner);
    await dataSource.query(`INSERT INTO "workflow_instances" ("id") VALUES ('flow-1')`);
    await dataSource.query(
      `INSERT INTO "workflow_record_ingest_events"
       ("id", "instanceId", "eventKey", "payloadHash", "contactId")
       VALUES ('event-1', 'flow-1', 'key-1', 'hash-1', 'contact-1')`,
    );
    await expect(
      dataSource.query(
        `INSERT INTO "workflow_record_ingest_events"
         ("id", "instanceId", "eventKey", "payloadHash", "contactId")
         VALUES ('event-2', 'flow-1', 'key-1', 'hash-2', 'contact-2')`,
      ),
    ).rejects.toThrow();

    await migration.down(runner);
    await migration.down(runner);
    expect(await runner.hasTable('workflow_record_ingest_events')).toBe(false);
    await runner.release();
  });
});
