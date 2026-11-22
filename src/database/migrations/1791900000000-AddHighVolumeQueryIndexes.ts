import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE_INDEXES: ReadonlyArray<{
  table: string;
  indexes: ReadonlyArray<readonly [name: string, columns: string]>;
}> = [
  {
    table: 'messages',
    indexes: [
      ['IDX_messages_sessionId_status', '"sessionId", "status"'],
      ['IDX_messages_sessionId_direction_createdAt', '"sessionId", "direction", "createdAt"'],
      ['IDX_messages_status_createdAt', '"status", "createdAt"'],
    ],
  },
  {
    table: 'webhook_delivery_failures',
    indexes: [
      ['IDX_webhook_delivery_failures_createdAt', '"createdAt"'],
      ['IDX_webhook_delivery_failures_sessionId_createdAt', '"sessionId", "createdAt"'],
    ],
  },
  {
    table: 'message_batches',
    indexes: [
      ['IDX_message_batches_status_created_at', '"status", "created_at"'],
      ['IDX_message_batches_session_id_status', '"session_id", "status"'],
    ],
  },
  {
    table: 'integration_delivery_failures',
    indexes: [
      ['IDX_integration_delivery_failures_createdAt', '"createdAt"'],
      ['IDX_integration_delivery_failures_sessionId', '"sessionId"'],
      ['IDX_integration_delivery_failures_redrive', '"pluginId", "instanceId", "redriven", "attempts", "createdAt"'],
    ],
  },
];

/**
 * Adds composite and retention indexes across `messages`, `webhook_delivery_failures`,
 * `message_batches`, and `integration_delivery_failures` for high-volume queries (pending-message
 * reaping, send-pacing daily counts, per-session status counts, delivery-failure pruning and
 * listing, batch recovery and pruning, session deletion, and ingress dead-letter redrive).
 *
 * Hand-authored because `synchronize` is off for the data connection on PostgreSQL (and optional on
 * SQLite). Explicit names match the entity `@Index` decorators so synchronize-built and
 * migration-built schemas converge on identical indexes across both dialects.
 */
export class AddHighVolumeQueryIndexes1791900000000 implements MigrationInterface {
  name = 'AddHighVolumeQueryIndexes1791900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type === 'postgres') {
      await queryRunner.query('SET LOCAL statement_timeout = 0');
    }
    for (const { table, indexes } of TABLE_INDEXES) {
      if (!(await queryRunner.hasTable(table))) continue;
      for (const [name, columns] of indexes) {
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "${name}" ON "${table}" (${columns})`);
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const { indexes } of TABLE_INDEXES) {
      for (const [name] of indexes) {
        await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
      }
    }
  }
}
