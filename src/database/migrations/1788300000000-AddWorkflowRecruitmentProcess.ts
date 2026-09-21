import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds the post-interview selection process without overloading record validity. */
export class AddWorkflowRecruitmentProcess1788300000000 implements MigrationInterface {
  name = 'AddWorkflowRecruitmentProcess1788300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('workflow_recruitment_applications')) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    const id = pg ? `varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar` : `varchar PRIMARY KEY NOT NULL`;
    const now = pg ? 'NOW()' : "(datetime('now'))";
    const created = pg ? `timestamp NOT NULL DEFAULT ${now}` : `datetime NOT NULL DEFAULT ${now}`;
    const date = pg ? 'timestamp' : 'text';

    await queryRunner.query(
      `CREATE TABLE "workflow_recruitment_applications" (` +
        `"id" ${id}, "instanceId" varchar NOT NULL, "contactId" varchar NOT NULL, "recordId" varchar, ` +
        `"appointmentId" varchar, "status" varchar NOT NULL DEFAULT 'ENTREVISTA_MARCADA', ` +
        `"owner" varchar, "rating" integer, "nextActionAt" ${date}, "version" integer NOT NULL, ` +
        `"createdAt" ${created}, "updatedAt" ${created}, ` +
        `CONSTRAINT "FK_workflow_recruitment_instance" FOREIGN KEY ("instanceId") REFERENCES "workflow_instances"("id") ON DELETE CASCADE, ` +
        `CONSTRAINT "FK_workflow_recruitment_record" FOREIGN KEY ("recordId") REFERENCES "workflow_records"("id") ON DELETE SET NULL, ` +
        `CONSTRAINT "FK_workflow_recruitment_appointment" FOREIGN KEY ("appointmentId") REFERENCES "workflow_appointments"("id") ON DELETE SET NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflow_recruitment_instance_contact" ON "workflow_recruitment_applications" ("instanceId", "contactId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workflow_recruitment_instance_status" ON "workflow_recruitment_applications" ("instanceId", "status")`,
    );
    await queryRunner.query(
      `CREATE TABLE "workflow_recruitment_events" (` +
        `"id" ${id}, "applicationId" varchar NOT NULL, "type" varchar(40) NOT NULL, ` +
        `"fromStatus" varchar, "toStatus" varchar, "actorId" varchar, "note" text, "createdAt" ${created}, ` +
        `CONSTRAINT "FK_workflow_recruitment_event_application" FOREIGN KEY ("applicationId") REFERENCES "workflow_recruitment_applications"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workflow_recruitment_event_application_created" ON "workflow_recruitment_events" ("applicationId", "createdAt")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "workflow_recruitment_events"');
    await queryRunner.query('DROP TABLE IF EXISTS "workflow_recruitment_applications"');
  }
}
