import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds persistent human support history and anonymous privacy audit events. */
export class AddWorkflowOperations1786700000000 implements MigrationInterface {
  name = 'AddWorkflowOperations1786700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const pg = queryRunner.dataSource.options.type === 'postgres';
    const id = pg ? `varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar` : `varchar PRIMARY KEY NOT NULL`;
    const now = pg ? 'NOW()' : "datetime('now')";
    const created = pg ? `timestamp NOT NULL DEFAULT ${now}` : `datetime NOT NULL DEFAULT (${now})`;
    const date = pg ? 'timestamp' : 'text';
    if (!(await queryRunner.hasColumn('workflow_instances', 'pdfMaxBytes')))
      await queryRunner.query(
        'ALTER TABLE "workflow_instances" ADD COLUMN "pdfMaxBytes" integer NOT NULL DEFAULT 10485760',
      );

    if (!(await queryRunner.hasTable('workflow_tickets'))) {
      await queryRunner.query(
        `CREATE TABLE "workflow_tickets" (` +
          `"id" ${id}, "departmentId" varchar NOT NULL, "instanceId" varchar NOT NULL, "runId" varchar NOT NULL, ` +
          `"contactId" varchar NOT NULL, "chatId" varchar NOT NULL, "openKey" varchar, ` +
          `"status" varchar NOT NULL DEFAULT 'AGUARDANDO_ATENDENTE', "lastRelevantAt" ${date} NOT NULL, ` +
          `"deadlineAt" ${date} NOT NULL, "warningSentAt" ${date}, "closedAt" ${date}, "closeReason" varchar, ` +
          `"version" integer NOT NULL DEFAULT 1, "createdAt" ${created}, "updatedAt" ${created}, ` +
          `CONSTRAINT "FK_workflow_ticket_department" FOREIGN KEY ("departmentId") REFERENCES "workflow_departments"("id") ON DELETE CASCADE, ` +
          `CONSTRAINT "FK_workflow_ticket_instance" FOREIGN KEY ("instanceId") REFERENCES "workflow_instances"("id") ON DELETE CASCADE, ` +
          `CONSTRAINT "FK_workflow_ticket_run" FOREIGN KEY ("runId") REFERENCES "workflow_runs"("id") ON DELETE CASCADE)`,
      );
      await queryRunner.query(`CREATE UNIQUE INDEX "UQ_workflow_ticket_open_key" ON "workflow_tickets" ("openKey")`);
      await queryRunner.query(
        `CREATE INDEX "IDX_workflow_ticket_deadline" ON "workflow_tickets" ("status", "deadlineAt")`,
      );
    }

    if (!(await queryRunner.hasTable('workflow_ticket_events'))) {
      await queryRunner.query(
        `CREATE TABLE "workflow_ticket_events" (` +
          `"id" ${id}, "ticketId" varchar NOT NULL, "type" varchar(80) NOT NULL, "actorId" varchar, ` +
          `"metadata" text NOT NULL DEFAULT '{}', "createdAt" ${created}, ` +
          `CONSTRAINT "FK_workflow_ticket_event_ticket" FOREIGN KEY ("ticketId") REFERENCES "workflow_tickets"("id") ON DELETE CASCADE)`,
      );
      await queryRunner.query(
        `CREATE INDEX "IDX_workflow_ticket_event_ticket_created" ON "workflow_ticket_events" ("ticketId", "createdAt")`,
      );
    }

    if (!(await queryRunner.hasTable('workflow_privacy_events'))) {
      await queryRunner.query(
        `CREATE TABLE "workflow_privacy_events" (` +
          `"id" ${id}, "instanceId" varchar NOT NULL, "type" varchar(80) NOT NULL, ` +
          `"anonymousSubjectHash" varchar(64) NOT NULL, "actorId" varchar, "metadata" text NOT NULL DEFAULT '{}', ` +
          `"createdAt" ${created})`,
      );
      await queryRunner.query(
        `CREATE INDEX "IDX_workflow_privacy_event_instance_created" ON "workflow_privacy_events" ("instanceId", "createdAt")`,
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "workflow_privacy_events"');
    await queryRunner.query('DROP TABLE IF EXISTS "workflow_ticket_events"');
    await queryRunner.query('DROP TABLE IF EXISTS "workflow_tickets"');
    if (await queryRunner.hasColumn('workflow_instances', 'pdfMaxBytes'))
      await queryRunner.query('ALTER TABLE "workflow_instances" DROP COLUMN "pdfMaxBytes"');
  }
}
