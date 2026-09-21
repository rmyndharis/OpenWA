import { MigrationInterface, QueryRunner } from 'typeorm';

/** Persistent talent-pool workflow, deliberately portable between the supported SQLite/PostgreSQL data DBs. */
export class AddTalentPool1786500000000 implements MigrationInterface {
  name = 'AddTalentPool1786500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('talent_pool_settings')) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    const id = pg ? `varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar` : `varchar PRIMARY KEY NOT NULL`;
    const boolFalse = pg ? 'false' : '(0)';
    const now = pg ? 'NOW()' : "(datetime('now'))";
    const dateType = pg ? 'timestamp' : 'text';

    await queryRunner.query(
      `CREATE TABLE "talent_pool_settings" (` +
        `"id" ${id}, "sessionId" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT ${boolFalse}, ` +
        `"fields" text NOT NULL DEFAULT '[]', "registrationTimeoutMinutes" integer NOT NULL DEFAULT 30, ` +
        `"updateTimeoutMinutes" integer NOT NULL DEFAULT 30, "menuTimeoutMinutes" integer NOT NULL DEFAULT 30, ` +
        `"humanInactivityMinutes" integer NOT NULL DEFAULT 30, "humanGraceMinutes" integer NOT NULL DEFAULT 5, ` +
        `"queueName" varchar(100) NOT NULL DEFAULT 'RH', "messages" text NOT NULL DEFAULT '{}', ` +
        `"createdAt" ${pg ? 'timestamp' : 'datetime'} NOT NULL DEFAULT ${now}, ` +
        `"updatedAt" ${pg ? 'timestamp' : 'datetime'} NOT NULL DEFAULT ${now}, ` +
        `CONSTRAINT "FK_talent_settings_session" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_talent_pool_settings_session" ON "talent_pool_settings" ("sessionId")`,
    );

    await queryRunner.query(
      `CREATE TABLE "talent_candidates" (` +
        `"id" ${id}, "sessionId" varchar NOT NULL, "contactId" varchar NOT NULL, "phone" varchar, ` +
        `"status" varchar NOT NULL DEFAULT 'CADASTRO_VALIDO', "data" text NOT NULL DEFAULT '{}', ` +
        `"validUntil" ${dateType}, "createdAt" ${pg ? 'timestamp' : 'datetime'} NOT NULL DEFAULT ${now}, ` +
        `"updatedAt" ${pg ? 'timestamp' : 'datetime'} NOT NULL DEFAULT ${now}, ` +
        `CONSTRAINT "FK_talent_candidate_session" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_talent_candidates_session_contact" ON "talent_candidates" ("sessionId", "contactId")`,
    );

    await queryRunner.query(
      `CREATE TABLE "talent_flow_sessions" (` +
        `"id" ${id}, "sessionId" varchar NOT NULL, "contactId" varchar NOT NULL, "chatId" varchar NOT NULL, ` +
        `"candidateId" varchar, "state" varchar NOT NULL, "step" integer NOT NULL DEFAULT 0, ` +
        `"draft" text NOT NULL DEFAULT '{}', "lastMessageId" varchar, "deadlineAt" ${dateType} NOT NULL, ` +
        `"version" integer NOT NULL, "createdAt" ${pg ? 'timestamp' : 'datetime'} NOT NULL DEFAULT ${now}, ` +
        `"updatedAt" ${pg ? 'timestamp' : 'datetime'} NOT NULL DEFAULT ${now}, ` +
        `CONSTRAINT "FK_talent_flow_session" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE, ` +
        `CONSTRAINT "FK_talent_flow_candidate" FOREIGN KEY ("candidateId") REFERENCES "talent_candidates"("id") ON DELETE SET NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_talent_flow_session_contact" ON "talent_flow_sessions" ("sessionId", "contactId")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_talent_flow_deadline" ON "talent_flow_sessions" ("deadlineAt")`);

    await queryRunner.query(
      `CREATE TABLE "talent_tickets" (` +
        `"id" ${id}, "sessionId" varchar NOT NULL, "candidateId" varchar NOT NULL, "contactId" varchar NOT NULL, ` +
        `"chatId" varchar NOT NULL, "openKey" varchar, "status" varchar NOT NULL DEFAULT 'AGUARDANDO_ATENDENTE', ` +
        `"queueName" varchar(100) NOT NULL DEFAULT 'RH', "assigneeApiKeyId" varchar, ` +
        `"lastRelevantAt" ${dateType} NOT NULL, "nextActionAt" ${dateType} NOT NULL, ` +
        `"warnedAt" ${dateType}, "closedAt" ${dateType}, "closeReason" varchar, ` +
        `"version" integer NOT NULL, "createdAt" ${pg ? 'timestamp' : 'datetime'} NOT NULL DEFAULT ${now}, ` +
        `"updatedAt" ${pg ? 'timestamp' : 'datetime'} NOT NULL DEFAULT ${now}, ` +
        `CONSTRAINT "FK_talent_ticket_session" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE, ` +
        `CONSTRAINT "FK_talent_ticket_candidate" FOREIGN KEY ("candidateId") REFERENCES "talent_candidates"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_talent_tickets_open_key" ON "talent_tickets" ("openKey")`);
    await queryRunner.query(`CREATE INDEX "IDX_talent_tickets_due" ON "talent_tickets" ("status", "nextActionAt")`);

    await queryRunner.query(
      `CREATE TABLE "talent_ticket_events" (` +
        `"id" ${id}, "ticketId" varchar NOT NULL, "type" varchar NOT NULL, "actorId" varchar, "metadata" text, ` +
        `"createdAt" ${pg ? 'timestamp' : 'datetime'} NOT NULL DEFAULT ${now}, ` +
        `CONSTRAINT "FK_talent_event_ticket" FOREIGN KEY ("ticketId") REFERENCES "talent_tickets"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_talent_ticket_events_ticket_created" ON "talent_ticket_events" ("ticketId", "createdAt")`,
    );

    await queryRunner.query(
      `CREATE TABLE "talent_processed_messages" (` +
        `"id" ${id}, "sessionId" varchar NOT NULL, "waMessageId" varchar NOT NULL, ` +
        `"createdAt" ${pg ? 'timestamp' : 'datetime'} NOT NULL DEFAULT ${now}, ` +
        `CONSTRAINT "FK_talent_processed_session" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_talent_processed_session_message" ON "talent_processed_messages" ("sessionId", "waMessageId")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "talent_processed_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "talent_ticket_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "talent_tickets"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "talent_flow_sessions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "talent_candidates"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "talent_pool_settings"`);
  }
}
