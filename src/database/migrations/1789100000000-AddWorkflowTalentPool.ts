import { MigrationInterface, QueryRunner } from 'typeorm';

/** Separates future-opportunity registrations from active recruitment applications. */
export class AddWorkflowTalentPool1789100000000 implements MigrationInterface {
  name = 'AddWorkflowTalentPool1789100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('workflow_talent_pool_entries')) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    const id = pg ? `varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar` : `varchar PRIMARY KEY NOT NULL`;
    const now = pg ? 'NOW()' : "(datetime('now'))";
    const created = pg ? `timestamp NOT NULL DEFAULT ${now}` : `datetime NOT NULL DEFAULT ${now}`;
    const date = pg ? 'timestamp' : 'text';

    await queryRunner.query(
      `CREATE TABLE "workflow_talent_pool_entries" (` +
        `"id" ${id}, "instanceId" varchar NOT NULL, "recordId" varchar NOT NULL, "contactId" varchar NOT NULL, ` +
        `"status" varchar NOT NULL DEFAULT 'DISPONIVEL', "owner" varchar, "convertedAt" ${date}, ` +
        `"version" integer NOT NULL DEFAULT 1, "createdAt" ${created}, "updatedAt" ${created}, ` +
        `CONSTRAINT "FK_workflow_talent_pool_instance" FOREIGN KEY ("instanceId") REFERENCES "workflow_instances"("id") ON DELETE CASCADE, ` +
        `CONSTRAINT "FK_workflow_talent_pool_record" FOREIGN KEY ("recordId") REFERENCES "workflow_records"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflow_talent_pool_record" ON "workflow_talent_pool_entries" ("recordId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workflow_talent_pool_instance_status" ON "workflow_talent_pool_entries" ("instanceId", "status")`,
    );
    await queryRunner.query(
      `CREATE TABLE "workflow_talent_pool_events" (` +
        `"id" ${id}, "entryId" varchar NOT NULL, "type" varchar(40) NOT NULL, "fromStatus" varchar, ` +
        `"toStatus" varchar, "actorId" varchar, "note" text, "createdAt" ${created}, ` +
        `CONSTRAINT "FK_workflow_talent_pool_event_entry" FOREIGN KEY ("entryId") REFERENCES "workflow_talent_pool_entries"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workflow_talent_pool_event_entry_created" ON "workflow_talent_pool_events" ("entryId", "createdAt")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "workflow_talent_pool_events"');
    await queryRunner.query('DROP TABLE IF EXISTS "workflow_talent_pool_entries"');
  }
}
