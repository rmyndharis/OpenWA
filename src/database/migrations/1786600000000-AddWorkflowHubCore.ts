import { MigrationInterface, QueryRunner } from 'typeorm';

/** Generic, multi-flow core used by the built-in Central de Fluxos plugin. */
export class AddWorkflowHubCore1786600000000 implements MigrationInterface {
  name = 'AddWorkflowHubCore1786600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('workflow_departments')) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    const id = pg ? `varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar` : `varchar PRIMARY KEY NOT NULL`;
    const boolTrue = pg ? 'true' : '(1)';
    const now = pg ? 'NOW()' : "(datetime('now'))";
    const created = pg ? `timestamp NOT NULL DEFAULT ${now}` : `datetime NOT NULL DEFAULT ${now}`;
    const date = pg ? 'timestamp' : 'text';

    await queryRunner.query(
      `CREATE TABLE "workflow_departments" (` +
        `"id" ${id}, "sessionId" varchar NOT NULL, "name" varchar(120) NOT NULL, ` +
        `"enabled" boolean NOT NULL DEFAULT ${boolTrue}, "menuTimeoutMinutes" integer NOT NULL DEFAULT 10, ` +
        `"schedule" text NOT NULL DEFAULT '{}', "timezone" varchar(80) NOT NULL DEFAULT 'America/Sao_Paulo', ` +
        `"createdAt" ${created}, "updatedAt" ${created}, ` +
        `CONSTRAINT "FK_workflow_department_session" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflow_department_session" ON "workflow_departments" ("sessionId")`,
    );

    await queryRunner.query(
      `CREATE TABLE "workflow_instances" (` +
        `"id" ${id}, "departmentId" varchar NOT NULL, "name" varchar(120) NOT NULL, "slug" varchar(100) NOT NULL, ` +
        `"description" varchar, "status" varchar NOT NULL DEFAULT 'RASCUNHO', "keywords" text NOT NULL DEFAULT '[]', ` +
        `"flowTimeoutMinutes" integer NOT NULL DEFAULT 30, "invalidAttemptLimit" integer NOT NULL DEFAULT 3, ` +
        `"humanInactivityMinutes" integer NOT NULL DEFAULT 30, "humanGraceMinutes" integer NOT NULL DEFAULT 5, ` +
        `"validityMonths" integer NOT NULL DEFAULT 12, "proactiveReminderDays" integer, "currentVersionId" varchar, ` +
        `"messages" text NOT NULL DEFAULT '{}', "createdAt" ${created}, "updatedAt" ${created}, ` +
        `CONSTRAINT "FK_workflow_instance_department" FOREIGN KEY ("departmentId") REFERENCES "workflow_departments"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflow_instance_department_slug" ON "workflow_instances" ("departmentId", "slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workflow_instance_department_status" ON "workflow_instances" ("departmentId", "status")`,
    );

    await queryRunner.query(
      `CREATE TABLE "workflow_versions" (` +
        `"id" ${id}, "instanceId" varchar NOT NULL, "versionNumber" integer NOT NULL, ` +
        `"status" varchar NOT NULL DEFAULT 'RASCUNHO', "fields" text NOT NULL DEFAULT '[]', ` +
        `"definition" text NOT NULL DEFAULT '{}', "publishedAt" ${date}, "createdAt" ${created}, "updatedAt" ${created}, ` +
        `CONSTRAINT "FK_workflow_version_instance" FOREIGN KEY ("instanceId") REFERENCES "workflow_instances"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflow_version_instance_number" ON "workflow_versions" ("instanceId", "versionNumber")`,
    );

