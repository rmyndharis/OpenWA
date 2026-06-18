import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMessageStatus1770108659848 implements MigrationInterface {
  name = 'AddMessageStatus1770108659848';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Idempotency guard for the synchronize -> migrations adoption path. A DB whose schema was
    // created by `synchronize` has an empty migrations tracking table, so TypeORM tries to run this
    // baseline from scratch and collides on the already-existing tables ("table sessions already
    // exists"). If the schema is already present, skip the creates (TypeORM still records this
    // migration as applied). The webhooks CASCADE FK is declared on the entity, so a synchronize-built
    // schema already matches. Mirrors the hasTable guard in AddTemplates / AddBaileysStoredMessages.
    if (await queryRunner.hasTable('sessions')) {
      return;
    }

    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      await this.upPostgres(queryRunner);
    } else {
      await this.upSqlite(queryRunner);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      await this.downPostgres(queryRunner);
    } else {
      await this.downSqlite(queryRunner);
    }
  }

  // ──────────────────────────────────────────────
  //  SQLite (original, unchanged)
  // ──────────────────────────────────────────────

  private async upSqlite(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "sessions" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar(100) NOT NULL, "status" varchar(50) NOT NULL DEFAULT ('created'), "phone" varchar(20), "pushName" varchar(100), "config" text NOT NULL DEFAULT ('{}'), "proxyUrl" varchar(255), "proxyType" varchar(10), "connectedAt" datetime, "lastActiveAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_ac984ccbd8b01af155e1874e8cb" UNIQUE ("name"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "webhooks" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "url" varchar(2048) NOT NULL, "events" text NOT NULL DEFAULT ('["message.received"]'), "secret" varchar(255), "headers" text NOT NULL DEFAULT ('{}'), "active" boolean NOT NULL DEFAULT (1), "retryCount" integer NOT NULL DEFAULT (3), "lastTriggeredAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE TABLE "messages" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "waMessageId" varchar, "chatId" varchar NOT NULL, "from" varchar NOT NULL, "to" varchar NOT NULL, "body" text, "type" varchar NOT NULL DEFAULT ('text'), "direction" varchar NOT NULL DEFAULT ('outgoing'), "timestamp" bigint, "metadata" text, "status" varchar NOT NULL DEFAULT ('sent'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_066163c46cda7e8187f96bc87a" ON "messages" ("sessionId") `);
    await queryRunner.query(`CREATE INDEX "IDX_befd307485dbf0559d17e4a4d2" ON "messages" ("status") `);
    await queryRunner.query(`CREATE INDEX "IDX_36bc604c820bb9adc4c75cd411" ON "messages" ("chatId") `);
    await queryRunner.query(`CREATE INDEX "IDX_399833392126349ef0b04b9bed" ON "messages" ("sessionId", "createdAt") `);
    await queryRunner.query(
      `CREATE TABLE "message_batches" ("id" varchar PRIMARY KEY NOT NULL, "batch_id" varchar NOT NULL, "session_id" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "messages" text NOT NULL, "options" text, "progress" text, "results" text, "current_index" integer NOT NULL DEFAULT (0), "created_at" datetime NOT NULL DEFAULT (datetime('now')), "updated_at" datetime NOT NULL DEFAULT (datetime('now')), "started_at" datetime, "completed_at" datetime, CONSTRAINT "UQ_ff274470c0dbaff6c7d1f9795f5" UNIQUE ("batch_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "api_keys" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar(100) NOT NULL, "keyHash" varchar(64) NOT NULL, "keyPrefix" varchar(8) NOT NULL, "role" varchar(20) NOT NULL DEFAULT ('operator'), "allowedIps" text, "allowedSessions" text, "isActive" boolean NOT NULL DEFAULT (1), "expiresAt" datetime, "lastUsedAt" datetime, "usageCount" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_df3b25181df0b4b59bd93f16e1" ON "api_keys" ("keyHash") `);
    await queryRunner.query(
      `CREATE TABLE "audit_logs" ("id" varchar PRIMARY KEY NOT NULL, "action" varchar(50) NOT NULL, "severity" varchar(10) NOT NULL DEFAULT ('info'), "apiKeyId" varchar(36), "apiKeyName" varchar(100), "sessionId" varchar(36), "sessionName" varchar(100), "ipAddress" varchar(45), "userAgent" varchar(500), "method" varchar(10), "path" varchar(500), "statusCode" integer, "metadata" text, "errorMessage" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_cee5459245f652b75eb2759b4c" ON "audit_logs" ("action") `);
    await queryRunner.query(`CREATE INDEX "IDX_741fa976d1e04e695f3aa23cb8" ON "audit_logs" ("apiKeyId") `);
    await queryRunner.query(`CREATE INDEX "IDX_dd2b6e43c767b6b5b2bb227ace" ON "audit_logs" ("sessionId") `);
    await queryRunner.query(`CREATE INDEX "IDX_c69efb19bf127c97e6740ad530" ON "audit_logs" ("createdAt") `);
    await queryRunner.query(
      `CREATE TABLE "temporary_webhooks" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "url" varchar(2048) NOT NULL, "events" text NOT NULL DEFAULT ('["message.received"]'), "secret" varchar(255), "headers" text NOT NULL DEFAULT ('{}'), "active" boolean NOT NULL DEFAULT (1), "retryCount" integer NOT NULL DEFAULT (3), "lastTriggeredAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_d209715bb62b12255e825580af6" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `INSERT INTO "temporary_webhooks"("id", "sessionId", "url", "events", "secret", "headers", "active", "retryCount", "lastTriggeredAt", "createdAt", "updatedAt") SELECT "id", "sessionId", "url", "events", "secret", "headers", "active", "retryCount", "lastTriggeredAt", "createdAt", "updatedAt" FROM "webhooks"`,
    );
    await queryRunner.query(`DROP TABLE "webhooks"`);
    await queryRunner.query(`ALTER TABLE "temporary_webhooks" RENAME TO "webhooks"`);
  }

  private async downSqlite(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "webhooks" RENAME TO "temporary_webhooks"`);
    await queryRunner.query(
      `CREATE TABLE "webhooks" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "url" varchar(2048) NOT NULL, "events" text NOT NULL DEFAULT ('["message.received"]'), "secret" varchar(255), "headers" text NOT NULL DEFAULT ('{}'), "active" boolean NOT NULL DEFAULT (1), "retryCount" integer NOT NULL DEFAULT (3), "lastTriggeredAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `INSERT INTO "webhooks"("id", "sessionId", "url", "events", "secret", "headers", "active", "retryCount", "lastTriggeredAt", "createdAt", "updatedAt") SELECT "id", "sessionId", "url", "events", "secret", "headers", "active", "retryCount", "lastTriggeredAt", "createdAt", "updatedAt" FROM "temporary_webhooks"`,
    );
    await queryRunner.query(`DROP TABLE "temporary_webhooks"`);
    await queryRunner.query(`DROP INDEX "IDX_c69efb19bf127c97e6740ad530"`);
    await queryRunner.query(`DROP INDEX "IDX_dd2b6e43c767b6b5b2bb227ace"`);
    await queryRunner.query(`DROP INDEX "IDX_741fa976d1e04e695f3aa23cb8"`);
    await queryRunner.query(`DROP INDEX "IDX_cee5459245f652b75eb2759b4c"`);
    await queryRunner.query(`DROP TABLE "audit_logs"`);
    await queryRunner.query(`DROP INDEX "IDX_df3b25181df0b4b59bd93f16e1"`);
    await queryRunner.query(`DROP TABLE "api_keys"`);
    await queryRunner.query(`DROP TABLE "message_batches"`);
    await queryRunner.query(`DROP INDEX "IDX_399833392126349ef0b04b9bed"`);
    await queryRunner.query(`DROP INDEX "IDX_36bc604c820bb9adc4c75cd411"`);
    await queryRunner.query(`DROP INDEX "IDX_befd307485dbf0559d17e4a4d2"`);
    await queryRunner.query(`DROP INDEX "IDX_066163c46cda7e8187f96bc87a"`);
    await queryRunner.query(`DROP TABLE "messages"`);
    await queryRunner.query(`DROP TABLE "webhooks"`);
    await queryRunner.query(`DROP TABLE "sessions"`);
  }

  // ──────────────────────────────────────────────
  //  PostgreSQL
  // ──────────────────────────────────────────────

  private async upPostgres(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "sessions" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar(100) NOT NULL, "status" varchar(50) NOT NULL DEFAULT 'created', "phone" varchar(20), "pushName" varchar(100), "config" text NOT NULL DEFAULT '{}', "proxyUrl" varchar(255), "proxyType" varchar(10), "connectedAt" timestamp, "lastActiveAt" timestamp, "createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW(), CONSTRAINT "UQ_ac984ccbd8b01af155e1874e8cb" UNIQUE ("name"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "webhooks" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "url" varchar(2048) NOT NULL, "events" text NOT NULL DEFAULT '["message.received"]', "secret" varchar(255), "headers" text NOT NULL DEFAULT '{}', "active" boolean NOT NULL DEFAULT true, "retryCount" integer NOT NULL DEFAULT 3, "lastTriggeredAt" timestamp, "createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW(), CONSTRAINT "FK_d209715bb62b12255e825580af6" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE TABLE "messages" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "waMessageId" varchar, "chatId" varchar NOT NULL, "from" varchar NOT NULL, "to" varchar NOT NULL, "body" text, "type" varchar NOT NULL DEFAULT 'text', "direction" varchar NOT NULL DEFAULT 'outgoing', "timestamp" bigint, "metadata" text, "status" varchar NOT NULL DEFAULT 'sent', "createdAt" timestamp NOT NULL DEFAULT NOW())`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_066163c46cda7e8187f96bc87a" ON "messages" ("sessionId")`);
    await queryRunner.query(`CREATE INDEX "IDX_befd307485dbf0559d17e4a4d2" ON "messages" ("status")`);
    await queryRunner.query(`CREATE INDEX "IDX_36bc604c820bb9adc4c75cd411" ON "messages" ("chatId")`);
    await queryRunner.query(`CREATE INDEX "IDX_399833392126349ef0b04b9bed" ON "messages" ("sessionId", "createdAt")`);
    await queryRunner.query(
      `CREATE TABLE "message_batches" ("id" varchar PRIMARY KEY NOT NULL, "batch_id" varchar NOT NULL, "session_id" varchar NOT NULL, "status" varchar NOT NULL DEFAULT 'pending', "messages" text NOT NULL, "options" text, "progress" text, "results" text, "current_index" integer NOT NULL DEFAULT 0, "created_at" timestamp NOT NULL DEFAULT NOW(), "updated_at" timestamp NOT NULL DEFAULT NOW(), "started_at" timestamp, "completed_at" timestamp, CONSTRAINT "UQ_ff274470c0dbaff6c7d1f9795f5" UNIQUE ("batch_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "api_keys" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar(100) NOT NULL, "keyHash" varchar(64) NOT NULL, "keyPrefix" varchar(8) NOT NULL, "role" varchar(20) NOT NULL DEFAULT 'operator', "allowedIps" text, "allowedSessions" text, "isActive" boolean NOT NULL DEFAULT true, "expiresAt" timestamp, "lastUsedAt" timestamp, "usageCount" integer NOT NULL DEFAULT 0, "createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW())`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_df3b25181df0b4b59bd93f16e1" ON "api_keys" ("keyHash")`);
    await queryRunner.query(
      `CREATE TABLE "audit_logs" ("id" varchar PRIMARY KEY NOT NULL, "action" varchar(50) NOT NULL, "severity" varchar(10) NOT NULL DEFAULT 'info', "apiKeyId" varchar(36), "apiKeyName" varchar(100), "sessionId" varchar(36), "sessionName" varchar(100), "ipAddress" varchar(45), "userAgent" varchar(500), "method" varchar(10), "path" varchar(500), "statusCode" integer, "metadata" text, "errorMessage" text, "createdAt" timestamp NOT NULL DEFAULT NOW())`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_cee5459245f652b75eb2759b4c" ON "audit_logs" ("action")`);
    await queryRunner.query(`CREATE INDEX "IDX_741fa976d1e04e695f3aa23cb8" ON "audit_logs" ("apiKeyId")`);
    await queryRunner.query(`CREATE INDEX "IDX_dd2b6e43c767b6b5b2bb227ace" ON "audit_logs" ("sessionId")`);
    await queryRunner.query(`CREATE INDEX "IDX_c69efb19bf127c97e6740ad530" ON "audit_logs" ("createdAt")`);
  }

  private async downPostgres(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_c69efb19bf127c97e6740ad530"`);
    await queryRunner.query(`DROP INDEX "IDX_dd2b6e43c767b6b5b2bb227ace"`);
    await queryRunner.query(`DROP INDEX "IDX_741fa976d1e04e695f3aa23cb8"`);
    await queryRunner.query(`DROP INDEX "IDX_cee5459245f652b75eb2759b4c"`);
    await queryRunner.query(`DROP TABLE "audit_logs"`);
    await queryRunner.query(`DROP INDEX "IDX_df3b25181df0b4b59bd93f16e1"`);
    await queryRunner.query(`DROP TABLE "api_keys"`);
    await queryRunner.query(`DROP TABLE "message_batches"`);
    await queryRunner.query(`DROP INDEX "IDX_399833392126349ef0b04b9bed"`);
    await queryRunner.query(`DROP INDEX "IDX_36bc604c820bb9adc4c75cd411"`);
    await queryRunner.query(`DROP INDEX "IDX_befd307485dbf0559d17e4a4d2"`);
    await queryRunner.query(`DROP INDEX "IDX_066163c46cda7e8187f96bc87a"`);
    await queryRunner.query(`DROP TABLE "messages"`);
    await queryRunner.query(`DROP TABLE "webhooks"`);
    await queryRunner.query(`DROP TABLE "sessions"`);
  }
}
