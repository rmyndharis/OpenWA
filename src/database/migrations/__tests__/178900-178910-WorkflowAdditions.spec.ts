import { DataSource, QueryRunner } from 'typeorm';
import { AddWorkflowHumanServiceEnabled1789000000000 } from '../1789000000000-AddWorkflowHumanServiceEnabled';
import { AddWorkflowTalentPool1789100000000 } from '../1789100000000-AddWorkflowTalentPool';

describe('workflow additive migrations', () => {
  let dataSource: DataSource;
  let runner: QueryRunner;

  beforeEach(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await dataSource.initialize();
    runner = dataSource.createQueryRunner();
  });

  afterEach(async () => {
    await runner.release();
    await dataSource.destroy();
  });

  describe('178900 human service availability', () => {
    const migration = new AddWorkflowHumanServiceEnabled1789000000000();

    it('fails before being marked applied when the parent table is absent, then adds, reruns, and removes the column', async () => {
      await expect(migration.up(runner)).rejects.toThrow('requires workflow_departments');
      await runner.query('CREATE TABLE "workflow_departments" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar)');
      await runner.query(`INSERT INTO "workflow_departments" ("id", "name") VALUES ('department-1', 'People')`);

      await migration.up(runner);
      await expect(migration.up(runner)).resolves.not.toThrow();
      expect(await runner.hasColumn('workflow_departments', 'humanServiceEnabled')).toBe(true);
      expect(await runner.query(`SELECT "name", "humanServiceEnabled" FROM "workflow_departments"`)).toEqual([
        { name: 'People', humanServiceEnabled: 1 },
      ]);

      await migration.down(runner);
      await expect(migration.down(runner)).resolves.not.toThrow();
      expect(await runner.hasColumn('workflow_departments', 'humanServiceEnabled')).toBe(false);
      expect(await runner.query(`SELECT "name" FROM "workflow_departments"`)).toEqual([{ name: 'People' }]);
    });
  });

  describe('178910 talent pool', () => {
    const migration = new AddWorkflowTalentPool1789100000000();

    async function createParents() {
      await runner.query('CREATE TABLE "workflow_instances" ("id" varchar PRIMARY KEY NOT NULL)');
      await runner.query('CREATE TABLE "workflow_records" ("id" varchar PRIMARY KEY NOT NULL)');
      await runner.query(`INSERT INTO "workflow_instances" ("id") VALUES ('instance-1')`);
      await runner.query(`INSERT INTO "workflow_records" ("id") VALUES ('record-1')`);
    }

    it('fails before being marked applied until parents exist, then supports up/rerun/down/rerun', async () => {
      await expect(migration.up(runner)).rejects.toThrow('requires workflow_instances and workflow_records');
      expect(await runner.hasTable('workflow_talent_pool_entries')).toBe(false);
      await createParents();

      await migration.up(runner);
      await expect(migration.up(runner)).resolves.not.toThrow();
      expect(await runner.hasTable('workflow_talent_pool_entries')).toBe(true);
      expect(await runner.hasTable('workflow_talent_pool_events')).toBe(true);

      await migration.down(runner);
      await expect(migration.down(runner)).resolves.not.toThrow();
      expect(await runner.hasTable('workflow_talent_pool_entries')).toBe(false);
      await expect(migration.up(runner)).resolves.not.toThrow();
    });

    it('repairs a partial entries table and preserves existing data', async () => {
      await createParents();
      await runner.query(
        'CREATE TABLE "workflow_talent_pool_entries" (' +
          '"id" varchar PRIMARY KEY NOT NULL, "instanceId" varchar NOT NULL, "recordId" varchar NOT NULL, ' +
          '"contactId" varchar NOT NULL, "status" varchar NOT NULL, "owner" varchar, "convertedAt" datetime, ' +
          '"version" integer NOT NULL, "createdAt" datetime NOT NULL, "updatedAt" datetime NOT NULL)',
      );
      await runner.query(
        `INSERT INTO "workflow_talent_pool_entries" VALUES (` +
          `'entry-1', 'instance-1', 'record-1', '5511999990000@c.us', 'DISPONIVEL', NULL, NULL, 1, ` +
          `datetime('now'), datetime('now'))`,
      );

      await migration.up(runner);
      const table = await runner.getTable('workflow_talent_pool_entries');
      expect(table?.indices.map(index => index.name)).toEqual(
        expect.arrayContaining(['UQ_workflow_talent_pool_record', 'IDX_workflow_talent_pool_instance_status']),
      );
      expect(table?.foreignKeys.map(foreignKey => foreignKey.name)).toEqual(
        expect.arrayContaining(['FK_workflow_talent_pool_instance', 'FK_workflow_talent_pool_record']),
      );
      expect(await runner.query(`SELECT "id", "contactId" FROM "workflow_talent_pool_entries"`)).toEqual([
        { id: 'entry-1', contactId: '5511999990000@c.us' },
      ]);
    });

    it('adds a missing required column as nullable and fails without losing existing rows', async () => {
      await createParents();
      await runner.query(
        'CREATE TABLE "workflow_talent_pool_entries" (' +
          '"id" varchar PRIMARY KEY NOT NULL, "instanceId" varchar NOT NULL, "recordId" varchar NOT NULL)',
      );
      await runner.query(`INSERT INTO "workflow_talent_pool_entries" VALUES ('entry-1', 'instance-1', 'record-1')`);

      await expect(migration.up(runner)).rejects.toThrow('contactId is required');
      const table = await runner.getTable('workflow_talent_pool_entries');
      expect(table?.findColumnByName('contactId')?.isNullable).toBe(true);
      expect(await runner.query(`SELECT "id", "contactId" FROM "workflow_talent_pool_entries"`)).toEqual([
        { id: 'entry-1', contactId: null },
      ]);
    });

    it('replaces a homonymous index with the expected complete definition', async () => {
      await createParents();
      await migration.up(runner);
      await runner.query('DROP INDEX "UQ_workflow_talent_pool_record"');
      await runner.query('CREATE INDEX "UQ_workflow_talent_pool_record" ON "workflow_talent_pool_entries" ("status")');

      await migration.up(runner);
      const table = await runner.getTable('workflow_talent_pool_entries');
      const repaired = table?.indices.find(index => index.name === 'UQ_workflow_talent_pool_record');
      expect(repaired?.isUnique).toBe(true);
      expect(repaired?.columnNames).toEqual(['recordId']);
    });

    it('fails explicitly and preserves an events table that exists without entries', async () => {
      await createParents();
      await runner.query('CREATE TABLE "workflow_talent_pool_events" ("id" varchar PRIMARY KEY NOT NULL)');

      await expect(migration.up(runner)).rejects.toThrow('exists without workflow_talent_pool_entries');
      expect(await runner.hasTable('workflow_talent_pool_events')).toBe(true);
      expect(await runner.hasTable('workflow_talent_pool_entries')).toBe(false);
    });

    it('fails explicitly when an existing entries table has no primary key', async () => {
      await createParents();
      await runner.query('CREATE TABLE "workflow_talent_pool_entries" ("id" varchar NOT NULL)');

      await expect(migration.up(runner)).rejects.toThrow('has no primary key');
      expect(await runner.hasTable('workflow_talent_pool_entries')).toBe(true);
    });
  });
});
