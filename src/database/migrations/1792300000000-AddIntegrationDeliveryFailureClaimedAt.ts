import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `integration_delivery_failures.claimedAt`, the time a redrive took the row for its dispatch, cleared when it
 * retires the row or puts it back. Another redrive leaves a taken row alone, and takes it again once the take is five
 * minutes old: its node stopped, or the database refused the write that settles it. Existing rows keep null, which
 * reads as not taken. The type is the entity's (`timestamp` on PostgreSQL, `text` on SQLite). Hand-authored because
 * `synchronize` is off on the `data` connection for PostgreSQL; the `hasColumn` guard keeps it idempotent where
 * synchronize already added the column.
 */
export class AddIntegrationDeliveryFailureClaimedAt1792300000000 implements MigrationInterface {
  name = 'AddIntegrationDeliveryFailureClaimedAt1792300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasTable('integration_delivery_failures')) ||
      (await queryRunner.hasColumn('integration_delivery_failures', 'claimedAt'))
    ) {
      return;
    }
    const type = queryRunner.connection.options.type === 'postgres' ? 'timestamp' : 'text';
    await queryRunner.query(`ALTER TABLE "integration_delivery_failures" ADD COLUMN "claimedAt" ${type}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('integration_delivery_failures', 'claimedAt'))) return;
    // A row a redrive holds then reads as redrivable, as every row did before the column.
    await queryRunner.query(`ALTER TABLE "integration_delivery_failures" DROP COLUMN "claimedAt"`);
  }
}