    await queryRunner.query(
      `CREATE TABLE "workflow_runs" (` +
        `"id" ${id}, "departmentId" varchar NOT NULL, "instanceId" varchar, "versionId" varchar, ` +
        `"contactId" varchar NOT NULL, "chatId" varchar NOT NULL, "openKey" varchar, "state" varchar NOT NULL, ` +
        `"step" integer NOT NULL DEFAULT 0, "invalidAttempts" integer NOT NULL DEFAULT 0, ` +
        `"draft" text NOT NULL DEFAULT '{}', "context" text NOT NULL DEFAULT '{}', "deadlineAt" ${date} NOT NULL, ` +
        `"version" integer NOT NULL, "createdAt" ${created}, "updatedAt" ${created}, ` +
        `CONSTRAINT "FK_workflow_run_department" FOREIGN KEY ("departmentId") REFERENCES "workflow_departments"("id") ON DELETE CASCADE, ` +
        `CONSTRAINT "FK_workflow_run_instance" FOREIGN KEY ("instanceId") REFERENCES "workflow_instances"("id") ON DELETE SET NULL, ` +
        `CONSTRAINT "FK_workflow_run_version" FOREIGN KEY ("versionId") REFERENCES "workflow_versions"("id") ON DELETE SET NULL)`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_workflow_run_open_key" ON "workflow_runs" ("openKey")`);
    await queryRunner.query(`CREATE INDEX "IDX_workflow_run_deadline" ON "workflow_runs" ("state", "deadlineAt")`);

    await queryRunner.query(
      `CREATE TABLE "workflow_records" (` +
        `"id" ${id}, "instanceId" varchar NOT NULL, "contactId" varchar NOT NULL, "phone" varchar, ` +
        `"status" varchar NOT NULL DEFAULT 'CADASTRO_VALIDO', "data" text NOT NULL DEFAULT '{}', ` +
        `"currentVersion" integer NOT NULL DEFAULT 1, "validUntil" ${date} NOT NULL, ` +
        `"createdAt" ${created}, "updatedAt" ${created}, ` +
        `CONSTRAINT "FK_workflow_record_instance" FOREIGN KEY ("instanceId") REFERENCES "workflow_instances"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflow_record_instance_contact" ON "workflow_records" ("instanceId", "contactId")`,
    );

    await queryRunner.query(
      `CREATE TABLE "workflow_record_versions" (` +
        `"id" ${id}, "recordId" varchar NOT NULL, "versionNumber" integer NOT NULL, "data" text NOT NULL DEFAULT '{}', ` +
        `"source" varchar(40) NOT NULL, "actorId" varchar, "createdAt" ${created}, ` +
        `CONSTRAINT "FK_workflow_record_version_record" FOREIGN KEY ("recordId") REFERENCES "workflow_records"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflow_record_version" ON "workflow_record_versions" ("recordId", "versionNumber")`,
    );

    await queryRunner.query(
      `CREATE TABLE "workflow_consents" (` +
        `"id" ${id}, "recordId" varchar, "instanceId" varchar NOT NULL, "contactId" varchar NOT NULL, ` +
        `"text" text NOT NULL, "termsVersion" varchar(40) NOT NULL, "purpose" varchar(40) NOT NULL, ` +
        `"accepted" boolean NOT NULL DEFAULT ${boolTrue}, "createdAt" ${created}, ` +
        `CONSTRAINT "FK_workflow_consent_record" FOREIGN KEY ("recordId") REFERENCES "workflow_records"("id") ON DELETE CASCADE, ` +
        `CONSTRAINT "FK_workflow_consent_instance" FOREIGN KEY ("instanceId") REFERENCES "workflow_instances"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workflow_consent_record_created" ON "workflow_consents" ("recordId", "createdAt")`,
    );

    await queryRunner.query(
      `CREATE TABLE "workflow_deletion_requests" (` +
        `"id" ${id}, "recordId" varchar NOT NULL, "openKey" varchar, "status" varchar NOT NULL DEFAULT 'PENDENTE', ` +
        `"reason" varchar, "decidedBy" varchar, "decidedAt" ${date}, "createdAt" ${created}, "updatedAt" ${created}, ` +
        `CONSTRAINT "FK_workflow_deletion_record" FOREIGN KEY ("recordId") REFERENCES "workflow_records"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflow_deletion_open_key" ON "workflow_deletion_requests" ("openKey")`,
    );

    await queryRunner.query(
      `CREATE TABLE "workflow_appointment_slots" (` +
        `"id" ${id}, "instanceId" varchar NOT NULL, "startsAt" ${date} NOT NULL, "label" varchar, "location" varchar, ` +
        `"status" varchar NOT NULL DEFAULT 'DISPONIVEL', "heldByRunId" varchar, "holdUntil" ${date}, ` +
        `"version" integer NOT NULL, "createdAt" ${created}, "updatedAt" ${created}, ` +
        `CONSTRAINT "FK_workflow_slot_instance" FOREIGN KEY ("instanceId") REFERENCES "workflow_instances"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflow_slot_instance_start" ON "workflow_appointment_slots" ("instanceId", "startsAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workflow_slot_available" ON "workflow_appointment_slots" ("instanceId", "status", "startsAt")`,
    );

    await queryRunner.query(
      `CREATE TABLE "workflow_appointments" (` +
        `"id" ${id}, "slotId" varchar NOT NULL, "instanceId" varchar NOT NULL, "contactId" varchar NOT NULL, ` +
        `"recordId" varchar, "status" varchar NOT NULL DEFAULT 'CONFIRMADO', "cancelledAt" ${date}, ` +
        `"createdAt" ${created}, "updatedAt" ${created}, ` +
        `CONSTRAINT "FK_workflow_appointment_slot" FOREIGN KEY ("slotId") REFERENCES "workflow_appointment_slots"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_workflow_appointment_slot" ON "workflow_appointments" ("slotId")`);

    await queryRunner.query(
      `CREATE TABLE "workflow_outbox" (` +
        `"id" ${id}, "sessionId" varchar NOT NULL, "chatId" varchar NOT NULL, "body" text NOT NULL, ` +
        `"dedupeKey" varchar(160) NOT NULL, "status" varchar NOT NULL DEFAULT 'PENDENTE', ` +
        `"attempts" integer NOT NULL DEFAULT 0, "maxAttempts" integer NOT NULL DEFAULT 3, ` +
        `"nextAttemptAt" ${date} NOT NULL, "sentAt" ${date}, "lastError" text, "version" integer NOT NULL, ` +
        `"createdAt" ${created}, "updatedAt" ${created})`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_workflow_outbox_dedupe" ON "workflow_outbox" ("dedupeKey")`);
    await queryRunner.query(`CREATE INDEX "IDX_workflow_outbox_due" ON "workflow_outbox" ("status", "nextAttemptAt")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'workflow_outbox',
      'workflow_appointments',
      'workflow_appointment_slots',
      'workflow_deletion_requests',
      'workflow_consents',
      'workflow_record_versions',
      'workflow_records',
      'workflow_runs',
      'workflow_versions',
      'workflow_instances',
      'workflow_departments',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
    }
  }
}
