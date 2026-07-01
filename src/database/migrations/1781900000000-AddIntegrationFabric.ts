import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIntegrationFabric1781900000000 implements MigrationInterface {
  name = 'AddIntegrationFabric1781900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    const ts = isPostgres ? 'timestamp' : 'datetime';
    const now = isPostgres ? 'NOW()' : "(datetime('now'))";
    const boolTrue = isPostgres ? 'true' : '1';
    const boolFalse = isPostgres ? 'false' : '0';

    if (!(await queryRunner.hasTable('plugin_instances'))) {
      await queryRunner.query(
        `CREATE TABLE "plugin_instances" (` +
          `"id" varchar PRIMARY KEY NOT NULL, "pluginId" varchar NOT NULL, "instanceId" varchar NOT NULL, ` +
          `"sessionScope" varchar, "secret" varchar NOT NULL, "verifyToken" varchar, "config" text, ` +
          `"enabled" boolean NOT NULL DEFAULT ${boolTrue}, ` +
          `"createdAt" ${ts} NOT NULL DEFAULT ${now}, "updatedAt" ${ts} NOT NULL DEFAULT ${now})`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_plugin_instances_plugin_instance" ON "plugin_instances" ("pluginId", "instanceId")`,
      );
    }

    if (!(await queryRunner.hasTable('conversation_mappings'))) {
      await queryRunner.query(
        `CREATE TABLE "conversation_mappings" (` +
          `"id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "chatId" varchar NOT NULL, ` +
          `"pluginId" varchar NOT NULL, "instanceId" varchar NOT NULL, "providerConversationId" varchar NOT NULL, ` +
          `"handoverState" varchar NOT NULL DEFAULT 'bot', "metadata" text, ` +
          `"updatedAt" ${ts} NOT NULL DEFAULT ${now})`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_conversation_mappings_forward" ON "conversation_mappings" ("sessionId", "chatId", "pluginId", "instanceId")`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_conversation_mappings_reverse" ON "conversation_mappings" ("pluginId", "instanceId", "providerConversationId")`,
      );
    }

    if (!(await queryRunner.hasTable('ingress_events'))) {
      await queryRunner.query(
        `CREATE TABLE "ingress_events" (` +
          `"id" varchar PRIMARY KEY NOT NULL, "instanceId" varchar NOT NULL, "pluginId" varchar NOT NULL, ` +
          `"providerDeliveryId" varchar NOT NULL, "route" varchar NOT NULL, "payload" text NOT NULL, ` +
          `"sessionId" varchar, "createdAt" ${ts} NOT NULL DEFAULT ${now})`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_ingress_events_instance_delivery" ON "ingress_events" ("instanceId", "providerDeliveryId")`,
      );
      await queryRunner.query(`CREATE INDEX "IDX_ingress_events_createdAt" ON "ingress_events" ("createdAt")`);
    }

    if (!(await queryRunner.hasTable('integration_delivery_failures'))) {
      await queryRunner.query(
        `CREATE TABLE "integration_delivery_failures" (` +
          `"id" varchar PRIMARY KEY NOT NULL, "direction" varchar NOT NULL, "pluginId" varchar NOT NULL, ` +
          `"instanceId" varchar NOT NULL, "sessionId" varchar, "deliveryId" varchar, "attempts" integer NOT NULL, ` +
          `"lastError" text NOT NULL, "payload" text, "redriven" boolean NOT NULL DEFAULT ${boolFalse}, ` +
          `"createdAt" ${ts} NOT NULL DEFAULT ${now})`,
      );
      await queryRunner.query(
        `CREATE INDEX "IDX_integration_delivery_failures_instance" ON "integration_delivery_failures" ("pluginId", "instanceId")`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_integration_delivery_failures_instance"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ingress_events_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_ingress_events_instance_delivery"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_conversation_mappings_reverse"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_conversation_mappings_forward"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_plugin_instances_plugin_instance"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "integration_delivery_failures"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ingress_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "conversation_mappings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "plugin_instances"`);
  }
}
